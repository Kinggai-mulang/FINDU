"""PE/ELF validation and atomic engine replacement without executing fixture binaries."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('engine_bundle', Path(__file__).resolve().parents[1] / 'scripts/engine-bundle.py')
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)
runtime_spec = importlib.util.spec_from_file_location('linux_runtime', Path(__file__).resolve().parents[1] / 'scripts/prepare-linux-runtime.py')
runtime = importlib.util.module_from_spec(runtime_spec)
runtime_spec.loader.exec_module(runtime)


class Bundles(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def candidate(self, platform, name='candidate'):
        folder = self.root / name
        folder.mkdir()
        data = bytearray(70)
        if platform == 'windows-x64':
            data[:2] = b'MZ'
            struct.pack_into('<I', data, 60, 64)
            data[64:] = b'PE\0\0\x64\x86'
        else:
            data[:6] = b'\x7fELF\x02\x01'
            struct.pack_into('<H', data, 18, 62)
        for binary in bundle.PLATFORMS[platform]:
            (folder / binary).write_bytes(data)
            (folder / binary).chmod(0o755)
        digest = hashlib.sha256(data).hexdigest()
        manifest = dict(platform=platform, build_id=name, ipspos_version='test',
                        source_sha256='0' * 64, protocols=bundle.PROTOCOLS,
                        solver_sha256=digest, client_sha256=digest)
        (folder / 'manifest.json').write_text(json.dumps(manifest))
        return folder

    def test_native_headers_and_hashes(self):
        for platform in bundle.PLATFORMS:
            folder = self.candidate(platform, platform)
            self.assertEqual(bundle.check(folder)['platform'], platform)
            binary = folder / bundle.PLATFORMS[platform][0]
            binary.write_bytes(b'corrupt')
            with self.assertRaises(ValueError):
                bundle.check(folder)

    def test_runtime_links_stay_inside_the_archive(self):
        safe = tarfile.TarInfo('python/share/terminfo/1/1178')
        safe.type = tarfile.SYMTYPE
        safe.linkname = '../a/adm1178'
        self.assertEqual(runtime.runtime_member(safe, self.root).linkname, safe.linkname)
        safe.linkname = '../../../../../../outside'
        with self.assertRaises(ValueError):
            runtime.runtime_member(safe, self.root)
        bad = tarfile.TarInfo('../outside')
        with self.assertRaises(ValueError):
            runtime.runtime_member(bad, self.root)

    def test_linux_install_retains_backup_and_platform_guard(self):
        app = self.root / 'app'
        app.mkdir()
        (app / 'FINDU').write_bytes(b'application')
        info = dict(platform='linux-x64', sha256=bundle.sha(app / 'FINDU'))
        (app / 'build-info.json').write_text(json.dumps(info))
        first = self.candidate('linux-x64', 'first')
        second = self.candidate('linux-x64', 'second')
        self.assertTrue(bundle.install(first, app)['changed'])
        result = bundle.install(second, app)
        self.assertEqual(bundle.check(Path(result['backup']) / 'engine')['build_id'], 'first')
        self.assertEqual(bundle.check(app / 'engine')['build_id'], 'second')
        self.assertFalse(bundle.install(second, app)['changed'])
        info['platform'] = 'windows-x64'
        (app / 'build-info.json').write_text(json.dumps(info))
        with self.assertRaises(ValueError):
            bundle.install(first, app)


if __name__ == '__main__':
    unittest.main()
