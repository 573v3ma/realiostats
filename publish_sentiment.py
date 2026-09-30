#!/usr/bin/env python3
"""Validate a daily community-sentiment tally and publish it to sentiment.json.

Run by the Realio daily brief on Steve's PC, never by GitHub Actions.

    python3 publish_sentiment.py DRAFT.json --check              # validate only
    python3 publish_sentiment.py DRAFT.json --publish preview    # branch sentiment-preview
    python3 publish_sentiment.py DRAFT.json --publish main       # live site

DRAFT.json (private, never committed) is one day, or a list of days:
{
  "date": "2026-09-30",
  "tg": {"bull": 22, "bear": 14, "neutral": 43},
  "x":  {"bull": 6,  "bear": 2,  "neutral": 9}        (or null / omitted)
}

What the numbers mean: each community member counts once per UTC day per
source, as bull / bear / neutral from the balance of their messages that
day (more bullish than bearish messages = bull, and so on). Team, admins of
the official groups, bots, official accounts, spam and forwards are left
out before counting.

Guarantees on what reaches the public file:
  * counts only: no names, no message text, no links
  * every count is an integer 0..MAX_COUNT and a day needs at least one
    source with data
  * a re-run for the same date replaces that date, it never adds to it
"""
import glob, json, os, re, subprocess, sys, tempfile
from datetime import datetime, timezone

REPO = "573v3ma/realiostats"
SOURCES = ("tg", "x")
KEYS = ("bull", "bear", "neutral")
MAX_COUNT, KEEP_DAYS = 2000, 180
METHOD = 1  # bump if the counting rules change, so old and new are never mixed silently


def check_day(d):
    errs = []
    date = d.get("date", "") if isinstance(d, dict) else ""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        return ["date must be YYYY-MM-DD"], None
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        return [f"{date}: not a real date"], None
    out = {"date": date}
    for extra in set(d) - {"date", *SOURCES}:
        errs.append(f"{date}: unexpected field {extra!r}")
    for s in SOURCES:
        v = d.get(s)
        if v is None:
            continue
        if not isinstance(v, dict) or set(v) != set(KEYS):
            errs.append(f"{date}: {s} must have exactly {KEYS}")
            continue
        if not all(isinstance(v[k], int) and not isinstance(v[k], bool) and 0 <= v[k] <= MAX_COUNT for k in KEYS):
            errs.append(f"{date}: {s} counts must be integers 0..{MAX_COUNT}")
            continue
        out[s] = {k: v[k] for k in KEYS}
    if not any(s in out for s in SOURCES):
        errs.append(f"{date}: no source with data")
    return errs, out


def sh(args, cwd, token=None, check=True):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    out = r.stdout + r.stderr
    if token:
        out = out.replace(token, "***")
    if check and r.returncode:
        shown = " ".join(args) if not token else " ".join(args).replace(token, "***")
        raise SystemExit(f"git failed: {shown}\n{out}")
    return r.returncode, out


def find_token():
    p = os.environ.get("GH_TOKEN_FILE")
    cands = [p] if p else glob.glob(os.path.expanduser("~/mnt/*/.gh-token.txt")) + glob.glob(os.path.expanduser("~/mnt/*/.gh-token"))
    for c in cands:
        if c and os.path.isfile(c):
            t = open(c).read().strip()
            if t:
                return t
    sys.exit("GitHub token file not found (~/mnt/*/.gh-token.txt)")


def merge(existing, days):
    by = {d["date"]: d for d in (existing or {}).get("days", []) if isinstance(d, dict) and "date" in d}
    for d in days:
        by[d["date"]] = d
    out = sorted(by.values(), key=lambda d: d["date"], reverse=True)[:KEEP_DAYS]
    return {"updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "method": METHOD, "days": out}


def publish(days, target):
    token = find_token()
    work = tempfile.mkdtemp(prefix="rs-sent-")
    sh(["git", "clone", "-q", "--depth", "1", f"https://github.com/{REPO}.git", work], cwd="/")
    sh(["git", "config", "user.name", "573v3ma"], work)
    sh(["git", "config", "user.email", "stevemarque@gmail.com"], work)
    branch = "main" if target == "main" else "sentiment-preview"
    path = os.path.join(work, "sentiment.json")
    existing = json.load(open(path)) if os.path.exists(path) else None
    if branch != "main":
        rc, _ = sh(["git", "fetch", "-q", "--depth", "1", "origin", branch], work, check=False)
        if rc == 0:
            sh(["git", "checkout", "-q", "-B", branch, "FETCH_HEAD"], work)
            existing = json.load(open(path)) if os.path.exists(path) else existing
        else:
            sh(["git", "checkout", "-q", "-B", branch], work)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(merge(existing, days), f, ensure_ascii=False, indent=1)
        f.write("\n")
    sh(["git", "add", "sentiment.json"], work)
    rc, _ = sh(["git", "diff", "--cached", "--quiet"], work, check=False)
    if rc == 0:
        print("sentiment.json unchanged, nothing to push")
        return
    label = days[0]["date"] if len(days) == 1 else f"{days[0]['date']}..{days[-1]['date']}"
    sh(["git", "commit", "-q", "-m", f"Sentiment: {label}"], work)
    push = f"https://x-access-token:{token}@github.com/{REPO}.git"
    for attempt in range(3):
        rc, out = sh(["git", "push", "-q", push, f"HEAD:{branch}"], work, token, check=False)
        if rc == 0:
            _, sha = sh(["git", "rev-parse", "--short", "HEAD"], work)
            print(f"pushed {sha.strip()} to {branch}")
            return
        if attempt < 2:  # the 06:00 UTC Action or the news publisher may have committed meanwhile
            sh(["git", "pull", "-q", "--rebase", "--depth", "5", "origin", branch], work)
            continue
        raise SystemExit("push failed:\n" + out)


def main():
    a = sys.argv[1:]
    if not a or a[0].startswith("-"):
        sys.exit(__doc__)
    raw = json.load(open(a[0], encoding="utf-8"))
    raw = raw if isinstance(raw, list) else [raw]
    good, bad = [], []
    for d in raw:
        errs, out = check_day(d)
        (bad.extend(errs) if errs else good.append(out))
    for e in bad:
        print("  REJECTED " + e)
    good.sort(key=lambda d: d["date"])
    for d in good:
        parts = [f"{s} {d[s]['bull']}/{d[s]['bear']}/{d[s]['neutral']}" for s in SOURCES if s in d]
        print(f"  OK {d['date']}  " + "  ".join(parts) + "  (bull/bear/neutral)")
    if bad:
        sys.exit("nothing published: fix the rejected days first")
    if "--publish" in a:
        target = a[a.index("--publish") + 1]
        if target not in ("preview", "main"):
            sys.exit("--publish preview|main")
        publish(good, target)


if __name__ == "__main__":
    main()
