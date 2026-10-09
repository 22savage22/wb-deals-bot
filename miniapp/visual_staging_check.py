"""Bounded native-AI preview check using the existing encrypted sync key.

Only public products/profiles and safe metering are printed or written. No
Cloudflare API token, deployment permission or Telegram send is used here.
"""
import html
import json
import os
from pathlib import Path
import re
import sys
import time

import requests


def assess_profile(sample, profile):
    """Compare only previously reviewed, visible attributes at identical bytes."""
    images = profile.get('images', [])
    if len(images) != 1 or images[0].get('hash') != sample['hash']:
        raise RuntimeError('Reference photo byte version changed; stop before more AI calls')
    if profile.get('back_print') != 'unknown' or profile.get('material') != 'unknown':
        raise RuntimeError('Unseen back or material claim refused')
    fields = profile.get('fields', {})
    checks = []
    for field, expected in sample['expected'].items():
        predicted = fields.get(field, {}).get('value', 'unknown')
        checks.append({'field': field, 'expected': expected, 'predicted': predicted,
                       'returned': predicted != 'unknown', 'match': predicted == expected})
    return checks


def save_receipt(receipt):
    target = Path('.test-temp')
    target.mkdir(exist_ok=True)
    (target / 'visual-staging-receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
    esc = lambda value: html.escape(str(value), quote=True)
    cards = []
    for row in receipt['profiles']:
        profile = row['profile']
        attributes = ''.join('<tr><td>' + esc(field) + '</td><td>' + esc(data['value']) +
                             '</td><td>' + esc(data['evidence']) + '</td></tr>'
                             for field, data in profile['fields'].items())
        cards.append('<article><img src="' + esc(row['image']) + '" alt="' + esc(row['title']) +
                     '"><section><h2>' + esc(row['title']) + '</h2><p>WB ' + str(row['pid']) +
                     '</p><table>' + attributes + '</table><p>Спина: unknown. Материал: unknown. Стиль: гипотеза.</p>' +
                     '<details><summary>Полный visual profile</summary><pre>' +
                     esc(json.dumps(profile, ensure_ascii=False, indent=2)) + '</pre></details></section></article>')
    page = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + \
           '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src https://*.wbbasket.ru; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">' + \
           '<title>WB Vision — native staging</title><style>body{font:16px/1.5 system-ui;margin:24px;background:#f4f4f8}article{display:flex;gap:24px;padding:20px;margin:20px 0;background:white;flex-wrap:wrap}img{max-width:320px;max-height:600px;object-fit:contain}section{flex:1;min-width:280px}td{padding:8px;border-bottom:1px solid #ddd}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>' + \
           '<h1>Нативный Vision в изолированном staging</h1><p>Реальные фотографии и признаки. Нет Telegram-публикаций. ' + \
           'Фотографии показаны по публичному WB URL; проверенные SHA-256 находятся в отчёте.</p><pre>' + \
           esc(json.dumps(receipt['accuracy'], ensure_ascii=False, indent=2)) + '</pre>' + ''.join(cards) + '</html>'
    (target / 'visual-staging-gallery.html').write_text(page, encoding='utf-8')


def main():
    base = os.environ.get('VISUAL_STAGING_URL', '').rstrip('/')
    if not re.fullmatch(r'https://[a-z0-9-]+-wb-finds-miniapp\.valeramyakishev000\.workers\.dev', base):
        raise RuntimeError('An isolated version preview URL is required')
    key = os.environ.get('MINIAPP_SYNC_KEY', '')
    if len(key) < 32:
        raise RuntimeError('Existing encrypted sync credential unavailable')
    meter = {'reads': 0, 'writes': 0}
    samples = json.loads(Path('miniapp/cloudflare/visual_staging_samples.json').read_text(encoding='utf-8'))
    fixtures = {sample['id']: sample for sample in samples['products']}

    def call(path, body=None):
        try:
            response = requests.request('POST' if body is not None else 'GET', base + path,
                                        headers={'Authorization': 'Bearer ' + key},
                                        json=body, timeout=(10, 55), allow_redirects=False)
        except requests.RequestException:
            raise RuntimeError('Staging transport failed; no blind retry') from None
        if response.status_code != 200:
            raise RuntimeError(f'Staging HTTP {response.status_code}')
        try:
            result = response.json()
        except ValueError:
            raise RuntimeError('Staging returned invalid JSON') from None
        if result.get('ok') is False:
            raise RuntimeError('Staging refused the check')
        d1 = result.get('d1', {})
        if d1:
            if not d1.get('metadata_available'):
                raise RuntimeError('Actual D1 metadata missing')
            meter['reads'] += d1['rows_read']
            meter['writes'] += d1['rows_written']
        return result

    health = call('/api/health')
    if not health.get('staging') or health.get('scheduled') is not False or health.get('database_id') != samples['database']['id']:
        raise RuntimeError('Wrong staging deployment')
    for phase in ('base', 'scheduler', 'learning', 'visual'):
        call('/staging/init/' + phase, {})
    selected = call('/staging/seed', {})['products']
    if len(selected) != 10 or set(selected) != set(fixtures):
        raise RuntimeError('Exact ten-product staging fixture required')
    before = call('/staging/status')
    if before.get('river_mode') != 'SHADOW' or before.get('database_id') != samples['database']['id']:
        raise RuntimeError('Pinned staging database and River SHADOW required before AI')
    profiles = []
    format_retry_used = False
    for pid in selected:
        result = call('/staging/run', {'pid': pid})
        if result.get('state') == 'deferred' and result.get('error') in ('VISUAL_INVALID_JSON', 'VISUAL_INVALID_PROFILE') and not format_retry_used:
            # One bounded format retry for this workflow, honoring the durable
            # per-image retry and backoff. No retries for quota or transport.
            wait = result.get('retry_at', 0) - time.time() + 1
            if not 0 <= wait <= 365:
                raise RuntimeError('Format retry backoff outside the bounded allowance')
            format_retry_used = True
            deadline = time.monotonic() + wait
            print('VISUAL_STAGING_WAIT', 'One format retry after recorded backoff', flush=True)
            while time.monotonic() < deadline:
                time.sleep(min(30, max(0, deadline - time.monotonic())))
            result = call('/staging/run', {'pid': pid})
        if result.get('state') not in ('complete', 'cached'):
            raise RuntimeError('Real staging profile incomplete; inspect safe status before retry')
        profile = result.get('profile')
        if not isinstance(profile, dict):
            raise RuntimeError('Durable real profile missing')
        checks = assess_profile(fixtures[pid], profile)
        current = call('/staging/status')
        calls = current['calls_today']
        repeat = call('/staging/run', {'pid': pid})
        after = call('/staging/status')
        if repeat.get('state') != 'cached' or after['calls_today'] != calls or repeat.get('profile') != profile:
            raise RuntimeError('Persistent cache check failed')
        profiles.append({'pid': pid, 'title': fixtures[pid]['title'], 'image': fixtures[pid]['image'],
                         'profile': profile, 'checks': checks})
    status = call('/staging/status')
    metered = [r for r in status['meter'] if r['outcome'] == 'success']
    actual = [r['usage']['provider_neurons'] for r in metered]
    if not actual or any(n is None for n in actual) or len(metered) != status['calls_today']:
        raise RuntimeError('Native binding did not return measured Neurons')
    if status['neurons_charged'] > 5000 or status['products_today'] > 10 or status['enabled'] or status.get('river_mode') != 'SHADOW':
        raise RuntimeError('Free budget or inactive staging boundary failed')
    checks = [check for row in profiles for check in row['checks']]
    returned = sum(check['returned'] for check in checks)
    correct = sum(check['match'] for check in checks)
    colors = sum(check['match'] for check in checks if check['field'] == 'color')
    quality = returned > 0 and correct == returned and returned / len(checks) >= .85 and colors == 10
    accuracy = {'reference_attributes': len(checks), 'returned_reference_attributes': returned,
                'correct_reference_attributes': correct, 'coverage': returned / len(checks),
                'precision_on_returned': correct / returned if returned else 0, 'color_correct': colors,
                'unseen_back_guesses': 0, 'passed': quality,
                'limitations': 'Ten reviewed byte versions, not broad model accuracy. Additional fields require photo review; style excluded.'}
    receipt = {'ok': quality, 'version': 2, 'model': status['model'], 'usage_source': 'provider',
               'neurons': sum(actual), 'cache_extra_calls': 0, 'd1_reads': meter['reads'],
               'd1_writes': meter['writes'], 'deployment_id': health['deployment_id'],
               'new_calls': status['calls_today'] - before['calls_today'],
               'products': selected, 'profiles': profiles,
               'neurons_charged': status['neurons_charged'], 'accuracy': accuracy,
               'database_id': status['database_id'], 'river_mode': status['river_mode'],
               'format_retry_used': format_retry_used, 'staging_enabled': status['enabled'],
               'scope': 'Isolated native binding + D1 ten-product test. Production unchanged; owner confirmation still required.'}
    save_receipt(receipt)
    print('VISUAL_STAGING_RECEIPT', json.dumps(receipt, ensure_ascii=False))
    if not quality:
        raise RuntimeError('Native visual quality gate failed; production remains pending')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not emit request exceptions, headers, credential variables or URLs.
        print('VISUAL_STAGING_ERROR', str(error) if isinstance(error, RuntimeError) else type(error).__name__)
        sys.exit(1)
