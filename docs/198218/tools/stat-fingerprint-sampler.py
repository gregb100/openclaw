#!/usr/bin/env python3
"""Sample the SQLite artifact-family fingerprint that the admission cache keys on.

The cache in src/state/openclaw-state-db-content-version.ts builds
dev:ino:size:mtimeNs:ctimeNs for <db>, <db>-wal and <db>-journal. If any of those
values change between two admission guards, the cache misses and the whole artifact
family is hashed again. This tool measures that volatility directly.

Safety: refuses to sample a database under ~/.openclaw unless --allow-live is passed.

Usage:
  stat-fingerprint-sampler.py --db /tmp/copy/openclaw.sqlite --seconds 10
  stat-fingerprint-sampler.py --db /tmp/copy/openclaw.sqlite --seconds 10 --write-every 5

Exit codes: 0 if at least one fingerprint change was observed, 1 if none, 2 on refusal.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

SUFFIXES = ("", "-wal", "-journal")


def tuple_for(path: Path) -> str:
    st = os.lstat(path)
    return f"{st.st_dev}:{st.st_ino}:{st.st_size}:{st.st_mtime_ns}:{st.st_ctime_ns}"


def family(db: Path) -> dict:
    out = {}
    for suffix in SUFFIXES:
        candidate = Path(str(db) + suffix)
        try:
            out[suffix or "(db)"] = tuple_for(candidate)
        except FileNotFoundError:
            out[suffix or "(db)"] = "absent"
    return out


def force_write(db: Path) -> None:
    """Commit one row so the artifact family changes. Used to prove invalidation."""
    con = sqlite3.connect(str(db), timeout=5)
    try:
        con.execute("create table if not exists _fingerprint_probe (id integer primary key)")
        con.execute("insert into _fingerprint_probe default values")
        con.commit()
    finally:
        con.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--seconds", type=float, default=10.0)
    parser.add_argument("--interval-ms", type=int, default=100)
    parser.add_argument("--write-every", type=int, default=0,
                        help="commit a probe row every N samples (0 disables)")
    parser.add_argument("--allow-live", action="store_true")
    args = parser.parse_args()

    db = args.db.resolve()
    if not db.exists():
        print("error: no such database: %s" % db, file=sys.stderr)
        return 2

    live_root = Path.home() / ".openclaw"
    if not args.allow_live and str(db).startswith(str(live_root)):
        print("refused: this database is under the live state root. "
              "Copy it first, or pass --allow-live if you accept the risk.", file=sys.stderr)
        return 2

    start = time.monotonic()
    deadline = start + args.seconds
    interval = max(args.interval_ms, 1) / 1000.0
    previous = family(db)
    changes = []
    samples = 0

    print("# sampling %s every %d ms for %gs" % (db, args.interval_ms, args.seconds), file=sys.stderr)
    while time.monotonic() < deadline:
        if args.write_every and samples and samples % args.write_every == 0:
            force_write(db)
        current = family(db)
        samples += 1
        for part, value in current.items():
            if previous.get(part) != value:
                changes.append({
                    "t_ms": round((time.monotonic() - start) * 1000),
                    "part": part,
                    "before": previous.get(part),
                    "after": value,
                })
        previous = current
        time.sleep(interval)

    result = {
        "db": str(db),
        "samples": samples,
        "changes": len(changes),
        "changed_parts": sorted({str(c["part"]) for c in changes}),
        "first_changes": changes[:5],
        "formula": "changes = count over samples of (fingerprint_t != fingerprint_t-1)",
    }
    print(json.dumps(result, indent=2))
    return 0 if changes else 1


if __name__ == "__main__":
    sys.exit(main())
