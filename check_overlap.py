import json

d = json.load(open('state.json', 'r', encoding='utf-8'))
q = json.load(open('queue.json', 'r', encoding='utf-8'))

posted_ids = set(d.get('posted', {}).keys())
queue_ids = set(item.get('id') for item in q)
overlap = posted_ids & queue_ids
print(f"Posted: {len(posted_ids)}, Queue: {len(queue_ids)}, Overlap: {len(overlap)}")
if overlap:
    for pid in list(overlap)[:5]:
        print(f"  Overlap PID: {pid}")

recent_ids = set(r['pid'] for r in d.get('recent', []))
recent_and_queue = recent_ids & queue_ids
print(f"\nRecent & Queue overlap: {len(recent_and_queue)}")
if recent_and_queue:
    for pid in list(recent_and_queue)[:5]:
        print(f"  PID: {pid}")
