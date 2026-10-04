"""Legacy command bridge; production votes remain authoritative in Worker/D1."""
import os
import time
import scheduler_client
_next_poll = 0.0

def enabled():
    return bool(os.getenv('MINIAPP_API_URL') and os.getenv('MINIAPP_SYNC_KEY'))

def webhook_enabled():
    return os.getenv('TG_CALLBACK_TRANSPORT') == 'worker' and enabled()

def poll_updates(data):
    global _next_poll
    if time.monotonic() < _next_poll:
        return []
    _next_poll = time.monotonic() + 30
    return scheduler_client.api('feedback/updates', 'POST', {'offset': data['tg'].get('worker_offset', 0)})['updates']

def save(cb):
    return scheduler_client.api('feedback/callback', 'POST', {'callback': cb})
