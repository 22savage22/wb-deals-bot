"""Live smoke test; creates and removes only its own synthetic user data."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import time
from urllib.parse import urlencode
import requests

URL = 'https://wb-finds-miniapp.valeramyakishev000.workers.dev'


def main():
    token = re.search(r'\b\d{6,12}:[A-Za-z0-9_-]{30,}\b', Path(
        r'C:\Users\valer\OneDrive\Рабочий стол\бот вб апи.txt').read_text(encoding='utf-8-sig')).group()

    def auth(uid):
        fields = {'auth_date':str(int(time.time())), 'user':json.dumps({'id':uid})}
        secret = hmac.new(b'WebAppData',token.encode(),hashlib.sha256).digest()
        fields['hash'] = hmac.new(secret,'\n'.join(f'{k}={fields[k]}' for k in sorted(fields)).encode(),hashlib.sha256).hexdigest()
        return {'X-Telegram-Init-Data':urlencode(fields)}

    def call(method, path, uid=None, **kwargs):
        response = requests.request(method, URL+path,headers=auth(uid) if uid else {},timeout=30,**kwargs)
        return response

    assert call('GET','/api/health').json() == {'ok':True,'configured':True}
    assert call('GET','/api/me').status_code == 401
    assert call('POST','/telegram/webhook',json={}).status_code == 403
    assert call('POST','/api/sync',json={'products':[]}).status_code == 403
    for path in ('/','/static/app.css','/static/app.js'):
        r=call('GET',path); assert r.status_code == 200, (path,r.status_code)
        assert r.headers.get('X-Content-Type-Options') == 'nosniff'
    owner=call('GET','/api/me',int(os.environ['MINIAPP_ADMIN_ID'])); assert owner.status_code == 200
    assert owner.json()['is_admin'] is True
    products=call('GET','/api/catalog').json()['products']; assert products
    uid=8000000000001; other=8000000000002
    before=call('GET','/api/me',uid).json()
    assert not before['saved'] and not before['outfits'] and not before['preferences'], 'Test identity already used; refusing mutation'
    pid=products[0]['id']
    try:
        assert call('PUT',f'/api/saved/{pid}',uid,json={'folder':'QA','owned':False}).status_code == 200
        assert call('GET','/api/me',uid).json()['saved'][0]['product_id'] == pid
        assert call('GET','/api/me',other).json()['saved'] == []
        assert call('GET','/api/admin/products',uid).status_code == 403
        assert call('PUT','/api/preferences',uid,json={'budget':3500,'occasion':'office'}).status_code == 200
        assert call('GET','/api/me',uid).json()['preferences']['budget'] == 3500
    finally:
        assert call('DELETE','/api/me',uid).status_code == 200
    assert call('GET','/api/me',uid).json()['saved'] == []
    print('Live checks passed: HTTPS/static, auth, owner admin, sync/webhook rejection, persistence, isolation, cleanup.')
    print('Public catalog products:',len(products))


if __name__ == '__main__':
    main()
