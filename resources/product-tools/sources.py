"""Curated compatible bundles, using FAST's installed URL catalog/time expansion."""
import contextlib
import io
import json
import re
import shlex
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from observations import sha

# Prefix identifies the product series, not just its institution.
BUNDLES = {
    'WHU_FINAL': dict(center='WHU', grade='final', prefix='WUM0MGXFIN', types=['GCRE_WHU_F_sp3', 'GCRE_WHU_F_clk', 'GCRE_WHU_F_osb']),
    'WHU_RAPID': dict(center='WHU', grade='rapid', prefix='WUM0MGXRAP', types=['GCRE_WHU_R_sp3', 'GCRE_WHU_R_clk', 'GCRE_WHU_R_osb']),
    'WHU_ULTRA': dict(center='WHU', grade='ultra', prefix='WUM0MGXNRT', types=['GCRE_WHU_U_sp3', 'GCRE_WHU_U_clk_30s', 'GCRE_WHU_U_osb']),
    'WHU_RTS': dict(center='WHU', grade='rts', prefix='WUM0MGXRTS', types=['GCRE_WHU_RTS_sp3', 'GCRE_WHU_RTS_clk', 'GCRE_WHU_RTS_osb']),
    'COD_FINAL': dict(center='COD', grade='final', prefix='COD0MGXFIN', types=['GCRE_COD_F_sp3', 'GCRE_COD_F_clk', 'GCRE_COD_F_osb']),
    'COD_RAPID': dict(center='COD', grade='rapid', prefix='COD0OPSRAP', types=['GRE_COD_R_sp3', 'GRE_COD_R_clk', 'GRE_COD_R_osb']),
    'GFZ_FINAL': dict(center='GFZ', grade='final', prefix='GFZ0OPSFIN', types=['GRE_GFZ_F_sp3', 'GRE_GFZ_F_clk', None]),
    'GFZ_RAPID': dict(center='GFZ', grade='rapid', prefix='GBM0MGXRAP', types=['GCRE_GFZ_R_sp3', 'GCRE_GFZ_R_clk', 'GCRE_GFZ_R_osb']),
}
GRADE_NAMES = {'final': '最终', 'rapid': '快速', 'ultra': '超快速', 'rts': '实时归档'}
KINDS = ['sp3', 'clk', 'bia']


class Sources:
    def __init__(self, repo, root=None):
        self.root = Path(root or Path(repo) / 'ThirdParty/FAST').resolve()
        paths = [self.root / 'src/fast/bin/fast_download_src.json', self.root / 'src/bin/fast_download_src.json', self.root / 'src/win_bin/bin/fast_download_src.json']
        self.path = next((p for p in paths if p.is_file()), None)
        if self.path is None:
            raise ValueError('找不到 FAST 地址表；使用 --fast-root 指向本地 FAST 目录')
        self.table = json.loads(self.path.read_text(encoding='utf-8-sig'))
        sys.dont_write_bytecode = True
        sys.path.insert(0, str(self.root / 'src'))
        with contextlib.redirect_stdout(io.StringIO()):
            from fast.com.gnssTime import ReplaceTimeWildcard
        self.expand = ReplaceTimeWildcard
        self.version = dict(root=str(self.root), catalog=str(self.path), catalog_sha256=sha(self.path),
                            time_expander_sha256=sha(self.root / 'src/fast/com/gnssTime.py'),
                            extra_source_reference='https://github.com/PrideLab/PRIDE-PPPAR/blob/master/scripts/pdp3.sh')

    def urls(self, dtype, day, prefix=None):
        when = datetime.fromisoformat(day)
        urls = []
        for raw in self.table.get(dtype, []):
            # FAST embeds anonymous wget switches in some entries. Do not execute them.
            tokens = shlex.split(raw)
            token = next((s for s in reversed(tokens) if re.match(r'^(?:https?|ftps?)://', s)), None)
            if not token:
                continue
            with contextlib.redirect_stdout(io.StringIO()):
                expanded = self.expand(token, when)
            parsed = urlsplit(expanded)
            if '<' in expanded or '>' in expanded or parsed.username or parsed.password:
                continue
            name = Path(parsed.path).name
            legacy_cod = dtype.startswith('GRE_COD_R_') and re.fullmatch(r'COD\d{5}\.(?:EPH|CLK)_M\.Z', name)
            if prefix and not name.startswith(prefix + '_') and not legacy_cod:
                continue
            # Keep the protocol actually published by FAST; an FTP path is not proof of HTTPS service.
            urls.append(expanded)
        if dtype.startswith('GRE_COD_R_'):
            suffix = {'GRE_COD_R_sp3': '05M_ORB.SP3', 'GRE_COD_R_clk': '30S_CLK.CLK', 'GRE_COD_R_osb': '01D_OSB.BIA'}.get(dtype)
            if suffix:
                week = int((when - datetime(1980, 1, 6)).days // 7)
                name = f'COD0OPSRAP_{when:%Y%j}0000_01D_{suffix}.gz'
                urls.append(f'https://cddis.nasa.gov/archive/gnss/products/{week}/{name}')
        if '_WHU_R_' in dtype or '_WHU_RTS_' in dtype:
            week = (when - datetime(1980, 1, 6)).days // 7
            if week >= 2427:
                for u in list(urls):
                    name = Path(urlsplit(u).path).name
                    if name.startswith(('WUM0MGXRAP_', 'WUM0MGXRTS_')):
                        urls.append(f'ftps://bdspride.com/wum/{week}/{name}')
        # Domestic FTP first; transfer logic handles direct/proxy routing.
        urls.sort(key=lambda u: (0 if u.startswith('ftp://igs.gnsswhu.cn/') else 1 if u.startswith('https:') and 'cddis' not in u else 2 if u.startswith('ftps:') else 3))
        if dtype in ('MGEX_IGS20_atx', 'MGEX_IGS14_atx'):
            filename = 'igs20.atx' if dtype == 'MGEX_IGS20_atx' else 'igs14.atx'
            urls = [f'https://files.igs.org/pub/station/general/{filename}.gz',
                    f'https://files.igs.org/pub/station/general/{filename}']
        return list(dict.fromkeys(urls))

    def catalog(self):
        result = []
        for key, b in BUNDLES.items():
            present = [bool(t and t in self.table) for t in b['types']]
            result.append(dict(id=key, center=b['center'], grade=b['grade'], label=GRADE_NAMES[b['grade']],
                               precise_entry=all(present[:2]), phase_osb_entry=present[2], series=b['prefix'],
                               availability='目录入口；具体日期和信号覆盖在准备时验证',
                               note='最终系列无配套 OSB 入口，AR 模式跳过此系列' if key == 'GFZ_FINAL' else ''))
        return result
