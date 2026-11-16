"""Print the current album listing in a compact table (ops helper).

Usage: python scripts/list_items.py [base_url] [code]
"""
import json
import sys
import urllib.parse
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
CODE = sys.argv[2] if len(sys.argv) > 2 else "demo-code"

url = f"{BASE}/api/list?{urllib.parse.urlencode({'e': CODE})}"
with urllib.request.urlopen(url, timeout=30) as r:
    data = json.loads(r.read())

items = data["items"]
print(f"items: {data['count']}  cursor: {data['cursor'] or '-'}")
print(f"{'type':6} {'size KB':>9} {'guest':14} url")
print("-" * 78)
for it in items[:20]:
    print(f"{it['type']:6} {it['size'] / 1024:9.1f} {it['guest'][:14]:14} {it['url']}")

by_guest = {}
for it in items:
    by_guest.setdefault(it["guest"], [0, 0])
    by_guest[it["guest"]][0] += 1
    by_guest[it["guest"]][1] += it["size"]

print()
print("per guest:")
for g, (n, s) in sorted(by_guest.items(), key=lambda kv: -kv[1][1])[:10]:
    print(f"  {g[:20]:22} {n:4} items  {s / 1024 / 1024:7.1f} MB")
