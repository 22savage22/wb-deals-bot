"""One-time migration/probe using existing Actions secrets; never log credentials."""
import json
import os
import sys
import time

import bot
import config
import deal_queue
import scheduler_client as client
import smart
import state
import wb


def main():
    action = os.getenv('NATIVE_ACTION', 'prepare')
    if action == 'check':
        result = client.api('check')
        current = client.api('config')
        result.update(schedule=current['schedule'], status=current['status'])
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
            if not deal or deal['product'] > item['product'] * 1.1:
                continue
            images = wb.photos(item['id'], limit=1)
            if images:
                item.update(deal, image=wb.photo_url(item['id']))
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
        print('NATIVE_ERROR', type(exc).__name__, flush=True)
        sys.exit(1)
