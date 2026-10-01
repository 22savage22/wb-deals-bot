"""Bounded, authenticated access to the existing D1 scheduler (no new secret)."""
import contextvars
import os
import time
import uuid
from contextlib import contextmanager

import requests

import scheduling

_session = contextvars.ContextVar('posting_session', default=None)


def enabled():
    return os.getenv('WB_SCHEDULER_ENABLED') == '1'


def api(path, method='GET', payload=None):
    url = os.getenv('MINIAPP_API_URL', '').rstrip('/')
    key = os.getenv('MINIAPP_SYNC_KEY', '')
    if not url or not key:
        raise RuntimeError('Scheduler configuration unavailable')
    try:
        response = requests.request(method, url + '/api/scheduler/' + path,
                                    headers={'Authorization': 'Bearer ' + key},
                                    json=payload, timeout=(5, 12))
        if response.status_code == 409:
            return {'conflict': True}
        if response.status_code != 200:
            raise RuntimeError('Scheduler HTTP ' + str(response.status_code))
        result = response.json()
        if not isinstance(result, dict):
            raise RuntimeError('Scheduler invalid response')
        return result
    except requests.RequestException:
        # requests exception text can contain URL/query/header credentials.
        raise RuntimeError('Scheduler network unavailable') from None


def runtime(op, **values):
    return api('runtime', 'POST', {'op': op, **values})


def refresh(settings):
    result = api('config')
    schedule = scheduling.validate(result['schedule'])
    settings['schedule'] = schedule
    settings['_schedule_base'] = dict(schedule)
    settings['_schedule_revision'] = result['revision']
    settings['_schedule_status'] = result.get('status') or {}
    for kind in ('post', 'search'):
        settings['schedule_' + kind + '_request'] = result.get(kind + '_request') or ''
    return settings


def push(settings):
    """CAS, merging only fields actually changed by the Telegram admin."""
    desired = scheduling.validate(settings)
    baseline = settings.get('_schedule_base') or desired
    delta = {k: v for k, v in desired.items() if baseline.get(k) != v}
    actions = {kind: settings.get('schedule_' + kind + '_request') for kind in ('post', 'search')}
    if delta:
        for attempt in range(3):
            result = api('config', 'PUT', {'schedule': desired, 'revision': settings.get('_schedule_revision', 0)})
            if not result.get('conflict'):
                break
            refresh(settings)
            desired = {**settings['schedule'], **delta}
        else:
            raise RuntimeError('Schedule concurrently changed; retry update')
    for kind, request_id in actions.items():
        if request_id:
            api('action', 'POST', {'action': kind + '_now', 'request_id': request_id})
    return refresh(settings)


def merge_runtime(data, snapshot):
    recent = data.setdefault('recent', [])
    for row in snapshot.get('posts') or []:
        match = next((r for r in recent if r.get('pid') == row.get('pid') and abs(int(r.get('ts', 0)) - int(row.get('ts', 0))) < 60), None)
        if match is None:
            recent.append(row)
        else:
            match['ts'] = max(int(match['ts']), int(row['ts']))
        if row.get('pid'):
            data.setdefault('posted', {})[int(row['pid'])] = int(row['ts'])
    meta = data.setdefault('meta', {})
    for key in ('last_scan_attempt', 'last_scan_success', 'last_scan_error', 'new_today', 'new_day'):
        if snapshot.get(key) is not None:
            meta[key] = snapshot[key]
    if snapshot.get('last_post'):
        meta['scheduler_last_post'] = snapshot['last_post']
    data['recent'] = sorted(recent, key=lambda r: r.get('ts', 0))
    return data


@contextmanager
def lease(kind, ttl=900):
    owner = str(uuid.uuid4())
    acquired = runtime('acquire', kind=kind, owner=owner, ttl=ttl).get('ok', False)
    try:
        yield owner if acquired else None
    finally:
        if acquired:
            try:
                runtime('release', kind=kind, owner=owner)
            except RuntimeError:
                # Lease expires; do not hide the original posting error.
                pass


@contextmanager
def posting_session(settings, data, request_id=None):
    if not enabled():
        yield True
        return
    with lease('post') as owner:
        if not owner:
            yield False
            return
        refresh(settings)
        snapshot = runtime('snapshot')
        merge_runtime(data, snapshot)
        # Manual request bypasses pause/time windows, never safety caps/gap.
        if not request_id and not scheduling.post_due(settings, data):
            yield False
            return
        if request_id and not runtime('consume', kind='post', owner=owner, request_id=request_id).get('ok'):
            yield False
            return
        token = _session.set({'owner': owner, 'schedule': scheduling.normalize(settings), 'request_id': request_id,
                              'settings': settings, 'data': data})
        try:
            yield True
        finally:
            _session.reset(token)


def send_guarded(pid, send):
    if not enabled():
        return send()
    session = _session.get()
    if session is None:
        # A preview's Publish action is also globally serialized.
        settings, data = {}, {'recent': []}
        with posting_session(settings, data, 'preview-' + str(uuid.uuid4())) as allowed:
            return send_guarded(pid, send) if allowed else False
    owner, schedule = session['owner'], session['schedule']
    # A pause/quiet-hour edit while photos were downloading applies before send.
    refresh(session['settings'])
    schedule = scheduling.normalize(session['settings'])
    if not session.get('request_id') and not scheduling.post_due(session['settings'], session['data']):
        return False
    if not runtime('renew', kind='post', owner=owner, ttl=900).get('ok'):
        return False
    claim = runtime('claim', owner=owner, product_id=int(pid),
                    min_gap_minutes=schedule['min_post_gap_minutes'],
                    max_hour=schedule['max_posts_hour'], max_day=schedule['max_posts_day'],
                    timezone=schedule['timezone'], repost_days=7,
                    request_id=session.get('request_id'))
    if not claim.get('ok'):
        print('POST_SKIP:', claim.get('reason', 'claim_rejected'), 'nmId', pid, flush=True)
        return False
    success = False
    try:
        success = bool(send())
        return success
    finally:
        # Claim remains after ambiguous failure; never resend a possibly accepted post.
        runtime('complete', owner=owner, product_id=int(pid), success=success,
                request_id=session.get('request_id'))
