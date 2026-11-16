"""Scan project text files for mojibake / replacement characters.

Fails the build if U+FFFD (replacement char) or common CP1252-mangled Thai
sequences are found. Run with: python scripts/check_thai.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
EXTS = {".html", ".js", ".css", ".md", ".toml", ".json"}
SKIP = {"node_modules", ".wrangler", ".git", ".venv", "_backup", "dist", "build"}

BAD_SEQS = ["\ufffd", "à¸", "à¹", "Ã "]

bad = []
checked = 0

for p in ROOT.rglob("*"):
    if not p.is_file():
        continue
    if any(part in SKIP for part in p.parts):
        continue
    if p.suffix.lower() not in EXTS:
        continue
    checked += 1
    try:
        text = p.read_text(encoding="utf-8")
    except UnicodeDecodeError as e:
        bad.append((p, f"not valid UTF-8: {e}"))
        continue
    for seq in BAD_SEQS:
        if seq in text:
            bad.append((p, f"contains {seq!r}"))
            break

print(f"checked {checked} files")
if bad:
    for p, why in bad:
        print(f"FAIL {p.relative_to(ROOT)}: {why}")
    sys.exit(1)

# report how much Thai is present, to prove the text really landed
thai_chars = sum(
    1
    for p in ROOT.rglob("*")
    if p.is_file()
    and p.suffix.lower() in EXTS
    and not any(part in SKIP for part in p.parts)
    for ch in p.read_text(encoding="utf-8", errors="ignore")
    if "\u0e00" <= ch <= "\u0e7f"
)
print(f"thai characters found: {thai_chars}")
print("RESULT: PASS")
