"""The TEST maintenance helper must preserve unrelated OPT fields and credentials."""
import importlib.util
import json
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('update_test', Path(__file__).resolve().parents[1]/'scripts/update-test-products.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    opt = Path(directory)/'sample.opt'
    original = b'\xef\xbb\xbfGNSS_ATXFile = old.atx; # keep comment\r\nNTRIP_Password = test-secret;\r\n'
    opt.write_bytes(original)
    assert module.configure(opt, {'GNSS_ATXFile':'new.atx', 'GNSS_DCBFile':'new.bia'}) == ['GNSS_ATXFile','GNSS_DCBFile']
    result = opt.read_bytes()
    assert result.startswith(b'\xef\xbb\xbf') and b'\r\r\n' not in result
    assert b'NTRIP_Password = test-secret;\r\n' in result
    assert b'# keep comment\r\n' in result
    backup = (Path(directory)/'product-path-backups/sample.json').read_text()
    assert 'test-secret' not in backup
    assert json.loads(backup)['GNSS_ATXFile'] == 'old.atx'
    assert module.configure(opt, {'GNSS_ATXFile':'new.atx', 'GNSS_DCBFile':'new.bia'}) == []
print('Product path update: passed')
