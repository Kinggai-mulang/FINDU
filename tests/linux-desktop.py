"""Drive the shipped GTK/WebKit application via the Tauri WebDriver protocol."""
import argparse
import base64
import json
from pathlib import Path
import subprocess
import time
import urllib.request

p = argparse.ArgumentParser()
p.add_argument('--app', type=Path, required=True)
p.add_argument('--inputs', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--logs', nargs='*', type=Path, default=[])
a = p.parse_args()
a.output.mkdir(parents=True, exist_ok=True)

def request(method, endpoint, body=None, timeout=180):
    raw = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request('http://127.0.0.1:4444' + endpoint, data=raw, method=method,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        value = json.load(response)['value']
    if isinstance(value, dict) and 'error' in value:
        raise AssertionError(value)
    return value

with (a.output / 'webdriver.log').open('w') as log:
    driver = subprocess.Popen(['tauri-driver'], stdout=log, stderr=subprocess.STDOUT)
    session = None
    try:
        for _ in range(60):
            try:
                request('GET', '/status'); break
            except OSError:
                time.sleep(.25)
        session = request('POST', '/session', {'capabilities': {'alwaysMatch': {
            'browserName': 'wry', 'tauri:options': {'application': str(a.app.resolve())}}}})['sessionId']
        prefix = '/session/' + session
        request('POST', prefix + '/timeouts', {'script': 180000, 'pageLoad': 120000, 'implicit': 0})
        def js(code, *args):
            return request('POST', prefix + '/execute/sync', {'script': code, 'args': list(args)})
        def invoke(name, args=None):
            value = request('POST', prefix + '/execute/async', {
                'script': 'const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({ok:true,value})).catch(error=>done({ok:false,error:String(error)}));',
                'args': [name, args or {}]})
            assert value['ok'], value
            return value.get('value')
        for _ in range(80):
            if js('return document.querySelectorAll(".nav-item").length') == 5:
                break
            time.sleep(.25)
        assert js('return document.querySelectorAll(".nav-item").length') == 5
        assert js('return document.querySelector(".sidebar-version").textContent.includes("LINUX")')
        js('window.__testErrors=[];window.addEventListener("error",e=>window.__testErrors.push(e.message));window.addEventListener("unhandledrejection",e=>window.__testErrors.push(String(e.reason)));')
        def shoot(name):
            # Software-rendered WebKit under Xvfb can stall a snapshot; the page assertions do not depend on it.
            try:
                (a.output / (name + '.png')).write_bytes(base64.b64decode(request('GET', prefix + '/screenshot', timeout=30)))
            except OSError:
                evidence.setdefault('screenshotsSkipped', []).append(name)
        evidence = {'engine': invoke('engine_info'), 'paths': invoke('runtime_paths'), 'pages': []}
        assert Path(evidence['paths']['workspace']) == a.app.resolve().parent, evidence['paths']
        for i, name in enumerate(['实时监控', '后处理', '数据与下载', '分析对比', '产品对比']):
            js('Array.from(document.querySelectorAll(".nav-item")).find(e=>e.textContent.includes(arguments[0])).click()', name)
            time.sleep(1)
            assert js('return document.body.innerText.includes(arguments[0])', name)
            assert not js('return document.documentElement.scrollWidth>innerWidth'), name
            shoot('page-' + str(i))
            evidence['pages'].append(name)
        # Actual production product worker with the relocated package's own Python and engine.
        obs = a.inputs / 'DATA/BAUT/BAUT00DEU_R_20240190000_01D_30S_MO.24o'
        req = dict(observation=str(obs), centers=['WHU'], grade='final', mode='ar', motion='static',
                   downloadAntenna=False, antennaPath=str(a.inputs / 'DATA/COMMON/antenna.atx'),
                   localRoot=str(obs.parent), switchSource=True, offline=True, workers=2, timeout=15, attempts=1)
        job_id = invoke('start_product', {'request': req})
        for _ in range(180):
            jobs = invoke('product_jobs')
            job = next(row for row in jobs if row['job']['id'] == job_id)
            if job['job']['status'] not in ['running', 'queued']:
                break
            time.sleep(.5)
        evidence['product'] = job
        assert job['job']['status'] == 'ready' and job['manifest']['ready'], job
        if a.logs:
            js('''const field=document.querySelector('[aria-label="分析结果路径"]');
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,arguments[0]);
                field.dispatchEvent(new Event('input',{bubbles:true}));''', '|'.join(map(str, a.logs)))
            start = time.monotonic()
            js('Array.from(document.querySelectorAll("button")).find(e=>e.textContent.includes("按路径载入")).click()')
            for _ in range(240):
                if js('return document.querySelector(".metric .metric-value")?.textContent?.startsWith(arguments[0])', str(len(a.logs))):
                    break
                time.sleep(.5)
            else:
                raise AssertionError('Large analysis import timed out')
            evidence['analysisLoadSeconds'] = round(time.monotonic() - start, 2)
            for tab in ['定位与连续性', '观测与质控', '模糊度与固定', '大气与状态耦合', '产品覆盖', '结果总览']:
                js('Array.from(document.querySelectorAll("[role=tab]")).find(e=>e.textContent===arguments[0]).click()', tab)
                js('document.querySelector(".ant-tabs-content-active")?.scrollIntoView()')
                time.sleep(1)
                if tab == '定位与连续性':
                    assert js('return document.querySelectorAll("canvas").length') > 0
                    shoot('large-position')
            shoot('large-analysis')
        evidence['errors'] = js('return window.__testErrors')
        assert evidence['errors'] == [], evidence['errors']
        (a.output / 'check.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf8')
        print('Linux GTK/WebKit four pages, portable paths and offline product worker passed')
    finally:
        if session:
            request('DELETE', '/session/' + session)
        driver.terminate()
        driver.wait(timeout=10)
