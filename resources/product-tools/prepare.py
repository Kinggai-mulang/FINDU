"""Observation -> FAST product bundles -> validated IPSPOS configurations.

Python 3.10+, standard library only. Run inspect, plan, fetch or prepare --help.
"""
import argparse
import gzip
import shutil
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.dont_write_bytecode = True
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'):
        stream.reconfigure(encoding='utf-8')
from observations import inspect, sha, SYSTEMS
from sources import Sources, BUNDLES, GRADE_NAMES, KINDS
from transfer import Transfer
from atomic_io import dump, atomic_text
from products_io import assemble, check_bundle, product_info, frame_name

HERE = Path(__file__).resolve().parent
NAMES = dict(sp3='orbit.sp3', clk='clock.clk', bia='osb.bia', nav='brdc.rnx', atx='antenna.atx')




def resume_command(path):
    parts = [sys.executable, HERE / 'prepare.py', 'fetch', path]
    return '& ' + ' '.join("'" + str(part).replace("'", "''") + "'" for part in parts)


def root_path(value=None):
    if value:
        return Path(value).resolve()
    for parent in HERE.parents:
        if (parent / 'opt/IPSPOS.opt').is_file() and (parent / 'ThirdParty/FAST').is_dir():
            return parent
    raise ValueError('无法定位 IPSPOS 仓库；请指定 --repo')


def output_dir(path):
    path = Path(path).resolve()
    marker = path / '.product-download.json'
    if path.exists() and not marker.exists() and any(path.iterdir()):
        raise ValueError('输出目录已有其他内容；请选择新的目录')
    path.mkdir(parents=True, exist_ok=True)
    if not marker.exists():
        dump(marker, dict(tool='gnss-product-download', schema=1))
    return path


def days(start, end):
    current = start.date()
    while current <= end.date():
        yield current.isoformat()
        current += timedelta(days=1)


def provenance(repo):
    def git(*args):
        r = subprocess.run(['git', *args], cwd=repo, capture_output=True)
        return r.stdout.decode('utf-8', errors='replace').strip() if r.returncode == 0 else None
    commit = git('rev-parse', 'HEAD')
    header = git('show', 'HEAD:src/IPSDLL/BASEDLL/BaseSDC.h') or ''
    program = re.search(r'#define\s+IPSPOSVERSION\s+"([^"]+)"', header)
    version = re.search(r'@version\s+(\S+)', header)
    return dict(commit=commit, describe=git('describe', '--always', '--tags'), ipspos_version=program[1] if program else None,
                base_sdc_header_version=version[1] if version else None,
                note='提交版本用于追溯配置语义；本 skill 不编译或执行解算器，也不保证现有 EXE 对应此提交')


