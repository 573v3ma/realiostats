#!/usr/bin/env python3
"""Tokenized RWA market figures for the RWA industry watch card.

Run daily by publish_rwa.py during the Realio brief, so the market figures and
the stories land in one commit (it can also run on its own). Stdlib only, no
key. It is not in the GitHub Action: the repo token cannot change workflow
files, and RWA.xyz is more likely to block a datacenter IP. Reads the public
RWA.xyz pages, which serve their headline figures in the page HTML:

  app.rwa.xyz              Distributed Asset Value (tokenized RWAs, stablecoins
                           excluded) with its 30-day change, and the value by
                           network for the top networks
  app.rwa.xyz/real-estate  Distributed Value of tokenized real estate

Writes rwa-market.json: {"latest": {...}, "history": [{"date", ...}]}.

Fails safe. Every figure must parse and sit in a plausible range, and a move
of more than MAX_JUMP in a day against the last good reading is held back and
reported rather than published. On any failure the previous file is left
untouched and the script exits 0, so the card keeps showing the last good
value with its real as_of date and the story publish is never blocked.

"Distributed" is used on purpose: RWA.xyz's "Represented" value also counts
assets that only have a record on-chain, which is about ten times larger and
not comparable.
"""
import html, json, os, re, sys, urllib.request
from datetime import datetime, timezone

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rwa-market.json")
HOME, REAL_ESTATE = "https://app.rwa.xyz/", "https://app.rwa.xyz/real-estate"
UA = "Mozilla/5.0 (compatible; realiostats/1.0; +https://realiostats.com)"
# RWA.xyz network names for the chains RIO is issued on. Algorand is not in
# RWA.xyz's top-ten table, so it simply counts as zero when absent.
RIO_CHAINS = {"Ethereum": "ethereum", "BNB Chain": "bnb", "Solana": "solana",
              "Stellar": "stellar", "Base": "base", "Algorand": "algorand"}
RANGES = {"distributed_usd": (5e9, 5e11), "real_estate_usd": (1e7, 5e10)}
MAX_JUMP, STALE_DAYS, KEEP_HISTORY = 0.25, 3, 800
MULT = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}


def page_text(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=45) as r:
        raw = r.read().decode("utf-8", "ignore")
    raw = re.sub(r"<script.*?</script>|<style.*?</style>", " ", raw, flags=re.S)
    txt = html.unescape(re.sub(r"<[^>]+>", "|", raw))
    return re.sub(r"\s*\|[\s|]*", " | ", txt)


def money(num, unit):
    return float(num.replace(",", "")) * MULT[unit]


def headline(txt, label):
    """'<label> | $39.67B | ▼ | 0.67 | % | from | 30d' -> (value, signed pct)."""
    m = re.search(re.escape(label) + r" \| \$([\d,.]+)([KMBT]) \| ([▲▼]) \| \+? ?\|? ?([\d.]+) \| % \| from \| 30d", txt)
    if not m:
        m = re.search(re.escape(label) + r" \| \$([\d,.]+)([KMBT]) \| ([▲▼])[ |+]*([\d.]+)", txt)
    if not m:
        raise ValueError(f"'{label}' not found")
    pct = float(m.group(4)) * (1 if m.group(3) == "▲" else -1)
    return money(m.group(1), m.group(2)), round(pct, 2)


def networks(txt):
    out = {}
    for m in re.finditer(r"\| (\d{1,2}) \| ([A-Z][\w .-]{1,30}?) \| ([\d,]+) \| \$([\d,.]+)([KMBT]) \|", txt):
        name = m.group(2).strip()
        if name in RIO_CHAINS and RIO_CHAINS[name] not in out:
            out[RIO_CHAINS[name]] = money(m.group(4), m.group(5))
    return out


def load():
    try:
        with open(OUT, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"latest": None, "history": []}


def main():
    now = datetime.now(timezone.utc)
    try:
        home, re_page = page_text(HOME), page_text(REAL_ESTATE)
        dist, dist_pct = headline(home, "Distributed Asset Value")
        re_val, re_pct = headline(re_page, "Distributed Value")
        nets = networks(home)
    except Exception as e:  # network error or layout change: keep the last good file
        print(f"rwa-market: fetch/parse failed, keeping previous file: {e}")
        return 0

    latest = {
        "as_of": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "RWA.xyz",
        "source_url": HOME,
        "distributed_usd": round(dist),
        "distributed_30d_pct": dist_pct,
        "real_estate_usd": round(re_val),
        "real_estate_30d_pct": re_pct,
        "rio_chains": {k: round(v) for k, v in sorted(nets.items())},
        "rio_chains_usd": round(sum(nets.values())),
    }

    problems = []
    for k, (lo, hi) in RANGES.items():
        if not lo <= latest[k] <= hi:
            problems.append(f"{k} {latest[k]:,} outside {lo:,.0f}..{hi:,.0f}")
    if not 0 < latest["rio_chains_usd"] <= latest["distributed_usd"]:
        problems.append(f"rio_chains_usd {latest['rio_chains_usd']:,} not within the total")
    data = load()
    prev = data.get("latest")
    # Compare only with a recent reading. If the guard has held the figures
    # back for more than STALE_DAYS (a real step-change, or RWA.xyz redefining
    # a series), the new level is accepted rather than freezing the card.
    try:
        prev_age = (now - datetime.fromisoformat(prev["as_of"].replace("Z", "+00:00"))).days if prev else None
    except (KeyError, ValueError):
        prev_age = None
    if prev and prev_age is not None and prev_age <= STALE_DAYS:
        for k in ("distributed_usd", "real_estate_usd"):
            a, b = prev.get(k), latest[k]
            if a and abs(b / a - 1) > MAX_JUMP:
                problems.append(f"{k} moved {b / a - 1:+.0%} in one reading ({a:,} -> {b:,})")
    if problems:
        print("rwa-market: held back, previous file kept:\n  " + "\n  ".join(problems))
        return 0

    day = now.strftime("%Y-%m-%d")
    row = {"date": day, "distributed_usd": latest["distributed_usd"],
           "real_estate_usd": latest["real_estate_usd"], "rio_chains_usd": latest["rio_chains_usd"]}
    hist = [h for h in data.get("history", []) if h.get("date") != day] + [row]
    hist.sort(key=lambda h: h["date"])
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"latest": latest, "history": hist[-KEEP_HISTORY:]}, f, indent=1)
        f.write("\n")
    print(f"rwa-market: total ${dist / 1e9:.2f}B ({dist_pct:+.2f}% 30d), real estate ${re_val / 1e6:.1f}M "
          f"({re_pct:+.2f}% 30d), RIO chains ${latest['rio_chains_usd'] / 1e9:.1f}B {sorted(nets)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
