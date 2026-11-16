"""Upload one chunk of the 5 GB archive test, with per-file progress.

Chunked on purpose: the shell reports output only when a command finishes, so a
600-file upload is split into runs of ~100 files and each run prints progress.

  python fiveg_upload.py --start 0 --count 100
"""
import argparse
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://wedding-album.rj-wedding.workers.dev"
CODE = "demo-code"
STATE = pathlib.Path(os.environ["TEMP"]) / "opencode" / "fiveg_stamp.txt"
UA = {"user-agent": "Mozilla/5.0"}


def upload(ident: str, data: bytes, ctype: str, kind: str) -> tuple[int, float]:
    q = urllib.parse.urlencode(
        {"e": CODE, "kind": kind, "id": ident, "name": "FIVEGB", "ext": "jpg"}
    )
    req = urllib.request.Request(
        f"{BASE}/api/upload?{q}",
        data=data,
        method="POST",
        headers={**UA, "content-type": ctype},
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            r.read()
            return r.status, time.perf_counter() - t0
    except urllib.error.HTTPError as e:
        e.read()
        return e.code, time.perf_counter() - t0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, required=True)
    ap.add_argument("--count", type=int, required=True)
    ap.add_argument("--size-mb", type=float, default=8.5)
    args = ap.parse_args()

    if STATE.exists():
        stamp = STATE.read_text().strip()
    else:
        stamp = str(int(time.time()))
        STATE.write_text(stamp)

    size = int(args.size_mb * 1024 * 1024)
    payload = os.urandom(size)
    print(f"chunk start={args.start} count={args.count} size={args.size_mb} MB stamp={stamp}")

    ok = fail = 0
    t_chunk = time.perf_counter()
    for i in range(args.start, args.start + args.count):
        ident = f"fiveg{stamp}-{i:04d}"
        st, dt = upload(ident, payload, "image/jpeg", "photo")
        if st == 200:
            ok += 1
        else:
            fail += 1
            print(f"  [{i}] HTTP {st}")
        if (i - args.start + 1) % 10 == 0:
            done = i - args.start + 1
            mb = done * args.size_mb
            el = time.perf_counter() - t_chunk
            print(f"  [{done}/{args.count}] {mb:.0f} MB · {mb/el:.2f} MB/s", flush=True)

    el = time.perf_counter() - t_chunk
    print(f"chunk done: {ok} ok, {fail} failed, {ok*args.size_mb:.0f} MB in {el:.0f}s ({ok*args.size_mb/el:.2f} MB/s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
