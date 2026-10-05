"""One-time migration/probe using existing Actions secrets; never log credentials."""
import json
import os
import sys
import time
import uuid

import bot
import config
import deal_queue
import scheduler_client as client
import smart
import state
import wb


def main():
    action = os.getenv('NATIVE_ACTION', 'prepare')
    if action in ('visual_probe', 'visual_status', 'visual_activate'):
        from miniapp.visual_probe import api as visual_api
        path = {'visual_probe': 'run', 'visual_status': 'status', 'visual_activate': 'activate'}[action]
        result = visual_api(path, 'GET' if path == 'status' else 'POST')
        print('VISUAL_RESULT', json.dumps(result, ensure_ascii=False))
        return
    if action == 'admin_snapshot':
        # No commands, menu changes, test actors, Telegram sends or setting writes.
        started = time.perf_counter()
        snapshot = client.api('admin')
        print('ADMIN_SNAPSHOT', json.dumps(snapshot, ensure_ascii=False))
        print('ADMIN_SNAPSHOT_RTT_MS', round((time.perf_counter() - started) * 1000, 1))
        return
    if action in ('owner_setup', 'owner_check'):
        if action == 'owner_setup':
            print('OWNER_MENU', json.dumps(client.api('owner/setup', 'POST', {}), ensure_ascii=False))
        print('OWNER_EVIDENCE', json.dumps(client.api('owner/status'), ensure_ascii=False))
        return
    if action == 'diagnostic':
        print('PRODUCTION_DIAGNOSTIC', json.dumps(client.api('diagnostic'), ensure_ascii=False))
        return
    if action == 'production_recovery':
        # This incident only; repeat dispatches cannot create a second manual
        # request. Reuse a normal Cron delivery after the fix when available.
        after = 1791153000  # 2026-10-04 22:30 UTC; before this fix deployment.
        request_id = 'production-recovery-20261005'
        current = client.api('diagnostic')
        status = current['status']
        schedule = current['schedule']
        if not schedule['enabled'] or schedule['paused']:
            raise RuntimeError('Autopost is paused; owner settings preserved')
        if not (status.get('last_post_success', 0) >= after and status.get('last_message_id')):
            client.api('action', 'POST', {'action': 'post_now', 'request_id': request_id})
            print('PRODUCTION_ONE_TICK', json.dumps(client.api('tick', 'POST', {}), ensure_ascii=False))
        # Never call tick/send again. This loop reads only independent Cron.
        for attempt in range(6):
            current = client.api('diagnostic')
            status = current['status']
            sent = status.get('last_post_success', 0)
            receipt = next((r for r in current['deliveries']
                            if r['message_id'] == status.get('last_message_id')), None)
            if (sent >= after and receipt and status.get('last_automatic_tick', 0) > sent
                    and status.get('production_chain_message_id') == receipt['message_id']
                    and current['queue_size'] > 0 and not current['active_leases']):
                print('PRODUCTION_RECOVERY_CONFIRMED', json.dumps(current, ensure_ascii=False))
                return
            if attempt < 5:
                time.sleep(15)
        raise RuntimeError('Real post and next independent Cron not yet confirmed')
    if action == 'feedback_setup':
        data = state.load(config.STATE_FILE)
        rows = [{'pid': int(pid), **{k: fb.get(k, 0) for k in ('likes', 'dislikes', 'bought')}} for pid, fb in data.get('feedback', {}).items()]
        for offset in range(0, len(rows), 100):
            print('FEEDBACK_SEED', json.dumps(client.api('feedback/seed', 'POST', {'rows': rows[offset:offset+100]})))
        if not rows:
            client.api('feedback/seed', 'POST', {'rows': []})
        result = client.api('feedback/activate', 'POST', {})
        print('FEEDBACK_WEBHOOK', json.dumps(result))
        if not result.get('webhook_ok'):
            raise RuntimeError('Webhook not confirmed')
        return
    if action in ('feedback_check', 'feedback_resolve'):
        if action == 'feedback_resolve':
            print('FEEDBACK_CHANNEL_RESOLVED', json.dumps(client.api('feedback/resolve_channel', 'POST', {})))
        result = client.api('feedback/status')
        print('FEEDBACK_STATUS', json.dumps(result, ensure_ascii=False))
        print('FEEDBACK_DIAGNOSTIC', json.dumps(client.api('feedback/diagnostic'), ensure_ascii=False))
        if not result.get('webhook_ok'):
            raise RuntimeError('Webhook not confirmed')
        current = client.api('config')
        print('FEEDBACK_PRODUCTION', json.dumps({'schedule': current['schedule'],
              'status': {k: current['status'].get(k) for k in ('last_automatic_tick', 'last_post_success', 'last_message_id', 'production_chain_message_id', 'queue_size', 'last_error')},
              'budget': client.api('budget')}, ensure_ascii=False))
        return
    if action == 'feedback_test':
        request_id = 'feedback-e2e-20261004-v1'
        initial = client.api('feedback/test/create', 'POST', {'request_id': request_id})
        print('FEEDBACK_TEST_INITIAL', json.dumps({k: v for k, v in initial.items() if k != 'chat'}, ensure_ascii=False))
        for step in (1, 2, 3):
            result = client.api('feedback/test/step', 'POST', {'request_id': request_id, 'step': step})
            expected = ({'likes': 1, 'dislikes': 0, 'bought': 0}, {'likes': 2, 'dislikes': 0, 'bought': 0}, {'likes': 1, 'dislikes': 1, 'bought': 0})[step-1]
            actual = {k: result['totals'][k] for k in expected}
            texts = [b['text'] for row in result['receipt']['reply_markup']['inline_keyboard'] for b in row if b.get('callback_data')]
            if actual != expected or texts != [f"👍 {expected['likes']}", f"👎 {expected['dislikes']}", f"🛒 Купил {expected['bought']}"]:
                raise RuntimeError('Feedback real markup mismatch')
            print('FEEDBACK_TEST_STEP', json.dumps(result, ensure_ascii=False))
        final = client.api('feedback/test/status', 'POST', {'request_id': request_id})
        print('FEEDBACK_TEST_FINAL', json.dumps({k: v for k, v in final.items() if k != 'chat'}, ensure_ascii=False))
        print('CHANNEL_MARKUP_REPAIRED', json.dumps(client.api('feedback/repair_latest', 'POST', {}), ensure_ascii=False))
        return
    if action in ('admin_check', 'admin_invite'):
        if action == 'admin_check':
            started = time.perf_counter()
            accepted = client.api('admin/check', 'POST', {'request_id': 'admin-safe-check-20261004-v1'})
            print('ADMIN_BUTTON_ACCEPTED', json.dumps({**accepted,
                  'roundtrip_ms': round((time.perf_counter() - started) * 1000, 1),
                  'telegram_posts_created': 0}, ensure_ascii=False))
        result = client.api('admin' if action == 'admin_check' else 'admin/invite',
                            'GET' if action == 'admin_check' else 'POST',
                            None if action == 'admin_check' else {})
        print('ADMIN_VERIFIED', json.dumps(result, ensure_ascii=False))
        return
    if action == 'recovery':
        # Exactly one durable owner request across workflow retries/agent wakeups.
        after = 1791072000  # D1 reset 2026-10-04 00:00 UTC, not a runtime schedule.
        if time.time() < after:
            raise RuntimeError('Quota reset has not happened yet')
        current = client.api('config')
        status = current['status']
        if not (status.get('last_post_success', 0) >= after and status.get('last_message_id')):
            schedule = current['schedule']
            if not schedule['enabled'] or schedule['paused']:
                raise RuntimeError('Autopost is paused; recovery does not override owner settings')
            client.api('action', 'POST', {'action': 'post_now', 'request_id': 'd1-recovery-20261004'})
            print('RECOVERY_TICK', json.dumps(client.api('tick', 'POST', {}), ensure_ascii=False))
        # Observe ordinary Cron, never repeat a Telegram send from this loop.
        for attempt in range(5):
            current = client.api('config')
            status = current['status']
            sent = status.get('last_post_success', 0)
            if sent >= after and status.get('last_message_id') and status.get('last_automatic_tick', 0) > sent:
                print('RECOVERY_CONFIRMED', json.dumps({
                    'message_id': status['last_message_id'], 'last_post_success': sent,
                    'next_automatic_tick': status['last_automatic_tick'],
                    'queue_size': status.get('queue_size'), 'schedule': current['schedule'],
                    'budget': client.api('budget')}, ensure_ascii=False))
                return
            if attempt < 4:
                time.sleep(20)
        raise RuntimeError('Recovery receipt or next automatic tick not confirmed')
    if action == 'post_now':
        client.api('action', 'POST', {'action': 'post_now', 'request_id': str(uuid.uuid4())})
        print(json.dumps(client.api('tick', 'POST', {}), ensure_ascii=False))
        return
    if action == 'check':
        result = client.api('check')
        current = client.api('config')
        result.update(schedule=current['schedule'], status=current['status'], budget=client.api('budget'))
        print(json.dumps(result, ensure_ascii=False))
        return
    if action == 'configure':
        interval = int(os.getenv('NATIVE_POST_INTERVAL', '10'))
        if not 5 <= interval <= 10080:
            raise ValueError('Posting interval out of range')
        for attempt in range(3):
            current = client.api('config')
            desired = {**current['schedule'], 'post_interval_minutes': interval}
            result = client.api('config', 'PUT', {
                'schedule': desired, 'revision': current['revision']})
            if not result.get('conflict'):
                print('NATIVE_CONFIG', json.dumps(result, ensure_ascii=False))
                return
        raise RuntimeError('Schedule changed concurrently; retry configuration')
    if action == 'tick':
        print(json.dumps(client.api('tick', 'POST', {}), ensure_ascii=False))
        return
    if action != 'prepare':
        raise RuntimeError('Unsupported migration action')
    settings = config.load_settings()
    config.apply(settings)
    data = state.load(config.STATE_FILE)
    snapshot = client.runtime('snapshot')
    client.merge_runtime(data, snapshot)
    queue = deal_queue.load(config.QUEUE_FILE)
    candidates = smart.balance_audience(queue, data, 3, topic_limit=smart.DAILY_TOPIC_LIMIT)
    # Bootstrap one genuinely checked image/price, not a fabricated basket URL.
    with wb.request_budget(seconds=90):
        for item in candidates:
            cards = wb.cards([item['id']])
            deal = wb.deal(cards[0], min_discount=0) if cards else None
            if not deal:
                continue
            images = wb.photos(item['id'], limit=1)
            if images:
                # Migration establishes a new verified current-price baseline;
                # the publisher's subsequent 10% increase guard is unchanged.
                item.update(deal, image=wb.photo_url(item['id']), checked_at=int(time.time()))
                print('BOOTSTRAP_VALID_PRODUCT', item['id'], 'PRICE', item['product'], 'PHOTO OK', flush=True)
                break
    queries = settings.get('queries') or config.DEFAULT_QUERIES
    if isinstance(queries, str):
        queries = [q.strip() for q in queries.split(',') if q.strip()]
    result = client.api('bootstrap', 'POST', {
        'queue': queue[:300], 'posts': (data.get('recent') or [])[-3000:],
        'policy': {'chat_id': os.getenv('TG_CHAT_ID', ''), 'queries': queries,
                   'max_price': config.MAX_PRICE, 'min_rating': config.MIN_RATING or 4.3,
                   'min_feedbacks': 0, 'blacklist': config.BLACKLIST,
                   'blocked_words': config.CATEGORY_BLOCKLIST,
                   'disabled_topics': sorted(bot._disabled_topics(settings)),
                   'total_posts': data.get('meta', {}).get('total_posts', 0)}
    })
    print('NATIVE_BOOTSTRAP', json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # These messages come from our bounded client, not raw request errors.
        message = str(exc)
        safe = message if message.startswith('Scheduler HTTP ') else type(exc).__name__
        print('NATIVE_ERROR', safe, flush=True)
        sys.exit(1)
