"""Point DRIVE_FOLDER_ID at the test folder (or back to the real one).

Written as a file because inline Python in PowerShell mangles the quotes.
  python set_folder.py --id 1Kcby...      # test folder
  python set_folder.py                    # back to the wedding folder
"""
import argparse
import pathlib
import re

REAL = "YOUR_DRIVE_FOLDER_ID"
TEST = "1KcbyX48F-7GzZxk6mcrHM-BFIG8iX_j3"

ap = argparse.ArgumentParser()
ap.add_argument("--id", default=REAL)
args = ap.parse_args()

p = pathlib.Path(r"C:\Users\TEEREDCOM\Desktop\Work\อิสระ\wedding-album\wrangler.toml")
t = p.read_text(encoding="utf-8")
new, n = re.subn(r'^DRIVE_FOLDER_ID = ".*"$', f'DRIVE_FOLDER_ID = "{args.id}"', t, flags=re.M)
if n != 1:
    raise SystemExit(f"expected exactly one DRIVE_FOLDER_ID line, found {n}")
p.write_text(new, encoding="utf-8")
print(f"DRIVE_FOLDER_ID = {args.id}  ({'test folder' if args.id == TEST else 'wedding folder'})")
