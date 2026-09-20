"""Offline regression checks: photo repair must never invent freshness or lose progress."""
from copy import deepcopy
import json
import time
from unittest import TestCase
from unittest.mock import patch

from miniapp import backfill, scan, cloudflare_deploy, media


PHOTO = 'https://basket-01.wbbasket.ru/vol0/part0/1/images/big/1.webp'


def deal(pid, title='Платье женское', **extra):
    return {'id': pid, 'title': title, 'product': 1000, 'rating': 4.9, **extra}


class CatalogRefreshTests(TestCase):
    def test_code_update_inherits_secrets_and_never_changes_database_or_telegram(self):
        bindings = [{'name': name, 'type': kind} for name, kind in (
            ('DB', 'd1'), ('ASSETS', 'assets'), ('MINIAPP_BOT_TOKEN', 'secret_text'),
            ('MINIAPP_SYNC_KEY', 'secret_text'), ('MINIAPP_WEBHOOK_SECRET', 'secret_text'),
            ('MINIAPP_ADMIN_ID', 'plain_text'), ('RATE_LIMITER', 'ratelimit'),
            ('MINIAPP_BOT_USERNAME', 'plain_text'))]
        with patch.object(cloudflare_deploy, 'api', side_effect=[{'bindings': bindings},
                          {'jwt': 'test-upload-ticket', 'buckets': []}, {'id': 'test-worker'}]) as api, \
                patch.object(cloudflare_deploy.requests, 'get') as health, \
                patch.object(cloudflare_deploy, 'telegram') as telegram, \
                patch.object(cloudflare_deploy, 'gh') as gh:
            health.return_value.status_code = 200
            health.return_value.json.return_value = {'configured': True}
            cloudflare_deploy.update_existing('test-token', '/accounts/test', 'https://test.example')
        self.assertEqual([call.args[1] for call in api.call_args_list], ['GET', 'POST', 'PUT'])
        self.assertTrue(all('/d1/' not in call.args[2] for call in api.call_args_list))
        put = api.call_args_list[-1]
        self.assertTrue(put.args[2].endswith('?bindings_inherit=strict'))
        metadata = json.loads(put.kwargs['files']['metadata'][1])
        self.assertEqual({b['name'] for b in metadata['bindings']}, {b['name'] for b in bindings})
        self.assertTrue(all(b['type'] == 'inherit' for b in metadata['bindings'] if b['name'] != 'ASSETS'))
        self.assertNotIn('test-token', json.dumps(metadata))
        self.assertTrue(all(not name.endswith('.test.mjs') for name in put.kwargs['files']))
        telegram.assert_not_called()
        gh.assert_not_called()

    def test_update_refuses_incomplete_existing_bindings_before_upload(self):
        with patch.object(cloudflare_deploy, 'api', return_value={'bindings': []}) as api:
            with self.assertRaisesRegex(RuntimeError, 'incomplete'):
                cloudflare_deploy.update_existing('test-token', '/accounts/test', 'https://test.example')
        self.assertEqual(api.call_count, 1)

    def test_candidates_rotate_and_interleave_categories_with_strict_cap(self):
        products = [{'id': i, 'slot': 'dress' if i <= 12 else 'shoes', 'image': ''}
                    for i in range(1, 17)]
        products.append({'id': 99, 'slot': 'bag', 'image': PHOTO, 'checked_at': int(time.time())})
        first = backfill.candidates(products, 0, limit=4)
        second = backfill.candidates(products, 1, limit=4)
        self.assertEqual(len(first), 4)
        self.assertEqual(len(set(first)), 4)
        self.assertTrue(any(pid <= 12 for pid in first))
        self.assertTrue(any(pid > 12 for pid in first))
        self.assertNotEqual(first, second)
        self.assertNotIn(99, first + second)
        self.assertEqual(backfill.candidates([], 0), [])

    def test_refresh_and_missing_photos_share_capacity_without_touching_fresh_or_hidden(self):
        now = 1800000000
        items = [{'id': i, 'slot': 'top', 'audience': 'women', 'image': ''} for i in range(1, 100)]
        items += [{'id': 200, 'slot': 'shoes', 'image': PHOTO, 'checked_at': now-86400},
                  {'id': 201, 'slot': 'bag', 'image': PHOTO, 'checked_at': now},
                  {'id': 202, 'slot': 'bag', 'image': '', 'enabled': False}]
        picked = backfill.candidates(items, 0, limit=4, now=now)
        self.assertIn(200, picked)
        self.assertNotIn(201, picked)
        self.assertNotIn(202, picked)
        self.assertEqual(len(picked), 4)
        self.assertEqual(backfill.candidates(items, 0, limit=0, now=now), [])

    def test_existing_photo_is_revalidated_without_probing_hosts(self):
        with patch.object(media.wb, '_fetch_photo', return_value=b'image') as fetch, \
                patch.object(media.wb, 'photos') as probe:
            self.assertEqual(media.verified_photo(1, PHOTO), PHOTO)
            fetch.assert_called_once_with(PHOTO)
            probe.assert_not_called()
        with patch.object(media.wb, '_fetch_photo') as fetch, \
                patch.object(media.wb, 'photos', return_value=[]):
            self.assertEqual(media.verified_photo(1, 'https://evil.example/x'), '')
            fetch.assert_not_called()

    def test_miniapp_price_cap_does_not_change_channel_filter(self):
        card = {'id': 1, 'name': 'Туфли женские', 'sizes': [{'price': {'product': 500000, 'basic': 1000000}}],
                'reviewRating': 4.9, 'feedbacks': 50}
        with patch.object(scan.wb.config, 'MAX_PRICE', 1000):
            self.assertEqual(scan.wb.evaluate(card, min_discount=0)[1], 'max_price')
            self.assertIsNotNone(scan.wb.evaluate(card, min_discount=0, max_price=15000)[0])
            self.assertEqual(scan.wb.config.MAX_PRICE, 1000)

    def test_scan_skips_fresh_items_and_fetches_rotating_pages(self):
        now = 1800000000
        existing = [{'id': 1, 'slot': 'dress', 'image': PHOTO, 'checked_at': now}]
        with patch.object(scan, 'QUERIES', ('платье женское',)), \
                patch.object(scan, 'EXTRA_QUERIES', ()), \
                patch.object(scan.time, 'time', return_value=now), \
                patch.object(scan.time, 'sleep'), \
                patch.object(scan.wb, 'search', return_value=[{'id': 1}, {'id': 2}]) as search, \
                patch.object(scan.wb, 'cards', return_value=[deal(2)]) as cards, \
                patch.object(scan.wb, 'evaluate', side_effect=lambda card, **kw: (card, 'ok')), \
                patch.object(scan, 'verified_photo', return_value=PHOTO):
            found = scan.collect(products=existing, epoch=1)
        search.assert_called_once_with('платье женское', 2)
        cards.assert_called_once_with([2])
        self.assertEqual([p['id'] for p in found], [2])

    def test_query_plan_keeps_male_foundations_and_visits_scarce_groups_first(self):
        now = 1800000000
        products = [{'id': 1, 'slot': 'dress', 'audience': 'women', 'image': PHOTO, 'checked_at': now}]
        plan = scan.query_plan(products, 0, now)
        for query in ('футболка мужская', 'джинсы мужские', 'кроссовки мужские'):
            self.assertIn(query, plan)
        self.assertEqual(plan[-1], 'платье женское')
        self.assertNotEqual(scan.query_plan([], 0, now), scan.query_plan([], 1, now))

    def test_failed_photos_do_not_refresh_or_mutate_old_data(self):
        old = [{'id': 1, 'slot': 'dress', 'image': '', 'checked_at': 10, 'price': 777}]
        original = deepcopy(old)
        batches = []
        with patch.object(backfill.wb, 'cards', return_value=[{}]), \
                patch.object(backfill.wb, 'evaluate', return_value=(deal(1), 'ok')), \
                patch.object(backfill.wb, 'photos', return_value=[]), \
                patch.object(backfill.wb, 'photo_url') as image_url:
            result = backfill.repair(old, on_batch=batches.append)
        self.assertEqual(result, [])
        self.assertEqual(batches, [])
        self.assertEqual(old, original)
        image_url.assert_not_called()

    def test_repair_uploads_each_verified_product_and_keeps_previous_catalog(self):
        old = [{'id': i, 'slot': 'dress', 'image': '', 'checked_at': 10} for i in (1, 2, 3)]
        original = deepcopy(old)
        batches = []
        with patch.object(backfill.wb, 'cards', return_value=[deal(1), deal(2), deal(3)]), \
                patch.object(backfill.wb, 'evaluate', side_effect=lambda card, **kw: (card, 'ok')), \
                patch.object(backfill.wb, 'photos', return_value=[b'image']), \
                patch.object(backfill.wb, 'photo_url', return_value=PHOTO), \
                patch.object(backfill.time, 'time', return_value=1800000000):
            result = backfill.repair(old, on_batch=batches.append)
        self.assertEqual([p['id'] for p in result], [1, 2, 3])
        self.assertEqual([batch[0]['id'] for batch in batches], [1, 2, 3])
        self.assertTrue(all(len(batch) == 1 for batch in batches))
        self.assertTrue(all(p['checked_at'] == 1800000000 and p['image'] == PHOTO for p in result))
        self.assertEqual(old, original)

    def test_repair_rejects_invalid_urls_expensive_cards_and_obeys_deadline(self):
        old = [{'id': 1, 'slot': 'dress', 'image': ''}]
        with patch.object(backfill.wb, 'cards') as cards:
            self.assertEqual(backfill.repair(old, seconds=0), [])
            cards.assert_not_called()
        for item, image in [(deal(1), 'https://evil.example/image'), (deal(1, product=15001), PHOTO)]:
            with patch.object(backfill.wb, 'cards', return_value=[item]), \
                    patch.object(backfill.wb, 'evaluate', return_value=(item, 'ok')), \
                    patch.object(backfill.wb, 'photos', return_value=[b'image']), \
                    patch.object(backfill.wb, 'photo_url', return_value=image):
                self.assertEqual(backfill.repair(old), [])

    def test_scan_persists_fourth_item_before_break_and_respects_query_cap(self):
        cards = [deal(i) for i in range(1, 7)]
        batches = []
        with patch.object(scan, 'QUERIES', ('платье женское',)), \
                patch.object(scan, 'EXTRA_QUERIES', ('платье женское', 'платье женское')), \
                patch.object(scan.wb, 'search', return_value=[{'id': p['id']} for p in cards]), \
                patch.object(scan.wb, 'cards', return_value=cards), \
                patch.object(scan.wb, 'evaluate', side_effect=lambda card, **kw: (card, 'ok')), \
                patch.object(scan.wb, 'photos', return_value=[b'image']), \
                patch.object(scan.wb, 'photo_url', return_value=PHOTO), \
                patch.object(scan.time, 'sleep'):
            result = scan.collect(on_batch=batches.append)
        # First query's fourth item must be uploaded before its loop breaks.
        self.assertEqual([batch[0]['id'] for batch in batches[:4]], [1, 2, 3, 4])
        self.assertEqual(len({p['id'] for p in result}), len(result))
        self.assertEqual([p['id'] for p in result], [batch[0]['id'] for batch in batches])

    def test_scan_missing_photo_never_uploads_and_keeps_original_card_dates(self):
        card = deal(1, checked_at=10)
        batches = []
        with patch.object(scan, 'QUERIES', ('платье женское',)), \
                patch.object(scan, 'EXTRA_QUERIES', ('платье женское',)), \
                patch.object(scan.wb, 'search', return_value=[{'id': 1}]), \
                patch.object(scan.wb, 'cards', return_value=[card]), \
                patch.object(scan.wb, 'evaluate', return_value=(card, 'ok')), \
                patch.object(scan.wb, 'photos', return_value=[]), \
                patch.object(scan.wb, 'photo_url') as image_url, \
                patch.object(scan.time, 'sleep'):
            self.assertEqual(scan.collect(on_batch=batches.append), [])
        self.assertEqual(card['checked_at'], 10)
        self.assertEqual(batches, [])
        image_url.assert_not_called()