def plan(args):
    repo = root_path(args.repo)
    sources = Sources(repo, args.fast_root)
    observation = inspect(args.observation, repo, args.date, args.utc_offset)
    out = output_dir(args.out)
    old = out / 'plan.json'
    if old.is_file():
        raise ValueError('已有计划，请直接 fetch 重试；更改产品方案请使用新输出目录')
    centers = ['WHU', 'COD', 'GFZ'] if args.centers.lower() == 'all' else list(dict.fromkeys(v.strip().upper().replace('CODE', 'COD').replace('WUM', 'WHU') for v in args.centers.split(',')))
    if not centers or any(c not in ('WHU', 'COD', 'GFZ') for c in centers):
        raise ValueError('--centers 支持 WHU,COD,GFZ 或 all')
    systems = sorted(set(re.findall(r'[GRECJ]', args.systems.upper()))) if args.systems else sorted(set(observation['systems']) & set('GEC'))
    if not systems or any(s not in observation['systems'] for s in systems):
        raise ValueError('所选系统没有实际观测；用 --systems GEC 等明确选择')
    if observation['format'] == 'RTCM3' and not set(systems) <= set('GECJ'):
        raise ValueError('当前正式 RTCM 路径仅保存 GPS/BDS/Galileo/QZSS 观测；其他系统请提供 RINEX 或适配解码器')
    start, end = map(datetime.fromisoformat, [observation['start'], observation['end']])
    template = Path(args.template or repo / 'opt/IPSPOS.opt').resolve()
    if not template.is_file():
        raise ValueError('找不到 opt/IPSPOS.opt 模板')
    tasks = {}

    def task(kind, day, dtype, prefix=None):
        key = f'{dtype}:{day}'
        if key not in tasks:
            tasks[key] = dict(id=key, kind=kind, day=day, dtype=dtype, prefix=prefix,
                              urls=sources.urls(dtype, day, prefix),
                              primary_hosts=['igs.gnsswhu.cn', 'bdspride.com'] if '_WHU_' in dtype else ['ftp.gfz-potsdam.de'] if '_GFZ_' in dtype else ['ftp.aiub.unibe.ch', 'cddis.nasa.gov', 'gdc.cddis.eosdis.nasa.gov'] if '_COD_' in dtype else [])
        return key

    common = [task('nav', day, 'GCRE_brdc') for day in days(start, end)]
    atx = task('atx', start.date().isoformat(), 'MGEX_IGS20_atx')
    tasks[atx]['local_names'] = ['antenna.atx']
    common.append(atx)
    choices = []
    for center in centers:
        grades = ['final', 'rapid', 'ultra'] if args.grade == 'best' else [args.grade]
        candidates, skipped = [], []
        for grade in grades:
            key = f'{center}_{grade.upper()}'
            bundle = BUNDLES.get(key)
            if not bundle or (args.mode == 'ar' and not bundle['types'][2]):
                skipped.append(dict(bundle=key, reason='没有完整兼容的轨道/钟差/相位 OSB 目录方案' if args.mode == 'ar' else '该中心暂无此等级目录方案'))
                continue
            ids = []
            for kind, dtype in zip(KINDS, bundle['types']):
                if kind == 'bia' and args.mode != 'ar':
                    continue
                margin = args.orbit_margin if kind == 'sp3' else args.clock_margin if kind == 'clk' else 0
                for day in days(start - timedelta(seconds=margin), end + timedelta(seconds=margin)):
                    ids.append(task(kind, day, dtype, bundle['prefix']))
            candidates.append(dict(id=key, grade=grade, tasks=ids))
        choices.append(dict(id=center, candidates=candidates, skipped=skipped))
    if args.include_rts and not any(c.get('candidates') and c['candidates'][0]['id'] == 'WHU_RTS' for c in choices):
        bundle = BUNDLES['WHU_RTS']
        ids = []
        for kind, dtype in zip(KINDS, bundle['types']):
            if kind == 'bia' and args.mode != 'ar':
                continue
            margin = args.orbit_margin if kind == 'sp3' else args.clock_margin if kind == 'clk' else 0
            for day in days(start - timedelta(seconds=margin), end + timedelta(seconds=margin)):
                ids.append(task(kind, day, dtype, bundle['prefix']))
        choices.append(dict(id='WHU_RTS', candidates=[dict(id='WHU_RTS', grade='rts', tasks=ids)], skipped=[]))
    settings = dict(centers=centers, grade=args.grade, mode=args.mode, motion=args.motion,
                    systems=systems, utc_offset=args.utc_offset, bias_time_system=getattr(args, 'bias_time_system', None), orbit_margin_s=args.orbit_margin,
                    clock_margin_s=args.clock_margin, antenna_model=args.antenna_model or observation.get('antenna', ''),
                    cache=str(Path(args.cache or repo / 'build/product-cache').resolve()),
                    local_roots=list(dict.fromkeys([str(Path(observation['path']).parent), str(repo / 'ThirdParty'), *[str(Path(p).resolve()) for p in args.local_root]])))
    value = dict(schema=1, output=str(out), created_utc=datetime.now(timezone.utc).isoformat(), repo=str(repo),
                 observation=observation, settings=settings, template=dict(path=str(template), sha256=sha(template)),
                 sources=sources.version, version=provenance(repo), choices=choices, common=common, tasks=tasks,
                 next_action='fetch', next_command=resume_command(out / 'plan.json'))
    dump(old, value)
    return dict(status='planned', plan=str(old), observation=observation, choices=choices, task_count=len(tasks),
                settings=settings, next_command=value['next_command'])


