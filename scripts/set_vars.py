"""Set the archive knobs in wrangler.toml without fighting PowerShell quoting.

  python scripts/set_vars.py --min-batch 25 --on-fail requeue --concurrency 4
"""
import argparse
import pathlib
import re

ap = argparse.ArgumentParser()
ap.add_argument("--min-batch", default="25")
ap.add_argument("--on-fail", default="requeue", choices=["requeue", "skip"])
ap.add_argument("--concurrency", default="4")
args = ap.parse_args()

p = pathlib.Path(r"C:\Users\TEEREDCOM\Desktop\Work\อิสระ\wedding-album\wrangler.toml")
t = p.read_text(encoding="utf-8")

block = (
    f'SYNC_MIN_BATCH  = "{args.min_batch}"\n'
    f'SYNC_ON_FAIL    = "{args.on_fail}"\n'
    f'SYNC_CONCURRENCY = "{args.concurrency}"\n'
)

t = re.sub(r'(?:^SYNC_MIN_BATCH.*\n|^SYNC_ON_FAIL.*\n|^SYNC_CONCURRENCY.*\n)+', '', t, flags=re.M)
t = re.sub(r'^DRIVE_FOLDER_ID', block + 'DRIVE_FOLDER_ID', t, count=1, flags=re.M)

p.write_text(t, encoding="utf-8")
for line in t.splitlines():
    if line.startswith(("SYNC_", "DRIVE_FOLDER_ID")):
        print(line)
