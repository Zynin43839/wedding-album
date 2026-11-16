#!/usr/bin/env python3
"""r2_delete.py - one place that deletes R2 objects, two engines.

The album cleanup used to call `npx wrangler r2 object delete` once per object.
Measured on this machine: 4.85 s and ~5 process creations per call, so the 701
keys of a full album wipe meant ~3,500 process creations and a frozen laptop.

Engines
-------
bulk     boto3 DeleteObjects against the R2 S3 endpoint. Up to 1000 keys per
         request, so a whole album is one round trip (~1-3 s, one process).
         Needs R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.
single   `node node_modules/wrangler/bin/wrangler.js r2 object delete`
         (2.42 s, 2 processes - never `npx`, which adds the npm wrapper).
         Works against `--local` (the Miniflare store) and needs no new secret.

`delete_keys()` picks the engine from the job size, so small edits stay
dependency-free and big wipes never turn into a process storm.

Credentials are read from the environment first, then from `.dev.vars`
(`.dev.vars` must stay out of git).
"""
from __future__ import annotations

import os
import pathlib
import subprocess
import sys
import time
from dataclasses import dataclass, field

BUCKET = "wedding-album-media"
BULK_LIMIT = 1000  # S3 DeleteObjects hard cap
CRED_KEYS = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")


class CredentialMissing(RuntimeError):
    """Raised when bulk mode is requested but no R2 S3 credential is present."""


@dataclass
class DeleteResult:
    engine: str
    requested: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    errors: list[tuple[str, str]] = field(default_factory=list)
    dry_run: bool = False
    elapsed: float = 0.0

    @property
    def ok(self) -> bool:
        return not self.errors

    def summary(self) -> str:
        tag = "would delete" if self.dry_run else "deleted"
        head = f"{tag} {len(self.deleted)}/{len(self.requested)} objects via {self.engine}"
        if self.errors:
            head += f" - {len(self.errors)} failed"
        return f"{head} in {self.elapsed:.2f} s"


# --- credentials -----------------------------------------------------------
def load_credentials(root: pathlib.Path) -> dict[str, str] | None:
    """R2 S3 credential from the environment, else from `<root>/.dev.vars`."""
    found = {k: os.environ.get(k, "") for k in CRED_KEYS}
    if all(found.values()):
        return found

    dev_vars = root / ".dev.vars"
    if dev_vars.is_file():
        for raw in dev_vars.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            if key in CRED_KEYS and not found.get(key):
                found[key] = value.strip().strip('"').strip("'")
    return found if all(found.values()) else None


def credential_help() -> str:
    return (
        "Bulk mode needs an R2 S3 token (different from the wrangler OAuth login).\n"
        "  1. Cloudflare Dashboard -> R2 -> Manage API Tokens -> Create API Token\n"
        "     Permission: Object Read & Write, bucket: wedding-album-media\n"
        "  2. Put these three lines in wedding-album/.dev.vars (never in git):\n"
        "       R2_ACCOUNT_ID=<account id from `wrangler whoami`>\n"
        "       R2_ACCESS_KEY_ID=<access key id>\n"
        "       R2_SECRET_ACCESS_KEY=<secret access key>\n"
        "  Until then, use --engine wrangler (slow but needs no new secret)."
    )


# --- engine: bulk (boto3) --------------------------------------------------
def bulk_delete(keys: list[str],
                creds: dict[str, str],
                bucket: str = BUCKET,
                dry_run: bool = False) -> DeleteResult:
    """Delete up to `BULK_LIMIT` keys per request through the R2 S3 API."""
    started = time.perf_counter()
    result = DeleteResult(engine="bulk", requested=list(keys), dry_run=dry_run)
    if dry_run:
        result.deleted = list(keys)
        result.elapsed = time.perf_counter() - started
        return result

    import boto3  # imported lazily so `--engine wrangler` needs no boto3
    from botocore.config import Config

    client = boto3.client(
        "s3",
        endpoint_url=f"https://{creds['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=creds["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=creds["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=Config(retries={"max_attempts": 5, "mode": "standard"},
                      signature_version="s3v4"),
    )

    for start in range(0, len(keys), BULK_LIMIT):
        chunk = keys[start:start + BULK_LIMIT]
        resp = client.delete_objects(
            Bucket=bucket,
            Delete={"Objects": [{"Key": k} for k in chunk], "Quiet": False},
        )
        result.deleted.extend(obj["Key"] for obj in resp.get("Deleted", []))
        for err in resp.get("Errors", []):
            result.errors.append((err.get("Key", "?"), f"{err.get('Code')}: {err.get('Message')}"))

    result.elapsed = time.perf_counter() - started
    return result


