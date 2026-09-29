#!/usr/bin/env python3
"""Validate a daily official-updates draft and publish it to news.json.

Run by the Realio daily brief on Steve's PC, never by GitHub Actions.

    python3 publish_news.py DRAFT.json --check          # validate only
    python3 publish_news.py DRAFT.json --publish preview # branch news-preview
    python3 publish_news.py DRAFT.json --publish main    # live site

DRAFT.json (private, never committed):
{
  "date": "2026-09-29",
  "sources": [
    {"key":"x1","kind":"x","handle":"realio_network","id":"1840...","ts":"...Z","text":"full post text"},
    {"key":"t1","kind":"tg","chat_id":-1002432247183,"sender":"Derek Boirun","admin":true,"ts":"...Z","text":"full message"}
  ],
  "items": [
    {"project":"Realio","title":"...","text":"...","sources":["x1","t1"]}
  ]
}

Guarantees on what reaches the public file:
  * sources are official X accounts or team/admin messages in the three
    official Telegram groups; nothing else is accepted
  * titles and text carry no links, no HTML and no @handles other than the
    official accounts; em dashes are rewritten (house style)
  * every number in an item appears in one of its own source posts or in
    the source date, so nothing numeric can be invented
  * Telegram message text and sender names are never published, only the
    group name and time
An item failing any check is dropped and reported; the rest still publish.
"""
import glob, json, os, re, subprocess, sys, tempfile
from datetime import datetime, timezone

REPO = "573v3ma/realiostats"
X_OK = {"realio_network", "derekboirun", "freehold_wallet", "districts_xyz"}
TG_OK = {
    -1002432247183: "Realio Network Official",
    -1002397575725: "Freehold Official",
    -1003469704422: "Realio Network Validators",
}
PROJECTS = {"Realio", "Freehold", "Districts"}
MAX_ITEMS, MAX_TITLE, MAX_TEXT, KEEP_DAYS = 6, 90, 320, 30

BAD = [
    (re.compile(r"https?:|www\.|t\.me/|\b[\w-]+\.(com|io|xyz|net|org|app|network|finance|gg|co)\b", re.I), "link"),
    (re.compile(r"[<>`]"), "markup"),
    (re.compile(r"\b0x[0-9a-fA-F]{6,}|\brealio1[0-9a-z]{20,}", re.I), "address"),
]
NUM = re.compile(r"\d[\d,.]*\d|\d")


def norm_num(s):
    s = s.replace(",", "").rstrip(".")
    if "." in s:
        s = s.rstrip("0").rstrip(".") or "0"
    return s


def nums_in(text):
    return {norm_num(m) for m in NUM.findall(text or "")}


def clean(s):
    s = (s or "").strip()
    s = s.replace(" — ", ", ").replace("—", ", ").replace(" – ", ", ")
    return re.sub(r"\s+", " ", s)


def check_item(it, srcmap, date):
    errs = []
    if it.get("project") not in PROJECTS:
        errs.append(f"project {it.get('project')!r} not allowed")
    title, text = clean(it.get("title")), clean(it.get("text"))
    if not (3 <= len(title) <= MAX_TITLE):
        errs.append(f"title length {len(title)}")
    if len(text) > MAX_TEXT:
        errs.append(f"text length {len(text)}")
    for field in (title, text):
        for rx, why in BAD:
            if rx.search(field):
                errs.append(f"{why} in text: {rx.search(field).group(0)!r}")
        for h in re.findall(r"@(\w+)", field):
            if h.lower() not in X_OK:
                errs.append(f"non-official handle @{h}")
    keys = it.get("sources") or []
    if not keys:
        errs.append("no sources")
    pub, allowed = [], set()
    for d in [date]:
        y, m, dd = d.split("-")
        allowed |= {y, str(int(m)), str(int(dd))}
    for k in keys:
        s = srcmap.get(k)
        if not s:
            errs.append(f"unknown source {k}")
            continue
        ts = s.get("ts", "")
        try:
            t = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            allowed |= {str(t.year), str(t.month), str(t.day)}
        except ValueError:
            errs.append(f"{k}: bad ts")
            continue
        allowed |= nums_in(s.get("text"))
        if s.get("kind") == "x":
            h, i = str(s.get("handle", "")).lower(), str(s.get("id", ""))
            if h not in X_OK:
                errs.append(f"{k}: X account @{h} not official")
            elif not re.fullmatch(r"\d{5,25}", i):
                errs.append(f"{k}: bad tweet id")
            else:
                pub.append({"kind": "x", "handle": h, "id": i, "ts": ts})
        elif s.get("kind") == "tg":
            cid = s.get("chat_id")
            if cid not in TG_OK:
                errs.append(f"{k}: Telegram chat {cid} not official")
            elif s.get("admin") is not True:
                errs.append(f"{k}: sender is not a team member/admin")
            else:
                pub.append({"kind": "tg", "chat": TG_OK[cid], "ts": ts})
        else:
            errs.append(f"{k}: unknown kind")
    stray = nums_in(title + " " + text) - allowed
    if stray:
        errs.append(f"numbers not in sources: {sorted(stray)}")
    return errs, {"project": it.get("project"), "title": title, "text": text, "sources": pub}