def write_opt(plan_value, directory, files):
    settings = plan_value['settings']
    observation = plan_value['observation']
    source = Path(plan_value['template']['path']).read_text(encoding='utf-8-sig')
    if sha(plan_value['template']['path']) != plan_value['template']['sha256']:
        raise ValueError('模板已改变，请用新目录重新 plan')
    work = directory / 'results'
    work.mkdir(exist_ok=True)
    rover = Path(observation['path'])
    if rover.suffix.lower() == '.gz':
        input_dir = Path(plan_value['output']) / 'input'
        input_dir.mkdir(exist_ok=True)
        target = input_dir / rover.stem
        if not target.exists():
            with gzip.open(rover, 'rb') as f, target.open('wb') as out:
                shutil.copyfileobj(f, out)
        rover = target
    paths = [str(rover), str(work), *map(str, files.values())]
    if any(any(v in p for v in (';', '\n', '\r')) for p in paths):
        raise ValueError('IPSPOS 配置路径不能包含分号或换行')
    # RINEX/RTCM formats are identified by IPSPOS from file contents/extensions.
    values = dict(GNSS_PMode='3' if settings['motion'] == 'static' else '2',
                  GNSS_SatSYS='|'.join({'G': 'SYSGPS', 'E': 'SYSGAL', 'C': 'SYSBDS', 'R': 'SYSGLO', 'J': 'SYSQZS'}[s] for s in settings['systems']),
                  GNSS_ARMode='2' if settings['mode'] == 'ar' else '0',
                  GNSS_bUsePPPAntenna='ON' if files.get('atx') else 'OFF', GNSS_FilePath=str(work), GNSS_RoveFile=str(rover),
                  GNSS_NaviFile=str(files.get('nav', '')), GNSS_SP3File=str(files['sp3']), GNSS_CLKFile=str(files['clk']),
                  GNSS_BIAFile=str(files.get('bia', '')), GNSS_ATXFile=str(files.get('atx', '')), GNSS_RefFile='',
                  GNSS_SSRFile='', GNSS_BIASFile='', GNSS_BaseFile='', GNSS_ProductType='SSR',
                  GNSS_bOutputAccuracy='OFF', GNSS_bOutputULog='OFF')
    interval = observation['interval_s']
    if not interval or interval <= 0:
        raise ValueError('无法可靠识别观测采样间隔，暂不生成可运行配置')
    values['GNSS_RoveSampleTime'] = f'{interval:g}'
    lines = ['# 由 gnss-product-download 生成；原始观测和模板未修改。\n',
             f'# 产品方案：{directory.name}；{settings["motion"]}；PPP-{settings["mode"].upper()}。\n',
             '# 其余算法参数继承指定模板；未提供独立真值，关闭精度统计；未自动执行解算。\n']
    seen = set()
    for line in source.splitlines(True):
        m = re.match(r'\s*(GNSS_\w+)\s*=', line)
        # Context.c selects HAS whenever this legacy alias occurs, even empty.
        # This generated configuration uses absolute precise files, so omit the
        # alias from the run copy; leave the user's original template untouched.
        if m and m[1] in ('GNSS_HASFile', 'GNSS_bUsePPPOSB', 'GNSS_bAddTropGrad'):
            continue
        if m and m[1] in values:
            key = m[1]
            if key not in seen:
                lines.append(f'{key} = {values[key]};\n')
                seen.add(key)
        elif m:
            lines.append(line if line.endswith('\n') else line + '\n')
        elif line.startswith('#') and not any(s in line for s in ('golden', 'BAUT', 'IPS_MASTER', 'Run from', 'Regression')):
            lines.append(line if line.endswith('\n') else line + '\n')
    for key, value in values.items():
        if key not in seen:
            lines.append(f'{key} = {value};\n')
    output = directory / 'IPSPOS.opt'
    atomic_text(output, ''.join(lines))
    return str(output)


