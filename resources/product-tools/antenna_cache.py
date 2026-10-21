"""ANTEX version checks, immutable snapshots and validity-aware offline reuse.

Receiver calibration is optional. Satellite validity and frame checks remain mandatory.
No release-date == observation-date assumption is made.
"""
import hashlib
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path

from atomic_io import dump

REFRESH_AFTER = timedelta(hours=24)


def fetch_antenna(transfer, task):
    errors = []

    def finish(result, checked=None, fresh=False, explicit=False):
        result.setdefault('errors', [])[:0] = errors
        if result['status'] == 'ok':
            response = result.get('response', {})
            result['antenna'] = dict(frame=result['metadata']['frame'], sha256=result['metadata']['sha256'],
                                     lastModified=response.get('last_modified'), checkedAt=checked,
                                     versionChecked=fresh, explicit=explicit)
        return result

    explicit = task.get('antenna_path')
    if explicit:
        path = Path(explicit).resolve()
        if path.is_file():
            try:
                meta = transfer.metadata(path, 'atx')
                transfer.validate_task(meta, task)
                return finish(dict(id=task['id'], status='ok', origin='local', path=str(path), metadata=meta), explicit=True)
            except (OSError, ValueError) as exc:
                errors.append(dict(status='invalid', source=str(path), message='指定 ANTEX 不可用：' + str(exc)))
        else:
            errors.append(dict(status='missing', source=str(path), message='指定 ANTEX 文件不存在'))

    urls = task['urls']
    version_urls = task.get('_version_urls', urls)
    state_path = transfer.cache / 'antenna-versions' / (hashlib.sha256('\n'.join(version_urls).encode()).hexdigest()[:24] + '.json')
    state, cached = {}, None
    if state_path.is_file():
        try:
            state = json.loads(state_path.read_text(encoding='utf-8'))
            path = Path(state['path'])
            meta = transfer.metadata(path, 'atx')
            transfer.validate_task(meta, task)
            if state['sha256'] != meta['sha256']:
                raise ValueError('缓存天线摘要与版本记录不一致')
            cached = dict(id=task['id'], status='ok', origin='cache', path=str(path), source=state['source'],
                          metadata=meta, response={k: state[k] for k in ('etag', 'last_modified') if k in state})
            checked = datetime.fromisoformat(state['checked_at'])
            age = datetime.now(timezone.utc) - checked
            if not transfer.offline and urls and timedelta(0) <= age < REFRESH_AFTER:
                return finish(cached, state['checked_at'], fresh=True)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            errors.append(dict(status='invalid', source=str(state_path), message='天线版本缓存不可复用：' + str(exc)))
            state, cached = {}, None

    # Name-based local files have no trustworthy remote-version timestamp. Keep them
    # as an offline/network-failure fallback, never let them mask an online refresh.
    local = cached or transfer._get_file({**task, '_local_only': True})
    if transfer.offline or not urls:
        if local['status'] == 'ok':
            local.setdefault('warnings', []).append('天线采用本地 / 离线缓存，框架及卫星标定有效期已检查；未联网确认版本。')
        return finish(local, state.get('checked_at'))

    result = transfer._get_file({**task, '_skip_local': True, '_refresh': True, '_previous': state})
    if result['status'] == 'ok':
        checked = datetime.now(timezone.utc).isoformat()
        version = dict(path=result['path'], sha256=result['metadata']['sha256'], source=result['source'], checked_at=checked,
                       **result.get('response', {}))
        try:
            state_path.parent.mkdir(parents=True, exist_ok=True)
            dump(state_path, version)
        except OSError as exc:
            result.setdefault('warnings', []).append('天线已校验，但版本缓存暂不可写：' + str(exc))
        return finish(result, checked, fresh=True)

    if local['status'] == 'ok':
        local.setdefault('errors', []).extend(result.get('errors', []))
        local.setdefault('warnings', []).append('天线版本检查 / 下载失败，复用通过框架和卫星标定有效期检查的缓存；是否为最新版本未确认。')
        return finish(local, state.get('checked_at'))
    result.setdefault('errors', []).extend(local.get('errors', []))
    return finish(result)
