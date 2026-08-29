import json

d = json.load(open('state.json', 'r', encoding='utf-8'))
recent = d.get('recent', [])
ids = [r['pid'] for r in recent]
seen = set()
dupes = []
for pid in ids:
    if pid in seen:
        dupes.append(pid)
    seen.add(pid)
print(f"Total recent: {len(recent)}, unique: {len(seen)}, dupes: {len(dupes)}")
if dupes:
    for p in dupes[-10:]:
        print(f"  dupe PID: {p}")

titles = [r.get('title', '') for r in recent]
norm = ["".join(ch for ch in t.lower() if ch.isalnum()) for t in titles]
seen_t = set()
dupes_t = []
for i, nt in enumerate(norm):
    if nt in seen_t:
        dupes_t.append((i, recent[i]['pid'], titles[i][:50]))
    seen_t.add(nt)
print(f"\nTitle dupes: {len(dupes_t)}")
for idx, pid, t in dupes_t[-10:]:
    print(f"  idx={idx} PID={pid} title={t}")
