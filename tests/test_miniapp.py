import hashlib
import hmac
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from urllib.parse import urlencode
from unittest.mock import patch

from miniapp.app import create_app, telegram_user
from miniapp.catalog import normalize
from miniapp.outfits import build
from miniapp.sync import public_products
import tg
import wb
from miniapp import scan

TOKEN = "test-only-token"
SYNC = "test-only-sync-key-with-at-least-32-characters"


def auth(uid=101, when=None):
    data = {"auth_date": str(int(time.time()) if when is None else when), "user": json.dumps({"id": uid}), "query_id": "test"}
    secret = hmac.new(b"WebAppData", TOKEN.encode(), hashlib.sha256).digest()
    data["hash"] = hmac.new(secret, "\n".join(f"{k}={data[k]}" for k in sorted(data)).encode(), hashlib.sha256).hexdigest()
    return {"X-Telegram-Init-Data": urlencode(data)}


def products():
    titles = ["Платье женское", "Кроссовки женские", "Балетки женские", "Туфли женские", "Сумка женская", "Серьги женские", "Футболка женская", "Джинсы женские", "Кроссовки мужские"]
    return [normalize({"id": i+1, "title": title, "price": 500+i*100, "rating": 4.8, "checked_at": int(time.time())}) for i,title in enumerate(titles)]


class MiniAppTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[1] / ".test-tmp"
        root.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=root)
        self.app = create_app({"TESTING": True, "DATABASE": str(Path(self.temp.name)/"test.sqlite3"), "BOT_TOKEN": TOKEN, "SYNC_KEY": SYNC, "ADMIN_ID": "999"})
        self.client = self.app.test_client()
        self.items = products()
        response = self.client.post('/api/sync', json={"products": self.items}, headers={"Authorization": "Bearer "+SYNC})
        self.assertEqual(response.status_code,200)

    def tearDown(self):
        self.temp.cleanup()

    def test_auth_tampering_expiry_duplicates_and_future(self):
        raw=auth()['X-Telegram-Init-Data']
        self.assertEqual(telegram_user(raw,TOKEN),101)
        for bad in (raw.replace('101','102'), raw+'&auth_date=1', auth(when=int(time.time())-4000)['X-Telegram-Init-Data'], auth(when=int(time.time())+120)['X-Telegram-Init-Data']):
            with self.assertRaises(ValueError): telegram_user(bad,TOKEN)
        self.assertEqual(self.client.get('/api/me').status_code,401)
        self.assertEqual(self.client.get('/api/catalog').status_code,200)

    def test_user_isolation_and_restart_persistence(self):
        self.assertEqual(self.client.put('/api/saved/1',json={"folder":"Подарки", "owned":True,"user_id":202},headers=auth()).status_code,200)
        self.assertEqual(self.client.get('/api/me',headers=auth(202)).json['saved'],[])
        self.client.delete('/api/saved/1',headers=auth(202))
        second=create_app(dict(self.app.config))
        self.assertEqual(second.test_client().get('/api/me',headers=auth()).json['saved'][0]['folder'],'Подарки')
        self.client.delete('/api/me',headers=auth())
        self.assertEqual(self.client.get('/api/me',headers=auth()).json['saved'],[])

    def test_sync_whitelist_and_bad_input(self):
        self.assertEqual(self.client.post('/api/sync',json={"products":[]}).status_code,403)
        data=public_products({"recent":[dict(self.items[0], voters={"private":"secret"}, token="secret")]},[])
        self.assertNotIn('voters',data[0]);self.assertNotIn('token',data[0])
        self.assertEqual(normalize(dict(self.items[0],image='https://evil.test/x'))['image'],'')
        self.assertEqual(self.client.put('/api/saved/100',json={},headers=auth()).status_code,404)
        self.assertEqual(self.client.put('/api/saved/1',json={"owned":"false"},headers=auth()).status_code,400)
        self.assertEqual(self.client.put('/api/preferences',json={"budget":True},headers=auth()).status_code,400)

    def test_three_distinct_outfits_budget_owned_and_replacement(self):
        result=build(self.items,1,4000)
        self.assertEqual(len(result),3)
        signatures=set()
        for outfit in result:
            self.assertLessEqual(outfit['total'],4000)
            self.assertEqual(outfit['total'],sum(p['price'] for p in outfit['items']))
            self.assertIn(1,[p['id'] for p in outfit['items']])
            self.assertNotIn(9,[p['id'] for p in outfit['items']])
            signatures.add(tuple(p['id'] for p in outfit['items']))
        self.assertEqual(len(signatures),3)
        self.assertEqual(build(self.items,1,400),[])
        self.assertTrue(build(self.items,1,600,owned=[1]))
        replaced=build(self.items,1,4000,exclude=[2])
        self.assertTrue(all(2 not in [p['id'] for p in o['items']] for o in replaced))
        self.assertEqual(build(self.items[:1],1,4000),[])
        with self.assertRaises(ValueError): build(self.items,1,4000,now=time.time()+49*3600)

    def test_server_owned_prices_and_admin_permissions(self):
        response=self.client.post('/api/outfits',json={"anchor":1,"budget":4000,"owned":[1],"price":0},headers=auth())
        self.assertEqual(response.status_code,200)
        self.assertTrue(all(o['total'] == sum(p['price'] for p in o['items']) for o in response.json['outfits']))
        edit={"slot":"dress","audience":"women","enabled":False}
        self.assertEqual(self.client.put('/api/admin/products/1',json=edit,headers=auth()).status_code,403)
        self.assertEqual(self.client.put('/api/admin/products/1',json=edit,headers=auth(999)).status_code,200)
        self.assertNotIn(1,[p['id'] for p in self.client.get('/api/catalog').json['products']])
        self.client.post('/api/sync',json={"products":self.items},headers={"Authorization":"Bearer "+SYNC})
        self.assertNotIn(1,[p['id'] for p in self.client.get('/api/catalog').json['products']])

    def test_saved_outfit_is_private_and_deletable(self):
        self.assertEqual(self.client.post('/api/outfits/saved',json={"ids":[1,2],"title":"На выходные"},headers=auth()).status_code,200)
        oid=self.client.get('/api/me',headers=auth()).json['outfits'][0]['id']
        self.client.delete('/api/outfits/saved/'+str(oid),headers=auth(202))
        self.assertEqual(len(self.client.get('/api/me',headers=auth()).json['outfits']),1)
        self.client.delete('/api/outfits/saved/'+str(oid),headers=auth())
        self.assertEqual(self.client.get('/api/me',headers=auth()).json['outfits'],[])

    def test_buttons_disabled_until_live(self):
        with patch.dict(os.environ,{"MINIAPP_ENABLED":"0","MINIAPP_BOT_USERNAME":"test_find_bot"}):
            self.assertEqual(len(tg._buttons('https://example.test',1)['inline_keyboard']),2)
        with patch.dict(os.environ,{"MINIAPP_ENABLED":"1","MINIAPP_BOT_USERNAME":"test_find_bot"}):
            buttons=tg._buttons('https://example.test',1)['inline_keyboard']
            self.assertEqual(buttons[-1][1]['url'],'https://t.me/test_find_bot?startapp=look_1')
        with patch.dict(os.environ,{"MINIAPP_ENABLED":"1","MINIAPP_BOT_USERNAME":"test_find_bot","MINIAPP_LINK_MODE":"bot"}):
            buttons=tg._buttons('https://example.test',1)['inline_keyboard']
            self.assertEqual(buttons[-1][0]['url'],'https://t.me/test_find_bot?start=save_1')
            self.assertEqual(buttons[-1][1]['url'],'https://t.me/test_find_bot?start=look_1')
        with patch.dict(os.environ,{"MINIAPP_ENABLED":"1","MINIAPP_BOT_USERNAME":"bad/path"}):
            self.assertEqual(len(tg._buttons('https://example.test',1)['inline_keyboard']),2)

    def test_catalog_scan_and_image_capture(self):
        self.assertEqual(normalize({"id":10,"title":"Ремень для платья","price":500})['slot'],'belt')
        self.assertEqual(normalize({"id":10,"title":"Сумка с кольцами","category":"Сумки","price":500})['slot'],'bag')
        deal={"id":10,"title":"Кроссовки женские","product":900,"rating":4.9,"category":"Обувь"}
        batches=[]
        with patch.object(scan,'QUERIES',('кроссовки женские',)), patch.object(wb,'search',return_value=[{"id":10}]), patch.object(wb,'cards',return_value=[{}]), patch.object(wb,'evaluate',return_value=(deal,'ok')), patch.object(wb,'photos',return_value=[b'image']), patch.object(wb,'photo_url',return_value='https://basket-01.wbbasket.ru/image.webp'), patch.object(scan.time,'sleep'):
            result=scan.collect(on_batch=batches.append)
        self.assertEqual(result[0]['slot'],'shoes')
        self.assertTrue(result[0]['image'])
        self.assertEqual(len(batches),1)
        with patch.object(wb,'_basket_host',return_value='01'), patch.object(wb,'_fetch_photo',return_value=b'image'):
            self.assertEqual(wb.photos(9999,limit=1),[b'image'])
        self.assertEqual(wb.photo_url(9999),'https://basket-01.wbbasket.ru/vol0/part9/9999/images/big/1.webp')


if __name__=='__main__':
    unittest.main()
