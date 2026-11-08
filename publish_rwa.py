#!/usr/bin/env python3
"""Validate a daily RWA industry-watch draft and publish it to rwa.json.

Run by the Realio daily brief on Steve's PC, never by GitHub Actions.

    python3 publish_rwa.py DRAFT.json --check          # validate only
    python3 publish_rwa.py DRAFT.json --publish preview # branch rwa-preview
    python3 publish_rwa.py DRAFT.json --publish main    # live site

DRAFT.json (private, never committed):
{
  "date": "2026-11-09",
  "sources": [
    {"key": "s1", "url": "https://www.tokenpost.com/...", "published": "2026-11-08T14:00:00Z",
     "text": "full article text as fetched"}
  ],
  "items": [
    {"tag": "REAL ESTATE", "title": "...", "why": "...", "sources": ["s1"],
     "key": false, "topic": null}
  ]
}

Guarantees on what reaches the public file:
  * the article's host is on the outlet allowlist below; the outlet name and
    tier come from this list, never from the draft
  * titles and "why" lines carry no links, markup or addresses; em dashes are
    rewritten (house style)
  * every number in a title or "why" appears in the saved article text or its
    publication date, so nothing numeric can be invented
  * the "why" line names Realio, Freehold, Districts or RIO; the title does not
    (news about Realio itself belongs in the official digest)
  * articles are at most MAX_AGE_DAYS old; a URL already published is dropped,
    and so is a topic seen in the last TOPIC_DAYS days unless the item is key
  * at most MAX_ITEMS a day, chosen by a fixed score: tag weight (REAL ESTATE
    or COMPETITOR 3, REGULATION 2, CHAIN or MARKET 1), +1 for a tier-1 outlet,
    +1 if published in the 24 hours before the draft date ends
An item failing any check is dropped and reported; the rest still publish.
Published items in a day are ordered newest first by publication time, then
by score. rwa.json keeps KEEP_DAYS days. On --publish the market figures in
rwa-market.json are refreshed too (fetch_rwa_market.py) and committed with it.
"""
import glob, json, os, re, subprocess, sys, tempfile
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

REPO = "573v3ma/realiostats"
# host suffix -> (outlet name, tier). Add an outlet here by hand, never on the fly.
OUTLETS = {
    "coindesk.com": ("CoinDesk", 1),
    "theblock.co": ("The Block", 1),
    "blockworks.co": ("Blockworks", 1),
    "dlnews.com": ("DL News", 1),
    "cointelegraph.com": ("Cointelegraph", 1),
    "rwa.xyz": ("RWA.xyz", 1),
    "tokenizer.estate": ("Tokenizer.Estate", 1),
    "reuters.com": ("Reuters", 1),
    "bloomberg.com": ("Bloomberg", 1),
    "decrypt.co": ("Decrypt", 2),
    "tokenpost.com": ("TokenPost", 2),
    "financefeeds.com": ("FinanceFeeds", 2),
    "benzinga.com": ("Benzinga", 2),
    "ledgerinsights.com": ("Ledger Insights", 2),
}
TAGS = {"REAL ESTATE": 3, "COMPETITOR": 3, "REGULATION": 2, "CHAIN": 1, "MARKET": 1}
MAX_ITEMS, MAX_TITLE, MAX_WHY, KEEP_DAYS = 3, 100, 220, 30
MAX_AGE_DAYS, TOPIC_DAYS = 7, 7
ABOUT = re.compile(r"\b(Realio|Freehold|Districts|RIO)\b")

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


def parse_ts(ts):
    t = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def outlet_for(url):
    p = urlparse(url or "")
    if p.scheme != "https" or not p.hostname:
        return None
    host = p.hostname.lower()
    for suffix, info in OUTLETS.items():
        if host == suffix or host.endswith("." + suffix):
            return info
    return None


def seen_before(existing, date):
    """URLs ever published, and topics published in the TOPIC_DAYS before date."""
    urls, topics = set(), set()
    cutoff = datetime.fromisoformat(date) - timedelta(days=TOPIC_DAYS)
    for d in (existing or {}).get("days", []):
        if d.get("date") == date:
            continue  # a re-run of the same day replaces it
        for it in d.get("items", []):
            u = (it.get("source") or {}).get("url")
            if u:
                urls.add(u)
            if it.get("topic") and datetime.fromisoformat(d["date"]) >= cutoff:
                topics.add(it["topic"])
    return urls, topics


