#!/usr/bin/env python3
"""
Append one RIO supply snapshot to supply-history.json.

Safety: if ANY chain failed to fetch from all its endpoints (snapshot carries a
fetch_failed / TOTAL_INCOMPLETE flag), this exits non-zero WITHOUT writing, so
the CI job goes red and a wrong/too-low total is never committed. Transient
single-node failures are already absorbed by the fallback lists in fetch_supply.

Idempotent: a second run on the same UTC day replaces that day's row instead of
adding a duplicate (safe for manual re-runs).
"""
import json, os, sys
from fetch_supply import build_snapshot

HISTORY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "supply-history.json")

def main():
    snap = build_snapshot()
    bad = [f for f in snap["flags"] if f.startswith("fetch_failed") or f == "TOTAL_INCOMPLETE"]
    if bad:
        print("INCOMPLETE snapshot - NOT writing:", bad, file=sys.stderr)
        print(json.dumps(snap, indent=2), file=sys.stderr)
        sys.exit(1)

    try:
        hist = json.load(open(HISTORY))
        if not isinstance(hist, list):
            hist = []
    except (FileNotFoundError, json.JSONDecodeError):
        hist = []

    today = snap["ts"][:10]
    if hist and hist[-1]["ts"][:10] == today:
        hist[-1] = snap
        action = "replaced same-day"
    else:
        hist.append(snap)
        action = "appended"

    json.dump(hist, open(HISTORY, "w"), indent=2)
    print(f"{action}: {snap['ts']}  tradable={snap['tradable_total']:,.0f}  rows={len(hist)}")
    used = [f for f in snap["flags"] if f.startswith("fallback_used")]
    if used:
        print("note - fallback endpoint(s) used:", used)

if __name__ == "__main__":
    main()
