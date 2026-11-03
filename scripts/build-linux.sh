#!/usr/bin/env bash
set -euo pipefail
repository=$(realpath "${1:-.}")
build_root=$(realpath -m "${FINDU_LINUX_BUILD_ROOT:-$HOME/.cache/findu-build}")
source_dir="$build_root/source"
if [[ "$build_root" == / || "$source_dir" == "$repository" || -L "$source_dir" ]]; then
  echo 'Invalid isolated Linux build directory' >&2
  exit 1
fi
mkdir -p "$source_dir"
[[ "$(dirname "$(realpath "$source_dir")")" == "$build_root" ]]
# Keep Linux native dependencies and Rust outputs on its own filesystem.
rsync -a --delete --exclude .git --exclude runtime --exclude deliverables --exclude node_modules \
  --exclude src-tauri/target --exclude resources/product-runtime/ --exclude resources/product-runtime-linux/ "$repository/" "$source_dir/"
export PATH="$HOME/.cargo/bin:/opt/node/bin:$PATH"
if [[ -d "$repository/resources/product-runtime-linux" && ! -e "$source_dir/resources/product-runtime-linux/bin/python3" ]]; then
  rsync -a "$repository/resources/product-runtime-linux/" "$source_dir/resources/product-runtime-linux/"
fi
cd "$source_dir"
python3 scripts/prepare-linux-runtime.py
pnpm install --frozen-lockfile
pnpm desktop:package:native
node scripts/package-check.mjs "deliverables/FINDU-$(node -p 'require("./package.json").version')-linux-x64"
mkdir -p "$repository/deliverables"
# The archive preserves case-sensitive Python files and symlinks on a Windows host.
rsync -a --include='/*.tar.gz' --exclude='*' "deliverables/" "$repository/deliverables/"
