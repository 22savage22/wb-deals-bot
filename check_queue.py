import json

q = json.load(open('queue.json', 'r', encoding='utf-8'))
seen = {}
for i, item in enumerate(q):
    pid = item.get('id')
    title = item.get('title', '')
    norm = "".join(ch for ch in title.lower() if ch.isalnum())
    if norm in seen:
        prev = seen[norm]
        print(f"DUPE in queue: {pid} == {prev[0]}")
        print(f"  {title[:60]}")
    else:
        seen[norm] = (pid, title)

print(f"\nQueue: {len(q)} items, {len(seen)} unique by title")
