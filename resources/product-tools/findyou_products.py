"""FINDYOU product worker. Independent snapshot, no engine source access."""
import sys
sys.dont_write_bytecode = True
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import json, argparse, gzip, copy
from urllib.parse import urlsplit
import prepare as core
from transfer import Transfer
ROOT = Path(__file__).resolve().parent


def configure(policy):
    class PolicyTransfer(Transfer):
        def _get(self, task):
            task = dict(task)
            # Preserve local/cache matching names even when network access is forbidden.
            task['local_names'] = list(dict.fromkeys([*task.get('local_names', []), *[Path(urlsplit(u).path).name for u in task['urls']]]))
            if task['kind'] == 'atx':
                task['antenna_path'] = policy.get('antennaPath', '')
                # Existing queued plans may still contain only the old uncompressed URL.
                urls = []
                for url in task['urls']:
                    parsed = urlsplit(url)
                    if parsed.hostname == 'files.igs.org' and parsed.path in ('/pub/station/general/igs20.atx', '/pub/station/general/igs14.atx'):
                        base = 'https://files.igs.org' + parsed.path
                        urls.extend([base + '.gz', base])
                    else:
                        urls.append(url)
                task['urls'] = list(dict.fromkeys(urls))
                task['_version_urls'] = task['urls'][:]
                if policy.get('antennaPath'):
                    task['local_names'].insert(0, Path(policy['antennaPath']).name)
                if not policy['downloadAntenna']:
                    task['urls'] = []
            if not policy['switchSource'] and task['urls']:
                host = urlsplit(task['urls'][0]).hostname
                task['urls'] = [u for u in task['urls'] if urlsplit(u).hostname == host]
            result = super()._get(task)
            if task['kind'] == 'atx' and not policy['downloadAntenna'] and result['status'] != 'ok':
                result['status'] = 'antenna_missing'
                result.setdefault('errors', []).append({'status':'antenna_missing','message':'天线下载已关闭，未找到通过框架校验的本地 ANTEX；请指定匹配文件或创建允许下载的新任务。'})
            return result
    core.Transfer = PolicyTransfer
    core.provenance = lambda _: json.loads((ROOT/'provenance.json').read_text(encoding='utf-8'))