def validate(draft):
    date = draft.get("date", "")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        sys.exit("draft.date must be YYYY-MM-DD")
    srcmap = {s.get("key"): s for s in draft.get("sources", [])}
    kept, dropped = [], []
    for n, it in enumerate(draft.get("items", []), 1):
        errs, out = check_item(it, srcmap, date)
        (dropped if errs else kept).append((n, it.get("title"), errs) if errs else out)
    if len(kept) > MAX_ITEMS:
        dropped += [(None, o["title"], ["over the daily cap"]) for o in kept[MAX_ITEMS:]]
        kept = kept[:MAX_ITEMS]
    return {"date": date, "items": kept}, dropped


def sh(args, cwd, token=None, check=True):
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    out = (r.stdout + r.stderr)
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


def merge(existing, day):
    days = [d for d in (existing or {}).get("days", []) if d.get("date") != day["date"]]
    days.append(day)
    days.sort(key=lambda d: d["date"], reverse=True)
    return {"updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "days": days[:KEEP_DAYS]}


def publish(day, target):
    token = find_token()
    work = tempfile.mkdtemp(prefix="rs-news-")
    url = f"https://github.com/{REPO}.git"
    sh(["git", "clone", "-q", "--depth", "1", url, work], cwd="/")
    sh(["git", "config", "user.name", "573v3ma"], work)
    sh(["git", "config", "user.email", "stevemarque@gmail.com"], work)
    branch = "main" if target == "main" else "news-preview"
    existing = json.load(open(os.path.join(work, "news.json")))
    if branch == "news-preview":
        rc, _ = sh(["git", "fetch", "-q", "--depth", "1", "origin", "news-preview"], work, check=False)
        if rc == 0:
            _, raw = sh(["git", "show", "FETCH_HEAD:news.json"], work)
            try:
                existing = json.loads(raw)
            except ValueError:
                pass
        sh(["git", "checkout", "-q", "-B", "news-preview"], work)  # always main + today's news
    new = merge(existing, day)
    with open(os.path.join(work, "news.json"), "w", encoding="utf-8") as f:
        json.dump(new, f, ensure_ascii=False, indent=1)
        f.write("\n")
    sh(["git", "add", "news.json"], work)
    rc, _ = sh(["git", "diff", "--cached", "--quiet"], work, check=False)
    if rc == 0:
        print("news.json unchanged, nothing to push")
        return
    n = len(day["items"])
    sh(["git", "commit", "-q", "-m", f"News: {day['date']} digest ({n} item{'s' if n != 1 else ''})"], work)
    push = f"https://x-access-token:{token}@github.com/{REPO}.git"
    for attempt in range(3):
        args = ["git", "push", "-q"] + (["--force"] if branch == "news-preview" else []) + [push, f"HEAD:{branch}"]
        rc, out = sh(args, work, token, check=False)
        if rc == 0:
            _, sha = sh(["git", "rev-parse", "--short", "HEAD"], work)
            print(f"pushed {sha.strip()} to {branch}")
            return
        if branch == "main" and attempt < 2:  # the 06:00 UTC Action may have committed meanwhile
            sh(["git", "pull", "-q", "--rebase", "--depth", "5", "origin", "main"], work)
            continue
        raise SystemExit("push failed:\n" + out)


def main():
    a = sys.argv[1:]
    if not a or a[0].startswith("-"):
        sys.exit(__doc__)
    draft = json.load(open(a[0], encoding="utf-8"))
    day, dropped = validate(draft)
    print(f"{draft.get('date')}: {len(day['items'])} item(s) pass, {len(dropped)} dropped")
    for n, title, errs in dropped:
        print(f"  DROPPED #{n} {title!r}: " + "; ".join(errs))
    for it in day["items"]:
        print(f"  OK [{it['project']}] {it['title']}")
    if "--publish" in a:
        target = a[a.index("--publish") + 1]
        if target not in ("preview", "main"):
            sys.exit("--publish preview|main")
        publish(day, target)


if __name__ == "__main__":
    main()
