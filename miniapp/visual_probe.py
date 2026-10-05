"""Optional vision operations; do not alter the posting client's short timeout."""
import os
import requests


def api(path, method):
    if path not in ('run', 'status', 'activate'):
        raise ValueError('Invalid visual operation')
    root = os.environ['MINIAPP_API_URL'].rstrip('/')
    key = os.environ['MINIAPP_SYNC_KEY']
    try:
        r = requests.request(method, root + '/api/scheduler/learning/visual/' + path,
                             headers={'Authorization': 'Bearer ' + key},
                             json={} if method == 'POST' else None, timeout=(5, 40))
        if r.status_code != 200:
            raise RuntimeError('Visual HTTP ' + str(r.status_code))
        result = r.json()
        if not isinstance(result, dict):
            raise RuntimeError('Invalid visual response')
        return result
    except requests.RequestException:
        raise RuntimeError('Visual network unavailable; inspect cached status before retry') from None
