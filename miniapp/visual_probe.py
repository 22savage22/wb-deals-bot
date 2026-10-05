"""Optional vision operations; do not alter the posting client's short timeout."""
import os
import requests
import hashlib
from pathlib import Path


def api(path, method, body=None):
    if path not in ('run', 'status', 'activate', 'accept-terms', 'sample'):
        raise ValueError('Invalid visual operation')
    root = os.environ['MINIAPP_API_URL'].rstrip('/')
    key = os.environ['MINIAPP_SYNC_KEY']
    try:
        r = requests.request(method, root + '/api/scheduler/learning/visual/' + path,
                             headers={'Authorization': 'Bearer ' + key},
                             json=(body or {}) if method == 'POST' else None, timeout=(5, 40))
        if r.status_code != 200:
            raise RuntimeError('Visual HTTP ' + str(r.status_code))
        result = r.json()
        if not isinstance(result, dict):
            raise RuntimeError('Invalid visual response')
        return result
    except requests.RequestException:
        raise RuntimeError('Visual network unavailable; inspect cached status before retry') from None


def download_profile_photos(profile):
    """Inspection artifacts only: exact analyzed public images, hash-checked."""
    root = os.environ['MINIAPP_API_URL'].rstrip('/')
    output = Path('.test-temp/visual-photos')
    output.mkdir(parents=True, exist_ok=True)
    for photo in profile['images']:
        pid, index = int(profile['pid']), int(photo['index'])
        try:
            r = requests.get(root + '/api/scheduler/learning/visual/photo',
                             params={'pid': pid, 'index': index},
                             headers={'Authorization': 'Bearer ' + os.environ['MINIAPP_SYNC_KEY']},
                             timeout=(5, 12))
        except requests.RequestException:
            raise RuntimeError('Sample image inspection network unavailable') from None
        if r.status_code != 200 or len(r.content) > 512000:
            raise RuntimeError('Sample image inspection HTTP ' + str(r.status_code))
        if hashlib.sha256(r.content).hexdigest() != photo['hash']:
            raise RuntimeError('Sample image changed since analysis')
        extension = '.png' if r.headers.get('Content-Type') == 'image/png' else '.jpg' if r.headers.get('Content-Type') == 'image/jpeg' else '.webp'
        (output / (str(pid) + '-' + str(index) + extension)).write_bytes(r.content)
    print('VISUAL_PHOTOS_VERIFIED', profile['pid'], len(profile['images']))