def check_item(it, srcmap, date, urls, topics):
    errs = []
    tag = it.get("tag")
    if tag not in TAGS:
        errs.append(f"tag {tag!r} not allowed")
    title, why = clean(it.get("title")), clean(it.get("why"))
    if not (10 <= len(title) <= MAX_TITLE):
        errs.append(f"title length {len(title)}")
    if not (20 <= len(why) <= MAX_WHY):
        errs.append(f"why length {len(why)}")
    for field in (title, why):
        for rx, label in BAD:
            if rx.search(field):
                errs.append(f"{label} in text: {rx.search(field).group(0)!r}")
    if ABOUT.search(title):
        errs.append("title is about Realio itself (belongs in the official digest)")
    if not ABOUT.search(why):
        errs.append("why does not name Realio, Freehold, Districts or RIO")

    keys = it.get("sources") or []
    if len(keys) != 1:
        errs.append("exactly one source per item")
    s = srcmap.get(keys[0]) if keys else None
    pub, out_src, score = None, None, 0
    if keys and not s:
        errs.append(f"unknown source {keys[0]}")
    if s:
        info = outlet_for(s.get("url"))
        if not info:
            errs.append(f"outlet not on the allowlist: {urlparse(s.get('url') or '').hostname}")
        elif s["url"] in urls:
            errs.append("already published")
        if not (s.get("text") or "").strip() or len(s.get("text", "")) < 200:
            errs.append("source text missing or too short to check numbers")
        try:
            pub = parse_ts(s.get("published"))
        except (TypeError, ValueError):
            errs.append("bad published timestamp")
        if pub:
            day_end = datetime.fromisoformat(date).replace(tzinfo=timezone.utc) + timedelta(days=1)
            if pub > day_end + timedelta(hours=12):
                errs.append("published in the future")
            elif day_end - pub > timedelta(days=MAX_AGE_DAYS + 1):
                errs.append(f"older than {MAX_AGE_DAYS} days")
            allowed = nums_in(s.get("text")) | {str(pub.year), str(pub.month), str(pub.day)}
            y, m, d = date.split("-")
            allowed |= {y, str(int(m)), str(int(d))}
            stray = nums_in(title + " " + why) - allowed
            if stray:
                errs.append(f"numbers not in the article: {sorted(stray)}")
            if info:
                out_src = {"outlet": info[0], "url": s["url"], "published": pub.strftime("%Y-%m-%dT%H:%M:%SZ")}
                score = TAGS.get(tag, 0) + (1 if info[1] == 1 else 0) + (1 if day_end - pub <= timedelta(hours=24) else 0)

    key, topic = it.get("key", False), it.get("topic")
    if not isinstance(key, bool):
        errs.append("key must be true/false")
    if topic is not None and not (isinstance(topic, str) and re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", topic) and len(topic) <= 40):
        errs.append(f"bad topic {topic!r}")
    if key and not topic:
        errs.append("key item needs a topic")
    if topic and topic in topics and key is not True:
        errs.append(f"topic {topic!r} already covered in the last {TOPIC_DAYS} days")

    out = {"tag": tag, "title": title, "why": why, "source": out_src, "score": score}
    if key is True:
        out["key"] = True
    if topic:
        out["topic"] = topic
    return errs, out


def validate(draft, existing):
    date = draft.get("date", "")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        sys.exit("draft.date must be YYYY-MM-DD")
    srcmap = {s.get("key"): s for s in draft.get("sources", [])}
    urls, topics = seen_before(existing, date)
    kept, dropped, batch_urls = [], [], set()
    for n, it in enumerate(draft.get("items", []), 1):
        errs, out = check_item(it, srcmap, date, urls | batch_urls, topics)
        if errs:
            dropped.append((n, it.get("title"), errs))
        else:
            kept.append(out)
            batch_urls.add(out["source"]["url"])
    kept.sort(key=lambda o: (o["score"], o["source"]["published"]), reverse=True)  # best, then newest
    if len(kept) > MAX_ITEMS:
        dropped += [(None, o["title"], [f"over the daily cap of {MAX_ITEMS} (score {o['score']})"]) for o in kept[MAX_ITEMS:]]
        kept = kept[:MAX_ITEMS]
    kept.sort(key=lambda o: (o["source"]["published"], o["score"]), reverse=True)
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


def find_token(draft_path):
    p = os.environ.get("GH_TOKEN_FILE")
    cands = [p] if p else []
    cands += glob.glob(os.path.expanduser("~/mnt/*/.gh-token.txt")) + glob.glob(os.path.expanduser("~/mnt/*/.gh-token"))
    # walk up from the draft and from this script (D:/Projects/Realio Pro/.gh-token.txt)
    for start in (os.path.dirname(os.path.abspath(draft_path)), os.path.dirname(os.path.abspath(__file__))):
        d = start
        for _ in range(4):
            cands.append(os.path.join(d, ".gh-token.txt"))
            d = os.path.dirname(d)
    for c in cands:
        if c and os.path.isfile(c):
            t = open(c).read().strip()
            if t:
                return t
    sys.exit("GitHub token file not found (.gh-token.txt)")


def merge(existing, day):
    days = [d for d in (existing or {}).get("days", []) if d.get("date") != day["date"]]
    days.append(day)
    days.sort(key=lambda d: d["date"], reverse=True)
    return {"updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "days": days[:KEEP_DAYS]}


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"days": []}


def clone(target, draft_path):
    """Return (token, workdir, branch) with the target branch checked out."""
    token = find_token(draft_path)
    work = tempfile.mkdtemp(prefix="rs-rwa-")
    sh(["git", "clone", "-q", "--depth", "1", f"https://github.com/{REPO}.git", work], cwd="/")
    sh(["git", "config", "user.name", "573v3ma"], work)
    sh(["git", "config", "user.email", "stevemarque@gmail.com"], work)
    branch = "main" if target == "main" else "rwa-preview"
    if branch == "rwa-preview":
        # the preview branch carries the RWA code until it is merged; build on it when present
        rc, _ = sh(["git", "fetch", "-q", "--depth", "1", "origin", "rwa-preview"], work, check=False)
        if rc == 0:
            sh(["git", "checkout", "-q", "-B", "rwa-preview", "FETCH_HEAD"], work)
        else:
            sh(["git", "checkout", "-q", "-B", "rwa-preview"], work)
    return token, work, branch


def refresh_market(work):
    """Refresh rwa-market.json in the clone with fetch_rwa_market.py (fails safe:
    on any problem it keeps the file as it is). Done here rather than in the
    GitHub Action so both RWA files land in one commit from one writer."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    try:
        import fetch_rwa_market as frm
    except ImportError:
        print("rwa-market: fetch_rwa_market.py not found next to this script, market figures not refreshed")
        return
    frm.OUT = os.path.join(work, "rwa-market.json")
    frm.main()


def publish(day, token, work, branch):
    path = os.path.join(work, "rwa.json")
    new = merge(read_json(path), day)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(new, f, ensure_ascii=False, indent=1)
        f.write("\n")
    refresh_market(work)
    sh(["git", "add", "rwa.json"] + (["rwa-market.json"] if os.path.exists(os.path.join(work, "rwa-market.json")) else []), work)
    rc, _ = sh(["git", "diff", "--cached", "--quiet"], work, check=False)
    if rc == 0:
        print("rwa.json unchanged, nothing to push")
        return
    n = len(day["items"])
    sh(["git", "commit", "-q", "-m", f"RWA watch: {day['date']} ({n} stor{'ies' if n != 1 else 'y'})"], work)
    push = f"https://x-access-token:{token}@github.com/{REPO}.git"
    for attempt in range(3):
        rc, out = sh(["git", "push", "-q", push, f"HEAD:{branch}"], work, token, check=False)
        if rc == 0:
            _, sha = sh(["git", "rev-parse", "--short", "HEAD"], work)
            print(f"pushed {sha.strip()} to {branch}")
            return
        if attempt < 2:  # the 06:00 UTC Action may have committed meanwhile
            sh(["git", "pull", "-q", "--rebase", "--depth", "5", "origin", branch], work)
            continue
        raise SystemExit("push failed:\n" + out)


def main():
    a = sys.argv[1:]
    if not a or a[0].startswith("-"):
        sys.exit(__doc__)
    draft = json.load(open(a[0], encoding="utf-8"))
    target = None
    if "--publish" in a:
        target = a[a.index("--publish") + 1]
        if target not in ("preview", "main"):
            sys.exit("--publish preview|main")
        token, work, branch = clone(target, a[0])
        existing = read_json(os.path.join(work, "rwa.json"))
    else:
        # --check: compare against the live file when reachable, else nothing
        existing = {"days": []}
        try:
            import urllib.request
            with urllib.request.urlopen("https://realiostats.com/rwa.json", timeout=20) as r:
                existing = json.loads(r.read().decode("utf-8"))
        except Exception:
            pass
    day, dropped = validate(draft, existing)
    print(f"{draft.get('date')}: {len(day['items'])} stor{'ies' if len(day['items']) != 1 else 'y'} pass, {len(dropped)} dropped")
    for n, title, errs in dropped:
        print(f"  DROPPED #{n} {title!r}: " + "; ".join(errs))
    for it in day["items"]:
        print(f"  OK [{it['tag']}] score {it['score']} · {it['source']['outlet']} · {it['title']}")
    if target:
        publish(day, token, work, branch)


if __name__ == "__main__":
    main()
