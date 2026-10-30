"""Offline regression: optional DSB failure cannot invalidate a usable primary OPT."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'resources/product-tools'))
import optional_dcb
from atomic_io import dump


def dsb(first='2026:280:00000', last='2026:281:00000', kind='DSB'):
    lines=['%=BIA 1.00 test', ' TIME_SYSTEM'.ljust(40)+'GPS', '+BIAS/SOLUTION']
    for a,b in [('C1C','C1W'),('C2W','C2X')]:
        row=list(' '*125)
        for offset,width,value in [(1,3,kind),(11,3,'G01'),(25,4,a),(30,4,b),(35,14,first),(50,14,last),(65,4,'ns'),(70,21,'1.0'),(92,11,'0.1')]:
            row[offset:offset+width]=value.ljust(width)
        lines.append(''.join(row))
    return '\n'.join(lines+['-BIAS/SOLUTION','%=ENDBIA'])+'\n'


class OptionalProducts(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        (self.root/'work').mkdir();self.opt=self.root/'work/main.opt'
        self.original='GNSS_PMode = 2;\nGNSS_bUseDCB = OFF;\n'
        self.opt.write_text(self.original)
        self.obs=dict(start='2026-10-09T05:00:00',end='2026-10-09T06:00:00',observables={'G':['C1C','C2W']})
        dump(self.root/'work/plan.json',dict(observation=self.obs))
        dump(self.root/'work/manifest.json',dict(ready=True,results=[dict(status='ready',opt=str(self.opt))]))
        self.request=dict(observation=str(self.root/'sample.rtcm3'),cache=str(self.root/'cache'),offline=True)

    def tearDown(self):self.temp.cleanup()

    def run_optional(self):
        dump(self.root/'request.json',self.request)
        with patch.object(optional_dcb.subprocess,'run',side_effect=AssertionError('offline network')):
            self.assertEqual(optional_dcb.run(self.root/'request.json'),0)
        self.assertTrue(json.loads((self.root/'work/manifest.json').read_text())['ready'])
        return json.loads((self.root/'dcb.json').read_text(encoding='utf-8'))

    def test_missing_bad_expired_and_osb_keep_primary(self):
        p=self.root/'bad.bia';self.request['dcbPath']=str(p)
        for content in [None,'bad',dsb('2025:001:00000','2025:002:00000'),dsb(kind='OSB')]:
            if content is not None:p.write_text(content)
            self.assertEqual(self.run_optional()['status'],'unavailable')
            self.assertEqual(self.opt.read_text(),self.original)

    def test_local_then_cache_and_imported_copy_remains_unchanged(self):
        p=self.root/'valid.bia';p.write_text(dsb());self.request['dcbPath']=str(p)
        imported=self.opt.read_text()
        state=self.run_optional();self.assertEqual(state['origin'],'local')
        self.assertIn('GNSS_bUseDCB = ON;',self.opt.read_text())
        self.assertEqual(imported,self.original)
        p.unlink();self.request['dcbPath']=''
        self.assertEqual(self.run_optional()['origin'],'cache')

    def test_crossday_past_hold_is_not_accepted(self):
        p=self.root/'valid.bia';p.write_text(dsb())
        with self.assertRaises(ValueError):optional_dcb.qualify(p,{**self.obs,'end':'2026-11-01T00:00:00'})

    def test_timeout_is_optional_and_budgeted(self):
        dump(self.root/'request.json',{**self.request,'offline':False})
        import subprocess
        with patch.object(optional_dcb.time,'monotonic',side_effect=[0,0,0,46,46,46]),patch.object(optional_dcb.subprocess,'run',side_effect=subprocess.TimeoutExpired('curl',15)) as fetch:
            self.assertEqual(optional_dcb.run(self.root/'request.json'),0)
        self.assertLessEqual(fetch.call_count,1)
        self.assertEqual(self.opt.read_text(),self.original)
        self.assertTrue(json.loads((self.root/'work/manifest.json').read_text())['ready'])


if __name__=='__main__':unittest.main()
