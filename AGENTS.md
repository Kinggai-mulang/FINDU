# FINDU — guide for AI maintainers

FINDU is the Windows desktop front end (Tauri 2 + React 19 + Ant Design 6 + ECharts 6) for the IPSPOS GNSS engine.
It runs `IPSPOS.exe` (post-processing) and `IPSClient.exe` (realtime) as separate processes and reads their
Log=4 / StatusLog=1 output. IPSPOS algorithm source is **not** in this repository; `resources/engine` holds only
binaries plus `manifest.json` (see `docs/ENGINE-UPDATE.md`).

## Commands

```powershell
pnpm install --frozen-lockfile
pnpm verify                 # tsc + eslint + prettier --check + vitest — run before every commit
pnpm format                 # Prettier (frontend); `cargo fmt` in src-tauri for Rust
cargo test --manifest-path src-tauri/Cargo.toml --bin findyou
pnpm desktop:dev            # desktop app with the real engine
pnpm dev                    # browser preview only (no engine); then `pnpm test:ui`
pnpm desktop:package        # deliverables/FINDU-<version>-windows-x64 (needs docs/RELEASE-<v>.md, VALIDATION-<v>.md)
```

If `node`/`pnpm` are not on PATH on the maintainer's machine, a Node 24 runtime with pnpm 11.25 lives under
`%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies` (`node\bin`, `bin\fallback\pnpm.cmd`).

## Layout

| Path | Role |
|---|---|
| `contracts/` | TypeScript wire types shared with Rust (`index.ts`), capacity limits (`capacity.json`). |
| `src/App.tsx` | Shell only: navigation, layout, page switch. No data logic. |
| `src/services/native-engine.ts` | The single bridge to Rust. 1 Hz poll; `useEngine(selector)` for components. |
| `src/services/live-buffers.ts` | Client mirror of realtime buffers (incremental `realtime_deltas`). |
| `src/services/result-wire.ts` | Decodes binary analysis results (`import_analysis`, `open_analysis`, `native_result`) into rows. |
| `src/pages/` | One file per page; `pages/realtime/` holds monitor sub-views and formatting. |
| `src/components/Charts.tsx` | `Chart` (ECharts wrapper) and the ENU positioning chart. |
| `src/components/DiagnosticChart.tsx` | All Log=4 diagnostic time series (AR, atmosphere, residuals, …). |
| `src/components/decimate.ts` | Display-only thinning of long series. |
| `src/components/chart-theme.ts`, `src/theme.ts` | All colours and chart styling. Do not hard-code colours elsewhere. |
| `src/analysis.ts`, `src/diagnostics.ts` | Pure analysis/statistics; cached per input array. |
| `src-tauri/src/realtime.rs`, `live_hub.rs` | Realtime sessions, log tailing, buffers, `realtime_deltas`. |
| `src-tauri/src/ntrip.rs` | NTRIP source table and mountpoint probe for the realtime form (std sockets, credentials never logged). |
| `src-tauri/src/native.rs`, `results.rs` | Post-processing queue and Log=4 result parsing. |
| `src-tauri/src/table.rs`, `wire.rs` | Column storage of diagnostics; binary encoding of results for the page. |
| `src-tauri/src/gnss_log.rs` | The Log=4 contract (header, columns, missing markers). |
| `tests/*.test.ts` | Vitest unit tests. `tests/*.mjs` are desktop/browser scripts driven over CDP. |

## Invariants — do not break

- **Realtime stays realtime.** The monitor and live comparisons refresh every second. Realtime data travels as
  deltas: each Rust buffer has a running sequence number and a run `generation`; the client sends a cursor and gets
  only new rows (plus the last held row, because product rows can be replaced in place). Never go back to sending
  whole histories each poll. Rules are mirrored in `slice()` (realtime.rs) and `mergeSlice()` (live-buffers.ts) and
  tested on both sides.
- **Realtime buffers (≤ 3600 epochs) are never thinned.** `FULL_DETAIL_LIMIT` (6000) is above that on purpose.
  Long post-processing series are thinned for drawing only; statistics, events and exports always use every epoch.
  The analysis page offers 自动抽稀 / 全部历元 for long results.
- **Identity means "unchanged".** Engine snapshot slices, buffers, analysis inputs and thinned series keep their
  array/object identity until their content changes; memos, `useEngine` and caches (WeakMap keyed by arrays) rely
  on it. `useEngine` selectors must return a snapshot property, never a newly derived array.
- **Analysis results travel as binary columns**, never as JSON: a 47 h result is ~180 MiB of JSON. The format is
  documented in `wire.rs` and must stay lossless (bit-exact numbers, identical row keys and order). A format change
  updates `wire.rs` and `result-wire.ts` together and regenerates `tests/fixtures/result-wire.*` with
  `UPDATE_WIRE_FIXTURE=1 cargo test --bin findyou wire`. Decoding is time-sliced so the page never freezes.
- **Do not call `chart.getOption()` on hot paths**; it deep-copies all series data. Use `readZooms()` in Charts.tsx.
- **Session ownership:** a detail response is shown only if its session key and run id match the current selection
  (see `liveSelectionVersion` in native-engine.ts).
- Times are UTC everywhere (ISO strings on the wire, `Date.parse` once and cache). ENU in metres.
- Engine protocol: only Log=4 and StatusLog=1. A protocol or option-semantics change in IPSPOS needs an adapter
  update in `gnss_log.rs` / `options.rs` first.
- IPSPOS must not depend on FINDU. FINDU reads only general engine outputs; the two optional ones (PMode=0 decode
  summary, `IPSClient_SatelliteFile`) are declared by manifest `capabilities` (`CAPABILITIES` in
  `scripts/engine-bundle.py`). Never ask for IPSDLL changes for display needs; see `docs/ENGINE-UPDATE.md`.
- Capacities come from `contracts/capacity.json` (16 realtime runs, 6 compared results, 32 post-processing jobs).
- Credentials in realtime OPT files never go to logs, persistent storage or reports.

## Performance checks

`tests/perf-desktop.mjs` measures a running desktop copy (start it with
`$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9297'`):
realtime detail (1 × 3600), realtime comparison (6 × 3600, fixture over IPC) and a large post-processing analysis
(`--logs "a.log|b.log"`). `--profile 1` adds the top self-time functions; build with `FINDU_PROFILE_BUILD=1` to keep
function names. Results go to `runtime/perf/<label>.json`. Rust-side load cost (parse, encode, payload size) without
WebView: `cargo run --release --bin load-check -- <a.log> <b.log>`. Compare against the numbers in the latest
`docs/VALIDATION-*.md` after any change to the engine bridge, charts or analysis.

Large real inputs: `D:\05_Code\02_posrtk\IPSPOS\Data\TEST\POST\res` (Log=4 results, e.g. the 47 h, 1 Hz ALLOY
logs), realtime OPTs in `...\Data\TEST\RTIET`, post-processing OPTs in `...\Data\TEST\POST`.

## Conventions

- Prettier (120 columns) and rustfmt (110) own formatting; ESLint must report 0 problems.
- Comments explain *why* (constraints, protocol rules), not what the next line does.
- User-facing text is Chinese; code, comments and commit messages are English.
- Commit per logical step; keep pure formatting separate from behaviour changes.
