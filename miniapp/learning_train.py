"""Bounded River SHADOW job. No posting, pickle, user IDs, or runtime CF token."""
import json
import os
from pathlib import Path
import requests
from river import linear_model, optim


def vector(features):
    return {key if isinstance(value, (int, float)) else key + '=' + str(value):
            value if isinstance(value, (int, float)) else 1
            for key, value in features.items()}


def train(batch):
    previous = batch['model']
    model = linear_model.LogisticRegression(optimizer=optim.SGD(.03), l2=.001)
    model._weights.update(previous.get('weights', {}))
    model.intercept = previous.get('intercept', 0)
    comparison = dict(previous.get('comparison') or {})
    comparison.setdefault('n', 0)
    comparison.setdefault('legacy_brier', 0)
    comparison.setdefault('river_brier', 0)
    comparison.setdefault('posts', [])
    shadows = {row['pid']: row for row in batch['shadows']}
    cursor = previous.get('cursor', 0)
    trained = previous.get('trained_events', 0)
    for event in batch['events']:
        x = vector(json.loads(event['features']))
        y = event['kind'] != 'dislike'
        # Prequential assessment uses the probability recorded BEFORE delivery.
        # Never invent audience feedback for an unpublished counterfactual item.
        shadow = shadows.get(event['pid'])
        if shadow and event['ts'] >= shadow['ts'] and event['kind'] in ('like', 'dislike'):
            n = min(1000, event['weight'])
            legacy_error = (shadow['legacy_p'] - int(y)) ** 2
            river_error = (shadow['river_p'] - int(y)) ** 2
            # New paired observations only; do not invent missing old metrics.
            for key in ('paired_observations', 'positive', 'negative', 'wins',
                        'losses', 'ties', 'legacy_sum', 'river_sum'):
                comparison.setdefault(key, 0)
            comparison['paired_observations'] += n
            comparison['positive' if y else 'negative'] += n
            verdict = ('ties' if abs(legacy_error - river_error) < 1e-9 else
                       'wins' if river_error < legacy_error else 'losses')
            comparison[verdict] += n
            comparison['legacy_sum'] += n * shadow['legacy_p']
            comparison['river_sum'] += n * shadow['river_p']
            comparison['last_observation'] = {
                'pid': event['pid'], 'ts': event['ts'],
                'legacy': shadow['legacy_p'], 'river': shadow['river_p'],
                'actual': 'like' if y else 'dislike'}
            comparison['n'] += n
            comparison['legacy_brier'] += n * (shadow['legacy_p'] - int(y)) ** 2
            comparison['river_brier'] += n * (shadow['river_p'] - int(y)) ** 2
            comparison['first_ts'] = min(comparison.get('first_ts') or event['ts'], event['ts'])
            comparison['posts'] = list(set(comparison['posts']) | {event['pid']})[-1000:]
        # Cap repeated aggregate observations; weak implicit signals stay weaker.
        strength = {'click': .1, 'save': .3, 'buy': .8}.get(event['kind'], 1)
        for _ in range(min(20, max(1, int(event['weight'])))):
            model.learn_one(x, y, w=strength)
        trained += 1
        cursor = event['id']
    return {**previous, 'version': 1, 'weights': dict(model.weights),
            'intercept': model.intercept, 'cursor': cursor,
            'trained_events': trained, 'comparison': comparison}


def main():
    root = os.environ['MINIAPP_API_URL'].rstrip('/')
    key = os.environ['MINIAPP_SYNC_KEY']
    def api(path, method='GET', body=None):
        result = requests.request(method, root + '/api/scheduler/learning/' + path,
                                  headers={'Authorization': 'Bearer ' + key}, json=body,
                                  timeout=(5, 20))
        if result.status_code != 200:
            raise RuntimeError('Learning HTTP ' + str(result.status_code))
        return result.json()
    # Import only aggregate feedback. Existing heuristic state remains untouched.
    data = json.loads(Path('state.json').read_text(encoding='utf-8'))
    rows = [{'pid': int(pid), **{k: fb.get(k, 0) for k in ('likes', 'dislikes', 'bought', 'ts')}}
            for pid, fb in data.get('feedback', {}).items()]
    # Rotate bounded imports across runs, not an unbounded full-history D1 scan.
    import time
    start = (int(time.time()) // 1200 * 20) % max(1, len(rows))
    selected = (rows + rows)[start:start + min(20, len(rows))]
    if selected:
        api('feedback', 'POST', {'rows': selected})
    batch = api('train')
    if batch['config']['mode'] == 'LEGACY':
        print('RIVER_LEGACY model unchanged; publication chooser unchanged')
        return
    result = train(batch)
    api('train', 'PUT', {'previous_cursor': batch['model']['cursor'], 'model': result})
    print('RIVER_SHADOW_OK', json.dumps({'cursor': result['cursor'], 'trained_events': result['trained_events'], 'comparison_samples': result['comparison']['n'], 'publication_control': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Exception messages from HTTP libraries can contain credentials.
        print('RIVER_SHADOW_ERROR', type(exc).__name__)
        raise SystemExit(1)
