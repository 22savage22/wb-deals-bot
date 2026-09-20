"""Deploy only Workers/D1 through a short-lived in-memory credential.

No credential is written to disk. Existing resources are reused by exact name.
Run from repository root: python -m miniapp.cloudflare_deploy NONCE inspect|deploy
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time

import requests

ACCOUNT = 'a4f7cbd9ad379d4b18087b99e9839205'
NAME = 'wb-finds-miniapp'
REPO = '22savage22/wb-deals-bot'
ROOT = Path(__file__).resolve().parent


def api(token, method, path, **kwargs):
    response = requests.request(method, 'https://api.cloudflare.com/client/v4' + path,
                                headers={'Authorization': 'Bearer ' + token},
                                timeout=(10, 90), allow_redirects=False, **kwargs)
    try:
        result = response.json()
    except ValueError:
        raise RuntimeError(f'Cloudflare HTTP {response.status_code}') from None
    if not response.ok or result.get('success') is False:
        codes = [e.get('code') for e in result.get('errors', [])]
        raise RuntimeError(f'Cloudflare HTTP {response.status_code}, codes={codes}')
    return result.get('result')


def telegram(token, method, payload=None):
    response = requests.post(f'https://api.telegram.org/bot{token}/{method}',
                             json=payload or {}, timeout=(10, 30))
    data = response.json()
    if not data.get('ok'):
        raise RuntimeError(f'Telegram {method} failed, HTTP {response.status_code}')
    return data['result']


def gh(*args, secret=None):
    result = subprocess.run(['gh', *args, '--repo', REPO], input=secret, text=True,
                            capture_output=True)
    if result.returncode:
        raise RuntimeError('GitHub operation failed: ' + ' '.join(args[:2]))
    return result.stdout


def main():
    nonce, action = sys.argv[1:3]
    credentials = requests.get('http://127.0.0.1:8769/credential',
                               headers={'X-Setup-Nonce': nonce}, timeout=5).json()
    token = credentials['token']
    prefix = f'/accounts/{ACCOUNT}'
    verified = api(token, 'GET', '/user/tokens/verify')
    print('Temporary credential status:', verified['status'], flush=True)
    databases = api(token, 'GET', prefix + '/d1/database')
    print('D1 databases:', [d['name'] for d in databases], flush=True)
    subdomain = api(token, 'GET', prefix + '/workers/subdomain')['subdomain']
    url = f'https://{NAME}.{subdomain}.workers.dev'
    print('Application address:', url, flush=True)
    if action == 'inspect':
        return
    if action != 'deploy':
        raise RuntimeError('Unknown action')
    # This exact credential file was explicitly supplied by the owner.
    bot_text = Path(r'C:\Users\valer\OneDrive\Рабочий стол\бот вб апи.txt').read_text(encoding='utf-8-sig')
    bot_token = re.search(r'\b\d{6,12}:[A-Za-z0-9_-]{30,}\b', bot_text).group()
    identity = telegram(bot_token, 'getMe')
    if identity['username'] != 'WbPodborr_bot':
        raise RuntimeError('Unexpected bot identity')
    database = next((d for d in databases if d['name'] == NAME), None)
    if database is None:
        database = api(token, 'POST', prefix + '/d1/database', json={'name': NAME})
    database_id = database['uuid']
    schema = (ROOT / 'cloudflare' / 'schema.sql').read_text(encoding='utf-8')
    api(token, 'POST', prefix + f'/d1/database/{database_id}/query', json={'sql': schema})
    print('Persistent database and schema ready', flush=True)
    manifest, assets = {}, {}
    for name, route, mime in [('index.html','/index.html','text/html; charset=utf-8'),
                              ('app.css','/static/app.css','text/css; charset=utf-8'),
                              ('app.js','/static/app.js','application/javascript; charset=utf-8')]:
        content = (ROOT / 'static' / name).read_bytes()
        digest = hashlib.sha256(content).hexdigest()[:32]
        manifest[route] = {'hash': digest, 'size': len(content)}
        assets[digest] = (digest, base64.b64encode(content), mime)
    upload = api(token, 'POST', prefix + f'/workers/scripts/{NAME}/assets-upload-session', json={'manifest': manifest})
    completion = upload['jwt']
    for bucket in upload['buckets']:
        uploaded = api(upload['jwt'], 'POST', prefix + '/workers/assets/upload?base64=true',
                       files={h: assets[h] for h in bucket})
        if uploaded and uploaded.get('jwt'):
            completion = uploaded['jwt']
    sync_key = secrets.token_urlsafe(40)
    webhook_key = secrets.token_urlsafe(40)
    admin_id = os.environ.get('MINIAPP_ADMIN_ID', '')
    bindings = [{'type':'d1','name':'DB','id':database_id},
                {'type':'assets','name':'ASSETS'},
                {'type':'secret_text','name':'MINIAPP_BOT_TOKEN','text':bot_token},
                {'type':'secret_text','name':'MINIAPP_SYNC_KEY','text':sync_key},
                {'type':'secret_text','name':'MINIAPP_WEBHOOK_SECRET','text':webhook_key},
                {'type':'ratelimit','name':'RATE_LIMITER','namespace_id':'1001','simple':{'limit':60,'period':60}},
                {'type':'plain_text','name':'MINIAPP_BOT_USERNAME','text':identity['username']},
                {'type':'plain_text','name':'MINIAPP_ADMIN_ID','text':admin_id}]
    metadata = {'main_module':'worker.mjs','compatibility_date':'2026-09-01',
                'bindings':bindings, 'assets':{'jwt':completion, 'config':{'run_worker_first':True,'html_handling':'none'}},
                'observability':{'enabled':False}}
    parts = {'metadata': ('metadata.json', json.dumps(metadata), 'application/json')}
    for path in (ROOT / 'cloudflare').glob('*.mjs'):
        if not path.name.endswith('.test.mjs'):
            parts[path.name] = (path.name, path.read_bytes(), 'application/javascript+module')
    deployed = api(token, 'PUT', prefix + f'/workers/scripts/{NAME}', files=parts)
    api(token, 'POST', prefix + f'/workers/scripts/{NAME}/subdomain', json={'enabled':True,'previews_enabled':False})
    print('Worker published:', deployed.get('id', NAME), flush=True)
    healthy = False
    for attempt in range(6):
        health = requests.get(url + '/api/health', timeout=30)
        if health.status_code == 200 and health.json().get('configured'):
            healthy = True
            break
        time.sleep(5)
    if not healthy:
        raise RuntimeError('Health check failed; channel links remain disabled')
    from .sync import public_products
    state = json.loads(Path('state.json').read_text(encoding='utf-8'))
    queue = json.loads(Path('queue.json').read_text(encoding='utf-8'))
    products = public_products(state, queue)
    for i in range(0, len(products), 40):
        result = requests.post(url + '/api/sync', json={'products':products[i:i+40]},
                               headers={'Authorization':'Bearer '+sync_key}, timeout=30)
        if result.status_code != 200:
            raise RuntimeError(f'Catalog upload failed: HTTP {result.status_code}')
    print('Public catalog uploaded:', len(products), flush=True)
    gh('secret','set','MINIAPP_SYNC_KEY',secret=sync_key)
    gh('variable','set','MINIAPP_API_URL','--body',url)
    gh('variable','set','MINIAPP_BOT_USERNAME','--body',identity['username'])
    gh('variable','set','MINIAPP_LINK_MODE','--body','bot')
    # Main Mini App activation is separate; never enable broken startapp links.
    telegram(bot_token, 'setChatMenuButton', {'menu_button':{'type':'web_app','text':'Мои находки','web_app':{'url':url}}})
    telegram(bot_token, 'setWebhook', {'url':url+'/telegram/webhook','secret_token':webhook_key,
                                     'allowed_updates':['message'],'drop_pending_updates':False})
    info = telegram(bot_token, 'getWebhookInfo')
    if info.get('url') != url+'/telegram/webhook':
        raise RuntimeError('Webhook verification failed')
    print('Bot menu and private-start webhook configured; enable channel links only after tests', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Never include exception URLs, headers, payloads or credentials.
        print('Setup stopped:', str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__)
        raise SystemExit(1) from None