def summary_report(value):
    output = Path(value['output'])
    statuses = {'ready': '可运行（产品输入检查通过）', 'failed': '未完成', 'no_candidate': '无匹配方案'}
    state_names = {'ok': '完整', 'missing': '未找到', 'network': '网络故障', 'authentication': '认证失败', 'invalid': '内容异常', 'offline_miss': '离线缺项', 'unsupported': '未接入'}
    origin_names = {'local': '本地复用', 'cache': '缓存复用', 'download': '联网下载'}
    lines = ['# 产品准备结果\n', f'观测：`{value["observation"]["path"]}`\n',
             f'GPST：{value["observation"]["start"]} 至 {value["observation"]["end"]}\n',
             f'模式：{"静态" if value["settings"]["motion"] == "static" else "动态"} / PPP-{value["settings"]["mode"].upper()}；系统：{"、".join(SYSTEMS[s] for s in value["settings"]["systems"])}\n',
             '可运行只表示文件与输入检查通过。双频匹配依据观测头或MSM掩码声明，不验证每历元载波有效性；固定比例和定位正确性需要实际解算。\n',
             '| 方案 | 实际采用 | 状态 | 配置 |\n|---|---|---|---|\n']
    for result in value['results']:
        config = result.get('opt', '')
        link = f'[{Path(config).name}]({Path(config).relative_to(output).as_posix()})' if config else '未生成'
        lines.append(f'| {result["id"]} | {result.get("bundle", "—")} | {statuses[result["status"]]} | {link} |\n')
    for result in value['results']:
        lines.append(f'\n## {result["id"]}\n')
        for item in result.get('attempts', []):
            lines.append(f'- {item["bundle"]}：{state_names.get(item["status"], item["status"])}\n')
        for message in result.get('check', {}).get('errors', []) + result.get('check', {}).get('warnings', []):
            lines.append(f'- {message}\n')
        for task in result.get('failed_tasks', []):
            lines.append(f'- 缺项 `{task["id"]}`：{state_names.get(task["status"], task["status"])}\n')
        coverage = result.get('check', {}).get('coverage', {})
        if coverage:
            lines.append('\n| 星座 | 全时段精密覆盖卫星 | 双频码/相位OSB匹配卫星 |\n|---|---:|---:|\n')
            for system, counts in coverage.items():
                lines.append(f'| {SYSTEMS[system]} | {len(counts["precise_satellites"])} | {len(counts["dual_frequency_osb"])} |\n')
        if result.get('opt'):
            lines.append('\n在 FINDYOU 的“数据与下载”队列中选择“送入后处理”，检查配置后运行。也可使用支持该 OPT 版本的 IPSPOS 独立程序。\n')
    lines.append('\n## 文件来源与恢复\n\n| 产品任务 | 结果 | 来源 |\n|---|---|---|\n')
    for t in value['transfers'].values():
        lines.append(f'| {t["id"]} | {state_names.get(t["status"], t["status"])} | {origin_names.get(t.get("origin"), "—")} |\n')
    lines.append('\n缓存和断点保留；重新执行同一 fetch 命令补下缺项。网络/认证/内容错误不会被当作“尚未发布”自动降级。时标、框架或信号不匹配应先核查产品约定，重复下载不能解决。详细来源、文件哈希和版本见 manifest.json。\n')
    (output / '产品准备说明.md').write_text(''.join(lines), encoding='utf-8')