def rts_basic_result(result, folder):
    """Deliver usable orbit/clock configurations; keep incomplete optional products explicit."""
    manifest_file = folder/'manifest.json'
    manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
    transfers, tasks = manifest['transfers'], manifest['tasks']
    observation = manifest['observation']
    for row in manifest['results']:
        if row['status'] == 'ready':
            continue
        candidate = next((c for choice in manifest['choices'] for c in choice['candidates'] if c['id'] == row.get('bundle')), None)
        if not candidate:
            continue
        selected = [*manifest['common'], *candidate['tasks']]
        # Include the ANTEX selected after detecting the actual orbit frame.
        selected += [k for k in transfers if tasks[k]['kind'] == 'atx' and k not in selected]
        directory = folder/candidate['id']; directory.mkdir(exist_ok=True)
        files, meta = {}, {}
        warnings = list(row.get('check', {}).get('errors', []))
        warnings += [warning for key in selected for warning in transfers.get(key, {}).get('warnings', [])]
        for kind in ('sp3', 'clk', 'nav', 'bia', 'atx'):
            ids = [k for k in selected if tasks[k]['kind'] == kind]
            paths = [transfers[k]['path'] for k in ids if transfers.get(k, {}).get('status') == 'ok']
            failed = [k for k in ids if transfers.get(k, {}).get('status') != 'ok']
            if failed:
                warnings.append(kind + ' 未取得或未通过校验：' + ', '.join(k + ' (' + transfers.get(k, {}).get('status', '未取得') + ')' for k in failed))
            if not paths:
                continue
            try:
                target = directory/core.NAMES[kind]
                core.assemble(paths, target, kind)
                info = core.product_info(target, kind)
                if kind == 'atx' and core.frame_name(info['frame']) != core.frame_name(meta['sp3']['frame']):
                    warnings.append('ANTEX 与轨道框架不匹配，本次关闭天线改正')
                    continue
                files[kind], meta[kind] = target, info
            except (ValueError, OSError) as exc:
                warnings.append(kind + ' 校验失败：' + str(exc))
        if not all(k in files for k in ('sp3', 'clk')):
            continue
        common = set(meta['sp3']['satellites']) & set(meta['clk']['satellites']) & set(observation['satellites'])
        usable = [sv for sv in common if all(meta[k]['satellites'][sv]['first'] <= observation['end'] and meta[k]['satellites'][sv]['last'] >= observation['start'] for k in ('sp3', 'clk'))]
        if not usable:
            row['check'] = dict(ready=False, errors=['轨道和钟差没有共同覆盖观测时段的卫星'], warnings=warnings)
            continue
        qualified = core.check_bundle(meta, observation, manifest['settings']['systems'], manifest['settings']['mode'], manifest['settings']['antenna_model'], manifest['settings'].get('bias_time_system'))
        warnings += qualified.get('errors', []) + qualified.get('warnings', [])
        effective = copy.deepcopy(manifest)
        if not qualified['ready']:
            effective['settings']['mode'] = 'float'
            files.pop('bia', None)
            warnings.append('产品配套未通过完整校验，具体缺项或不匹配原因见上方；本次生成基础 PPP 浮点配置：GNSS_ARMode=0，该基础配置不接入 OSB；原请求方案保留在清单中。')
        if 'atx' not in files:
            warnings.append('天线配套不可用：GNSS_bUsePPPAntenna=OFF；本次结果不含该项改正。')
        if 'nav' not in files:
            warnings.append('广播星历未取得，GNSS_NaviFile 留空；可提交试算，可能无法形成有效定位。')
        warnings = list(dict.fromkeys(warnings))
        opt = core.write_opt(effective, directory, files)
        with Path(opt).open('a', encoding='utf-8') as stream:
            stream.write('\n# FINDU basic preparation; optional product failures retained below.\n')
            for warning in warnings:
                stream.write('# ' + warning.replace('\n', ' ') + '\n')
        row.update(status='ready', opt=opt, preparationLevel='basic', effectiveMode=effective['settings']['mode'], strictCheck=qualified,
                   check=dict(ready=True, scope='orbit-clock-only', errors=[], warnings=warnings), products={k:str(p) for k,p in files.items()}, next_action='deliver_config')
        core.dump(directory/'validation-basic.json', dict(check=row['check'], products=meta, requestedMode=manifest['settings']['mode'], effectiveMode=effective['settings']['mode']))
    manifest['ready'] = bool(manifest['results']) and all(r['status']=='ready' for r in manifest['results'])
    core.dump(manifest_file, manifest); core.summary_report(manifest)
    result.update(status='ready' if manifest['ready'] else 'incomplete', results=manifest['results'])
    return result

def run(request_file):
    request_file = Path(request_file).resolve()
    request = json.loads(request_file.read_text(encoding='utf-8-sig'))
    folder = request_file.parent/'work'; folder.mkdir(exist_ok=True)
    configure(request)
    roots = [request['localRoot']] if request.get('localRoot') else []
    if request.get('antennaPath'):
        antenna = Path(request['antennaPath'])
        # A missing optional antenna file is reported by the transfer, not a preflight blocker.
        if antenna.is_file(): roots.append(str(antenna.parent))
    args = argparse.Namespace(repo=str(ROOT), fast_root=str(ROOT/'ThirdParty/FAST'), observation=request['observation'],
        out=str(folder), centers=','.join(request['centers']), grade=request['grade'], mode=request['mode'], motion=request['motion'],
        systems=None, date=None, utc_offset=None, antenna_model=None, template=str(ROOT/'opt/IPSPOS.opt'),
        cache=request['cache'], local_root=roots, include_rts=False, orbit_margin=900, clock_margin=30,
        bias_time_system=None, offline=request['offline'], workers=request['workers'], timeout=request['timeout'], attempts=request['attempts'])
    plan_file = folder/'plan.json'
    if not plan_file.is_file():
        observation = Path(request['observation'])
        opener = gzip.open if observation.suffix.lower() == '.gz' else open
        with opener(observation, 'rb') as stream:
            header = stream.read(4096)
        if b'COMPACT RINEX FORMAT' in header:
            raise ValueError('Hatanaka 压缩观测需先转换为 RINEX O 文件')
        if b'RINEX VERSION / TYPE' not in header:
            raise ValueError('不是可识别的 RINEX O 观测文件，请检查文件格式')
        core.plan(args)
    args.plan = str(plan_file)
    result = core.fetch(args)
    result = rts_basic_result(result, folder)
    core.dump(request_file.parent/'outcome.json', result)
    return 0 if result['status'] == 'ready' else 3

if __name__ == '__main__':
    try:
        sys.exit(run(sys.argv[1]))
    except Exception as exc:
        print(json.dumps({'status':'error','message':str(exc)},ensure_ascii=False),file=sys.stderr,flush=True)
        sys.exit(2)
