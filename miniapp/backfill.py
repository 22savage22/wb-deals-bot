"""Gradually repair old catalog photos with fresh WB cards, never guessed URLs."""
import os
import time
from collections import defaultdict, deque

import requests
import wb
from .catalog import normalize
from .sync import upload
from .media import verified_photo


def candidates(products, epoch, limit=48, now=None):
    """Share capacity between missing photos and prices due for a daily refresh."""
    if limit <= 0:
        return []
    now = time.time() if now is None else now
    groups = defaultdict(deque)
    for p in sorted(products, key=lambda p: p['id']):
        if p.get('enabled') is False:
            continue
        lane = 'missing' if not p.get('image') else 'refresh'
        if lane == 'refresh' and 0 <= now - p.get('checked_at', 0) < 86400:
            continue
        groups[(lane, p.get('audience', 'unknown'), p.get('slot', 'other'))].append(p['id'])
    for items in groups.values():
        items.rotate(-(epoch % len(items)))
    # Alternate lanes so a large backlog never starves photographed clothes.
    lanes = {lane: deque(sorted(k for k in groups if k[0] == lane)) for lane in ('refresh', 'missing')}
    for keys in lanes.values():
        if keys:
            keys.rotate(-(epoch % len(keys)))
    result = []
    while any(lanes.values()) and len(result) < limit:
        for keys in lanes.values():
            if not keys:
                continue
            key = keys.popleft()
            result.append(groups[key].popleft())
            if groups[key]:
                keys.append(key)
            if len(result) == limit:
                break
    return result


def repair(products, on_batch=None, limit=48, seconds=480):
    deadline = time.monotonic() + seconds
    ids = candidates(products, int(time.time() // 21600), limit)
    known = {p['id']: p for p in products}
    result = []
    for start in range(0, len(ids), 6):
        if time.monotonic() >= deadline:
            break
        for card in wb.cards(ids[start:start + 6]):
            if time.monotonic() >= deadline:
                break
            deal, _ = wb.evaluate(card, min_discount=0, min_rating=4.5, min_feedbacks=20, max_price=15000)
            if not deal or deal['product'] > 15000:
                continue
            photo = verified_photo(deal['id'], known.get(deal['id'], {}).get('image', ''))
            if not photo:
                continue
            product = normalize({**deal, 'image': photo, 'checked_at': int(time.time())})
            if not product['image']:
                continue
            result.append(product)
            # Persist each verified item so a late WB timeout loses no earlier work.
            if on_batch:
                on_batch([product])
    return result


def main():
    url = os.environ.get('MINIAPP_API_URL', '').rstrip('/')
    if not url or not os.environ.get('MINIAPP_SYNC_KEY'):
        print('Mini App not configured; photo repair skipped')
        return
    response = requests.get(url + '/api/catalog', timeout=(5, 30))
    response.raise_for_status()
    products = response.json()['products']
    result = repair(products, on_batch=upload)
    print(f'Photo repair: {len(result)} verified products; existing saved items preserved')


if __name__ == '__main__':
    main()