def fetch(args):
    value = json.loads(Path(args.plan).read_text(encoding='utf-8-sig'))
    value['next_command'] = resume_command(Path(args.plan).resolve())
    output = Path(value['output']).resolve()
    if not (output / '.product-download.json').is_file():
        raise ValueError('输出目录缺少本工具标识')
    if sha(value['observation']['path']) != value['observation']['sha256']:
        raise ValueError('观测文件已改变，请重新识别并制定计划')
    for choice in value['choices']:
        for candidate in choice['candidates']:
            (output / candidate['id'] / 'IPSPOS.opt').unlink(missing_ok=True)
    transfer = Transfer(value['settings']['cache'], value['settings']['local_roots'], value['sources']['root'], args.offline, args.timeout, args.attempts)
    results = []
    base_common = [k for k in value['common'] if value['tasks'][k]['kind'] != 'atx']
    default_atx = next(k for k in value['common'] if value['tasks'][k]['kind'] == 'atx')
    all_transfers = {}
    progress_warnings = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        def execute(ids):
            jobs = {pool.submit(transfer.get, value['tasks'][key]): key for key in set(ids) if key not in all_transfers}
            for job in as_completed(jobs):
                key = jobs[job]
                try:
                    all_transfers[key] = job.result()
                except Exception as exc:
                    all_transfers[key] = dict(id=key, status='internal_error', errors=[dict(message=str(exc))])
                print(f'{key}: {all_transfers[key]["status"]}', file=sys.stderr, flush=True)
                try:
                    dump(output / 'progress.json', dict(transfers={k: {field: t[field] for field in ('id', 'status', 'origin', 'path', 'source', 'errors', 'warnings', 'antenna') if field in t} for k, t in all_transfers.items()}))
                except OSError as exc:
                    # A progress-reader/antivirus sharing conflict must not discard usable products.
                    warning = '进度文件暂不可写，下载结果继续保留：' + str(exc)
                    if warning not in progress_warnings:
                        progress_warnings.append(warning)
                        print(warning, file=sys.stderr, flush=True)
        # Download the highest candidate from each center concurrently; lower grades are adaptive.
        execute(base_common + [key for c in value['choices'] if c['candidates'] for key in c['candidates'][0]['tasks']])
        for choice in value['choices']:
            result = dict(id=choice['id'], status='no_candidate', attempts=[], skipped=choice['skipped'])
            for candidate in choice['candidates']:
                execute(candidate['tasks'])
                ids = base_common + candidate['tasks']
                failures = [all_transfers[k] for k in ids if all_transfers[k]['status'] != 'ok']
                result['bundle'] = candidate['id']
                if failures:
                    statuses = {f['status'] for f in failures}
                    result.update(status='failed', failed_tasks=[dict(id=f['id'], status=f['status']) for f in failures])
                    result['attempts'].append(dict(bundle=candidate['id'], status=', '.join(sorted(statuses))))
                    common_fail = any(all_transfers[k]['status'] != 'ok' for k in base_common)
                    if common_fail or not statuses <= {'missing', 'offline_miss'}:
                        break
                    continue
                frames = {frame_name(all_transfers[k]['metadata']['frame']) for k in candidate['tasks'] if value['tasks'][k]['kind'] == 'sp3'}
                if len(frames) != 1 or next(iter(frames), '') not in ('IGS14', 'IGS20'):
                    result.update(status='failed', check=dict(ready=False, errors=['轨道框架不一致或尚无适用天线入口：' + ','.join(sorted(frames))], warnings=[]))
                    break
                frame = next(iter(frames))
                atx_key = default_atx if frame == 'IGS20' else 'MGEX_IGS14_atx:' + value['observation']['start'][:10]
                if atx_key not in value['tasks']:
                    value['tasks'][atx_key] = dict(id=atx_key, kind='atx', day=value['observation']['start'][:10], dtype='MGEX_IGS14_atx', prefix=None,
                        urls=Sources(value['repo'], value['sources']['root']).urls('MGEX_IGS14_atx', value['observation']['start'][:10]), local_names=['igs14.atx', 'antenna.atx'])
                value['tasks'][atx_key]['required_frame'] = frame
                value['tasks'][atx_key]['observation_window'] = [value['observation']['start'], value['observation']['end']]
                value['tasks'][atx_key]['observed_satellites'] = [sv for sv in value['observation']['satellites'] if sv[0] in value['settings']['systems']]
                execute([atx_key])
                if all_transfers[atx_key]['status'] != 'ok':
                    errors = [f'缺少适用的 {frame} 天线文件']
                    if value['settings']['mode'] == 'ar' and not value['settings'].get('bias_time_system') and any(value['tasks'][k]['kind'] == 'bia' and all_transfers[k]['metadata']['time_system'] not in ('G', 'GPS') for k in candidate['tasks']):
                        errors.append('OSB 缺少 TIME_SYSTEM，需核实时标；不能仅靠重新下载解决')
                    result.update(status='failed', failed_tasks=[dict(id=atx_key, status=all_transfers[atx_key]['status'])], check=dict(ready=False, errors=errors, warnings=[]))
                    break
                ids.append(atx_key)
                directory = output / candidate['id']
                directory.mkdir(exist_ok=True)
                # A previous successful config must not survive a failed revalidation.
                (directory / 'IPSPOS.opt').unlink(missing_ok=True)
                files, meta, assembly = {}, {}, {}
                try:
                    for kind in ('nav', 'sp3', 'clk', 'bia', 'atx'):
                        paths = [all_transfers[k]['path'] for k in ids if value['tasks'][k]['kind'] == kind]
                        if not paths:
                            continue
                        files[kind] = directory / NAMES[kind]
                        assembly[kind] = assemble(paths, files[kind], kind)
                        meta[kind] = product_info(files[kind], kind)
                    check = check_bundle(meta, value['observation'], value['settings']['systems'], value['settings']['mode'], value['settings']['antenna_model'], value['settings'].get('bias_time_system'))
                    check['warnings'] += all_transfers[atx_key].get('warnings', [])
                    result['check'] = check
                    if check['ready']:
                        result.update(status='ready', opt=write_opt(value, directory, files), preparationLevel='complete', effectiveMode=value['settings']['mode'], products={k: str(v) for k, v in files.items()})
                        result.pop('failed_tasks', None)
                    else:
                        result['status'] = 'failed'
                    result['attempts'].append(dict(bundle=candidate['id'], status='输入检查通过' if check['ready'] else '产品覆盖/兼容性检查未通过'))
                    dump(directory / 'validation.json', dict(check=check, products=meta, assembly=assembly))
                except (ValueError, OSError) as exc:
                    result.update(status='failed', check=dict(ready=False, errors=[str(exc)], warnings=[]))
                    result['attempts'].append(dict(bundle=candidate['id'], status='组装/校验失败'))
                # Product-content defects require diagnosis, never a silent quality downgrade.
                break
            if result['status'] == 'ready':
                result['next_action'] = 'deliver_config'
            elif result.get('check', {}).get('errors'):
                result['next_action'] = 'review_product_compatibility'
            elif any(t.get('status') == 'authentication' for t in result.get('failed_tasks', [])):
                result['next_action'] = 'configure_auth'
            else:
                result['next_action'] = 'retry_fetch_or_choose_profile'
            results.append(result)
    manifest = dict(**value, results=results, transfers=all_transfers, finished_utc=datetime.now(timezone.utc).isoformat(),
                    execution=dict(offline=args.offline, workers=args.workers, timeout_s=args.timeout, attempts=args.attempts, progressWarnings=progress_warnings),
                    skill_sha256={p.name: sha(p) for p in HERE.iterdir() if p.suffix in ('.py', '.ps1') and not p.name.startswith('test_')})
    manifest['ready'] = bool(results) and all(r['status'] == 'ready' for r in results)
    dump(output / 'manifest.json', manifest)
    summary_report(manifest)
    return dict(status='ready' if manifest['ready'] else 'incomplete', output=str(output), report=str(output / '产品准备说明.md'),
                results=results, retry_command=value['next_command'],
                reused=sum(t.get('origin') in ('local', 'cache') for t in all_transfers.values()),
                downloaded=sum(t.get('origin') == 'download' for t in all_transfers.values()))


