"""Read-only production scheduler verification using existing Actions secrets."""
import json
import sys

import scheduler_client as client
import scheduling


def main():
    settings = client.refresh({})
    snapshot = client.runtime('snapshot')
    data = client.merge_runtime({'recent': [], 'meta': {}}, snapshot)
    schedule = scheduling.validate(settings)
    slots = scheduling.next_posts(settings, data)
    result = {'CONFIG_AUTH': 'OK', 'RUNTIME': 'OK',
              'STORAGE': 'Cloudflare D1', 'revision': settings['_schedule_revision'],
              'POSTING': 'ON' if schedule['enabled'] and not schedule['paused'] else 'PAUSED',
              'WB_SEARCH': 'ON' if schedule['search_enabled'] else 'OFF',
              'QUEUE': snapshot.get('queue_size', 0), 'NEW_TODAY': snapshot.get('new_today', 0),
              'LAST_POST': snapshot.get('last_post', 0), 'NEXT_POSTS': slots,
              'NEXT_SEARCH': scheduling.next_search(settings, data, snapshot.get('queue_size', 0)),
              'STATUS': settings.get('_schedule_status', {})}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('SCHEDULER_PROBE_ERROR:', type(exc).__name__, str(exc)[:120])
        sys.exit(1)
