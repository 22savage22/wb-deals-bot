"""Bounded native-AI preview check using the existing encrypted sync key.

Only public products/profiles and safe metering are printed or written. No
Cloudflare API token, deployment permission or Telegram send is used here.
"""
import json
import os
from pathlib import Path
import re
import sys

import requests


def main():
    base = os.environ.get('VISUAL_STAGING_URL', '').rstrip('/')
    if not re.fullmatch(r'https://[a-z0-9-]+-wb-finds-miniapp\.valeramyakishev000\.workers\.dev', base):
        raise RuntimeError('An isolated version preview URL is required')
    key = os.environ.get('MINIAPP_SYNC_KEY', '')
    if len(key) < 32:
        raise RuntimeError('Existing encrypted sync credential unavailable')
    meter = {'reads': 0, 'writes': 0}

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
    if not health.get('staging') or health.get('scheduled') is not False:
        raise RuntimeError('Wrong staging deployment')
    for phase in ('base', 'scheduler', 'learning', 'visual'):
        call('/staging/init/' + phase, {})
    selected = call('/staging/seed', {})['products']
    before = call('/staging/status')
    profiles = []
    for pid in selected:
        result = call('/staging/run', {'pid': pid})
        if result.get('state') not in ('complete', 'cached'):
            # A bad-format response has one durable retry, respecting backoff.
            # This workflow cannot reset the backoff or consume an unbounded loop.
            raise RuntimeError('Real staging profile incomplete; inspect safe status before retry')
        current = call('/staging/status')
        calls = current['calls_today']
        repeat = call('/staging/run', {'pid': pid})
        after = call('/staging/status')
        if repeat.get('state') != 'cached' or after['calls_today'] != calls:
            raise RuntimeError('Persistent cache check failed')
        profiles.append(result.get('profile') or next(p for p in after['examples'] if p['pid'] == pid))
    status = call('/staging/status')
    actual = [r['usage']['provider_neurons'] for r in status['meter'] if r['outcome'] == 'success']
    if not actual or any(n is None for n in actual):
        raise RuntimeError('Native binding did not return measured Neurons')
    if status['neurons_charged'] > 5000 or status['products_today'] > 10 or status['enabled']:
        raise RuntimeError('Free budget or inactive staging boundary failed')
    receipt = {'ok': True, 'version': 2, 'model': status['model'], 'usage_source': 'provider',
               'neurons': sum(actual), 'cache_extra_calls': 0, 'd1_reads': meter['reads'],
               'd1_writes': meter['writes'], 'deployment_id': health['deployment_id'],
               'new_calls': status['calls_today'] - before['calls_today'],
               'products': selected, 'profiles': profiles,
               'scope': 'Isolated native binding check; visual accuracy still requires photo review'}
    Path('.test-temp').mkdir(exist_ok=True)
    Path('.test-temp/visual-staging-receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
    print('VISUAL_STAGING_RECEIPT', json.dumps(receipt, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not emit request exceptions, headers, credential variables or URLs.
        print('VISUAL_STAGING_ERROR', str(error) if isinstance(error, RuntimeError) else type(error).__name__)
        sys.exit(1)