def cli():
    parser = argparse.ArgumentParser(description='识别观测，使用 FAST 目录准备配套产品并生成 IPSPOS 配置')
    sub = parser.add_subparsers(dest='command', required=True)
    cat = sub.add_parser('catalog', help='列出已接入的产品方案，不联网')
    cat.add_argument('--repo')
    cat.add_argument('--fast-root')
    scan = sub.add_parser('inspect', help='识别观测并列出产品选择，不下载')
    scan.add_argument('observation')
    scan.add_argument('--repo')
    scan.add_argument('--fast-root')
    scan.add_argument('--date', help='RTCM 完整 GPST 日期锚点')
    scan.add_argument('--utc-offset', type=float)
    scan.add_argument('--out')
    for name in ('plan', 'prepare'):
        p = sub.add_parser(name, help='仅制定下载计划' if name == 'plan' else '制定计划并准备产品')
        p.add_argument('observation')
        p.add_argument('--out', required=True)
        p.add_argument('--repo')
        p.add_argument('--fast-root')
        p.add_argument('--date')
        p.add_argument('--utc-offset', type=float)
        p.add_argument('--centers', default='WHU', help='WHU,COD,GFZ 或 all；默认 WHU')
        p.add_argument('--grade', choices=['best', 'final', 'rapid', 'ultra', 'rts'], default='best')
        p.add_argument('--include-rts', action='store_true', help='额外准备 WHU 实时归档，不替代最终/快速方案')
        p.add_argument('--mode', choices=['ar', 'float'], default='ar')
        p.add_argument('--motion', choices=['static', 'kinematic'], required=True, help='不能仅凭 O 文件判断是否运动')
        p.add_argument('--systems', help='例如 GEC，默认实际观测与 GPS/Galileo/BDS 交集')
        p.add_argument('--antenna-model')
        p.add_argument('--bias-time-system', choices=['GPS'], help='仅在已核实但OSB遗漏时标声明时显式指定，不改变原文件')
        p.add_argument('--template')
        p.add_argument('--cache')
        p.add_argument('--local-root', action='append', default=[])
        p.add_argument('--orbit-margin', type=float, default=900, help='轨道边界补充秒数，默认 900')
        p.add_argument('--clock-margin', type=float, default=30, help='钟差边界补充秒数，默认 30')
        if name == 'prepare':
            transfer_args(p)
    p = sub.add_parser('fetch', help='执行或恢复已有计划，不重复识别/提问')
    p.add_argument('plan')
    transfer_args(p)
    p = sub.add_parser('status', help='读取已有结果')
    p.add_argument('out')
    args = parser.parse_args()
    try:
        if args.command == 'catalog':
            result = dict(catalog=Sources(root_path(args.repo), args.fast_root).catalog())
        elif args.command == 'inspect':
            repo = root_path(args.repo)
            result = dict(observation=inspect(args.observation, repo, args.date, args.utc_offset), catalog=Sources(repo, args.fast_root).catalog(),
                          next_action='选择中心、等级、PPP模式和静态/动态，再调用 plan 或 prepare')
            if args.out:
                dump(output_dir(args.out) / 'inspection.json', result)
        elif args.command in ('plan', 'prepare'):
            if args.orbit_margin < 0 or args.clock_margin < 0:
                raise ValueError('边界补充秒数不能为负')
            result = plan(args)
            if args.command == 'prepare':
                args.plan = result['plan']
                result = fetch(args)
        elif args.command == 'fetch':
            result = fetch(args)
        else:
            saved = json.loads((Path(args.out) / 'manifest.json').read_text(encoding='utf-8'))
            result = dict(status='ready' if saved['ready'] else 'incomplete', results=saved['results'], report=str(Path(args.out) / '产品准备说明.md'), retry_command=saved['next_command'])
        display = dict(result)
        if 'observation' in display:
            obs = display['observation']
            display['observation'] = {k: obs[k] for k in ('path', 'format', 'start', 'end', 'time_system', 'interval_s', 'station', 'antenna', 'systems', 'warnings') if k in obs}
            display['observation']['satellite_counts'] = {s: sum(v.startswith(s) for v in obs['satellites']) for s in obs['systems']}
            display['observation']['phase_signals'] = {s: [v for v in values if v.startswith('L')] for s, values in obs['observables'].items()}
        if 'results' in display:
            concise = []
            for item in display['results']:
                row = {k: item[k] for k in ('id', 'status', 'bundle', 'opt', 'failed_tasks', 'attempts', 'skipped', 'next_action') if k in item}
                if 'check' in item:
                    check = item['check']
                    row['check'] = {k: check[k] for k in ('ready', 'errors', 'warnings') if k in check}
                    row['coverage_counts'] = {s: dict(precise=len(c['precise_satellites']), dual_osb=len(c['dual_frequency_osb'])) for s, c in check.get('coverage', {}).items()}
                concise.append(row)
            display['results'] = concise
        print(json.dumps(display, ensure_ascii=False, indent=2, allow_nan=False))
        return 3 if result.get('status') == 'incomplete' else 0
    except (ValueError, OSError, RuntimeError, KeyError, StopIteration) as exc:
        print(json.dumps(dict(status='error', message=str(exc)), ensure_ascii=False), file=sys.stderr)
        return 2


def transfer_args(parser):
    parser.add_argument('--offline', action='store_true', help='仅本地与缓存，不联网')
    parser.add_argument('--workers', type=int, choices=range(1, 17), default=6)
    parser.add_argument('--timeout', type=int, choices=range(5, 601), default=60, metavar='5..600')
    parser.add_argument('--attempts', type=int, choices=range(1, 5), default=2)


if __name__ == '__main__':
    raise SystemExit(cli())
