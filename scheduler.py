"""Frequent bounded trigger; D1 settings, not workflow cron, decide what is due."""
import json
import logging
import os
import subprocess
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

import bot
import config
import deal_queue
import scheduler_client as client
import scheduling
import state

log = logging.getLogger('wb.scheduler')


def github(path, method='GET', payload=None):
    repo = os.getenv('GITHUB_REPOSITORY', '22savage22/wb-deals-bot')
    try:
        r = requests.request(method, 'https://api.github.com/repos/' + repo + path,
                             headers={'Authorization': 'Bearer ' + os.getenv('GITHUB_TOKEN', ''),
                                      'Accept': 'application/vnd.github+json'},
                             json=payload, timeout=(5, 12))
        if r.status_code not in (200, 201, 204):
            raise RuntimeError('GitHub HTTP ' + str(r.status_code))
        return r.json() if r.content else {}
    except requests.RequestException:
        raise RuntimeError('GitHub temporarily unavailable') from None


def dispatch_if_idle(workflow):
    runs = github('/actions/workflows/' + workflow + '/runs?per_page=30').get('workflow_runs', [])
    active = [r for r in runs if str(r.get('id')) != os.getenv('GITHUB_RUN_ID') and r.get('status') in ('queued', 'in_progress', 'waiting', 'requested', 'pending')]
    if active:
        print('DISPATCH_SKIP:', workflow, 'active', active[0]['id'], flush=True)
        return False
    github('/actions/workflows/' + workflow + '/dispatches', 'POST', {'ref': 'main'})
    print('DISPATCH_ACCEPTED:', workflow, flush=True)
    return True


def sync_git():
    """Read latest remote data; never overwrite code or reset the checkout."""
    fetched = subprocess.run(['git', 'fetch', 'origin', 'main'], capture_output=True, timeout=25)
    if fetched.returncode:
        raise RuntimeError('Git queue refresh failed')
    # state.load and deal_queue.load already merge origin/main in memory.
    # Writing them here would leave unrelated dirty files and prevent rebase.


def tick(forced_request=None, dispatch_search=True):
    settings = config.load_settings()
    client.refresh(settings)
    config.apply(settings)
    data = state.load(config.STATE_FILE)
    data['queue'] = deal_queue.load(config.QUEUE_FILE)
    before_ids = {item['id'] for item in data['queue']}
    snapshot = client.runtime('snapshot')
    client.merge_runtime(data, snapshot)
    consumed = {(r['kind'], r['request_id']) for r in snapshot.get('consumed_requests') or []}
    request = forced_request or settings.get('schedule_post_request')
    if request and ('post', request) in consumed:
        request = None
    post_error = ''
    if request or scheduling.post_due(settings, data):
        # bot.main persists Telegram result/queue using the established merge path.
        if request:
            settings['schedule_post_request'] = request
        published = bot.run_posting(data, settings, request_id=request)
        if published or data.get('meta', {}).get('last_run'):
            data['queue'] = deal_queue.save(config.QUEUE_FILE, data['queue'], data['posted'])
            removed = before_ids - {item['id'] for item in data['queue']}
            bot.commit_queue(config.QUEUE_FILE, data['queue'], data['posted'], removed)
            state.save(config.STATE_FILE, data)
            bot.commit_state(config.STATE_FILE, data)
        print('TELEGRAM_CYCLE:', 'SUCCESS' if published else 'SKIPPED', published, flush=True)
        if not published:
            errors = data.get('meta', {}).get('errors') or []
            post_error = str(errors[-1].get('msg', '')) if errors else 'Нет подходящего товара в очереди либо сработала защита частоты'
    search_request = settings.get('schedule_search_request')
    manual_search = bool(search_request and ('search', search_request) not in consumed)
    scan_due = manual_search or scheduling.search_due(settings, data, len(data['queue']))
    if dispatch_search and scan_due and not snapshot.get('scan_running'):
        dispatch_if_idle('scanner.yml')
    schedule = scheduling.normalize(settings)
    now = int(time.time())
    zone = ZoneInfo(schedule['timezone'])
    posts = data.get('recent') or []
    today = datetime.fromtimestamp(now, zone).date()
    slots = scheduling.next_posts(settings, data, now=now)
    status = {
        'heartbeat': now, 'revision': settings['_schedule_revision'],
        'next_posts': slots, 'next_post': slots[0] if slots else 0,
        'next_search': scheduling.next_search(settings, data, len(data['queue']), now) or 0,
        'queue_size': len(data['queue']), 'new_today': snapshot.get('new_today', 0),
        'last_scan_attempt': snapshot.get('last_scan_attempt', 0),
        'last_scan_success': snapshot.get('last_scan_success', 0),
        'last_scan_error': snapshot.get('last_scan_error', ''),
        'last_post': max((int(r.get('ts', 0)) for r in posts), default=0),
        'posted_today': sum(datetime.fromtimestamp(int(r.get('ts', 0)), zone).date() == today for r in posts),
        'posts_hour': sum(now - 3600 < int(r.get('ts', 0)) <= now for r in posts),
        'scan_running': bool(snapshot.get('scan_running')), 'post_running': False,
        'error': post_error,
    }
    client.api('status', 'PUT', status)
    print('SCHEDULER:', 'queue', status['queue_size'], 'next_post', status['next_post'],
          'next_search', status['next_search'], 'revision', status['revision'], flush=True)
    return status


def main():
    if not client.enabled():
        raise RuntimeError('WB_SCHEDULER_ENABLED must be enabled explicitly')
    forced = ('dispatch-' + os.getenv('GITHUB_RUN_ID', str(int(time.time())))) if config.FORCE_POST else None
    if '--once' in sys.argv:
        sync_git()
        tick(forced, dispatch_search=False)
        return
    deadline = time.monotonic() + int(os.getenv('WB_SCHEDULER_SECONDS', '3000'))
    last_sync = 0
    while time.monotonic() < deadline:
        try:
            if time.monotonic() - last_sync >= 90:
                sync_git()
                last_sync = time.monotonic()
            tick(forced)
        except Exception as exc:
            print('SCHEDULER_ERROR:', type(exc).__name__, str(exc)[:160], flush=True)
            try:
                client.api('status', 'PUT', {'error': str(exc)[:160]})
            except RuntimeError:
                pass
        time.sleep(min(25, max(0, deadline - time.monotonic())))


if __name__ == '__main__':
    if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    main()