# --- engine: single (wrangler, no npx) -------------------------------------
def wrangler_bin(root: pathlib.Path) -> pathlib.Path:
    path = root / "node_modules" / "wrangler" / "bin" / "wrangler.js"
    if not path.is_file():
        raise FileNotFoundError(f"wrangler not installed at {path} - run `npm install`")
    return path


def single_delete(key: str,
                  root: pathlib.Path,
                  bucket: str = BUCKET,
                  local: bool = False,
                  dry_run: bool = False) -> bool:
    """Delete one object by running the local wrangler binary directly.

    Verified 2026-11-16: wrangler exits 0 and prints "Delete complete." even when
    the key does not exist, so the return value means "the call did not fail",
    never "an object existed and is gone". R2 deletes are idempotent. Confirm the
    outcome by re-listing (clean_album.py does this at the end); the bulk engine
    is the only one that returns a per-key Deleted[] from the service.
    """
    if dry_run:
        return True
    cmd = ["node", str(wrangler_bin(root)), "r2", "object", "delete", f"{bucket}/{key}",
           "--local" if local else "--remote"]
    proc = subprocess.run(cmd, capture_output=True, text=True, shell=False,
                          encoding="utf-8", errors="replace")
    blob = ((proc.stdout or "") + (proc.stderr or "")).upper()
    return proc.returncode == 0 and "ERROR" not in blob


# --- engine selection ------------------------------------------------------
def delete_keys(keys: list[str],
                root: pathlib.Path,
                *,
                local: bool = False,
                dry_run: bool = False,
                threshold: int = 20,
                engine: str = "auto",
                bucket: str = BUCKET,
                guard=None) -> DeleteResult:
    """Delete `keys` with the cheapest safe engine.

    engine="auto"  -> bulk when the job is large and a credential exists,
                      otherwise direct wrangler (small jobs, `--local`).
    engine="bulk"  -> force S3 API (raises CredentialMissing without a token).
    engine="wrangler" -> force per-object wrangler calls under the guard.
    """
    keys = list(dict.fromkeys(k for k in keys if k))
    if not keys:
        return DeleteResult(engine="none")

    creds = None if local else load_credentials(root)
    chosen = engine
    if engine == "auto":
        chosen = "bulk" if (len(keys) > threshold and creds) else "wrangler"
    if chosen == "bulk" and local:
        print("[r2] --local has no S3 endpoint; falling back to wrangler", flush=True)
        chosen = "wrangler"
    if chosen == "bulk" and not creds:
        raise CredentialMissing(credential_help())

    if chosen == "bulk":
        return bulk_delete(keys, creds, bucket=bucket, dry_run=dry_run)

    started = time.perf_counter()
    result = DeleteResult(engine="wrangler", requested=keys, dry_run=dry_run)

    def one(key: str) -> bool:
        try:
            return single_delete(key, root, bucket=bucket, local=local, dry_run=dry_run)
        except Exception as exc:  # noqa: BLE001
            result.errors.append((key, str(exc)))
            return False

    def show(pos: int, ok: object) -> None:
        mark = "OK  " if ok else "FAIL"
        print(f"  [{pos:>4}/{len(keys)}] {mark} {keys[pos - 1]}", flush=True)

    if guard is not None:
        outcomes = guard.run(keys, one, on_result=show)
    else:
        outcomes = [one(k) for k in keys]

    for key, ok in zip(keys, outcomes):
        if ok:
            result.deleted.append(key)
    result.elapsed = time.perf_counter() - started
    return result


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 0
    root = pathlib.Path(__file__).resolve().parents[1]
    print(f"root      : {root}")
    creds = load_credentials(root)
    print(f"bulk creds: {'present' if creds else 'MISSING'}")
    print(f"engine now: {'bulk (boto3)' if creds else 'wrangler (direct node)'}")
    if not creds:
        print()
        print(credential_help())
    return 0


if __name__ == "__main__":
    sys.exit(main())
