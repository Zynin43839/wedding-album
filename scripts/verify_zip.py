"""Validate a ZIP archive with Python's zipfile.

Usage:
  python scripts/verify_zip.py              # checks the fixture archive from zip_test.mjs
  python scripts/verify_zip.py <path.zip>   # generic structural check
"""
import pathlib
import sys
import tempfile
import zipfile

root = pathlib.Path(__file__).resolve().parents[1]
generic = len(sys.argv) > 1
archive = (
    pathlib.Path(sys.argv[1])
    if generic
    else pathlib.Path(tempfile.gettempdir()) / "opencode" / "wedding-album" / "zip-test.zip"
)

if not archive.exists():
    print(f"FAIL: {archive} not found")
    sys.exit(1)

fixture = {
    "0001-สมชาย.jpg": 20 * 500,
    "0002-Ann.mp4": 2004,
}

failures = []

with zipfile.ZipFile(archive) as zf:
    bad = zf.testzip()
    if bad is not None:
        failures.append(f"CRC failed on {bad}")

    names = zf.namelist()
    total = sum(zf.getinfo(n).file_size for n in names)
    print(f"archive   : {archive.name} ({archive.stat().st_size} bytes on disk)")
    print(f"entries   : {len(names)}")
    print(f"total data: {total} bytes")
    for n in names[:8]:
        print(f"  - {n} ({zf.getinfo(n).file_size} bytes)")
    if len(names) > 8:
        print(f"  ... +{len(names) - 8} more")

    if not names:
        failures.append("archive is empty")

    for name, size in fixture.items():
        if generic:
            break
        if name not in names:
            failures.append(f"entry not found: {name}")
            continue
        if zf.getinfo(name).file_size != size:
            failures.append(f"{name}: size mismatch")
        if not zf.read(name):
            failures.append(f"{name}: empty on read")

    if not generic:
        if "0003-missing.jpg" in names:
            failures.append("missing file should have been skipped, not stored")
        if not zf.read("0001-สมชาย.jpg").startswith(b"hello wedding album"):
            failures.append("0001 content mismatch")

print()
if failures:
    for f in failures:
        print("FAIL:", f)
    sys.exit(1)

print("RESULT: PASS — archive valid, CRC ok, UTF-8 names intact")
