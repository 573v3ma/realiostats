/* realiostats RWA industry watch.
   rwa-market.json is written daily by fetch_rwa_market.py (GitHub Action);
   rwa.json by publish_rwa.py, which has already checked every story (outlet
   allowlist, every number traceable to the article, a Realio link in the
   "why" line). This file still treats both as untrusted: text goes in via
   textContent only, and the only links built are https URLs on the same
   outlet allowlist. */
(function(){
  const OUTLETS = ["coindesk.com","theblock.co","blockworks.co","dlnews.com","cointelegraph.com","rwa.xyz",
    "tokenizer.estate","reuters.com","bloomberg.com","decrypt.co","tokenpost.com","financefeeds.com",
    "benzinga.com","ledgerinsights.com"];
  const TAGS = {"REAL ESTATE":"re","COMPETITOR":"co","REGULATION":"rg","CHAIN":"ch","MARKET":"mk"};
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const KEY_DAYS = 14, KEY_MAX = 3, HOME_MAX = 5, STALE_DAYS = 3;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if(cls) e.className = cls; if(text != null) e.textContent = text; return e; };
  const dayLabel = iso => { const d = new Date(String(iso).slice(0,10) + "T12:00:00Z"); return isNaN(d) ? "" : `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  const shortDate = ts => { const d = new Date(ts); return isNaN(d) ? "" : `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  const usd = v => !isFinite(v) ? "n/a" : v >= 1e9 ? "$" + (v/1e9).toFixed(v >= 1e11 ? 0 : 1) + "B" : "$" + Math.round(v/1e6) + "M";
  const pct = p => !isFinite(p) ? "" : (p > 0 ? "▲ +" : p < 0 ? "▼ " : "") + (Math.abs(p) + 1e-9).toFixed(1) + "% 30d";  // 4.05 rounds to 4.1, not 4.0

  function safeUrl(u){
    try {
      const x = new URL(u);
      if(x.protocol !== "https:") return null;
      const h = x.hostname.toLowerCase();
      return OUTLETS.some(s => h === s || h.endsWith("." + s)) ? x.href : null;
    } catch(e){ return null; }
  }

  // ---- market tiles
  function tile(name, val, sub, cls){
    const t = el("div", "chip rw-tile");
    t.append(el("div", "cn", name));
    const v = el("div", "cv", val); t.append(v);
    const x = el("div", "cx " + (cls || ""), sub); t.append(x);
    return t;
  }

  function marketNode(m){
    const L = m && m.latest;
    if(!L || !isFinite(L.distributed_usd)) return null;
    const box = el("div", "rw-market");
    const row = el("div", "emit rw-tiles");
    const dir = p => p > 0 ? "rw-up" : p < 0 ? "rw-down" : "";
    row.append(tile("Tokenized RWAs", usd(L.distributed_usd), pct(L.distributed_30d_pct), dir(L.distributed_30d_pct)));
    const reShare = L.real_estate_usd / L.distributed_usd * 100;
    row.append(tile("Of which real estate", usd(L.real_estate_usd),
      (isFinite(reShare) ? reShare.toFixed(1) + "% of the market · " : "") + pct(L.real_estate_30d_pct), dir(L.real_estate_30d_pct)));
    if(isFinite(L.rio_chains_usd) && L.rio_chains_usd > 0){
      const share = L.rio_chains_usd / L.distributed_usd * 100;
      row.append(tile("On chains RIO lives on", usd(L.rio_chains_usd),
        share.toFixed(0) + "% of the market · Ethereum, BNB Chain, Solana, Stellar, Base"));
    }
    box.append(row);
    const age = Math.floor((Date.now() - Date.parse(L.as_of)) / 864e5);
    const note = el("p", "nw-note rw-asof" + (age > STALE_DAYS ? " nw-stale" : ""));
    note.append("Distributed value, stablecoins excluded. Source: ");
    const a = el("a", null, "RWA.xyz"); a.href = "https://app.rwa.xyz/"; a.target = "_blank"; a.rel = "noopener nofollow";
    note.append(a, ", as of " + dayLabel(L.as_of) + (age > STALE_DAYS ? " (latest reading we could verify)" : "") + ".");
    box.append(note);
    return box;
  }

  // ---- stories
  function storyNode(it, opts){
    const li = el("li", "nw-item rw-item" + (opts && opts.key ? " nw-key" : ""));
    const head = el("div", "nw-head");
    const tag = TAGS[it.tag] ? it.tag : "MARKET";
    head.append(el("span", "nw-pill rw-" + TAGS[tag], tag), el("span", "nw-title", it.title || ""));
    li.append(head);
    if(it.why && !(opts && opts.key)){
      const w = el("p", "rw-why"); w.append(el("b", null, "Why it matters: "), it.why); li.append(w);
    }
    const s = it.source || {};
    const row = el("div", "nw-srcs");
    const href = safeUrl(s.url);
    if(href){ const a = el("a", null, s.outlet || "Source"); a.href = href; a.target = "_blank"; a.rel = "noopener nofollow"; row.append(a); }
    else if(s.outlet) row.append(el("span", null, s.outlet));
    if(s.published) row.append(el("span", null, shortDate(s.published)));
    li.append(row);
    return li;
  }

  function keyItems(days){
    const cutoff = Date.parse(days[0].date + "T00:00:00Z") - KEY_DAYS * 864e5;
    const seen = new Set(), out = [];
    days.forEach(d => {
      if(Date.parse(d.date + "T00:00:00Z") < cutoff) return;
      (d.items || []).forEach(it => {
        const t = typeof it.topic === "string" ? it.topic : null;
        if(t && seen.has(t)) return;
        if(t) seen.add(t);
        if(it.key === true) out.push(it);
      });
    });
    return out.slice(0, KEY_MAX);
  }

  function list(items, opts){ const ul = el("ul", "nw-list"); items.forEach(it => ul.append(storyNode(it, opts))); return ul; }

  function storiesHome(days){
    const box = el("div", "nw-card");
    const keys = keyItems(days);
    const keyUrls = new Set(keys.map(k => k.source && k.source.url));
    if(keys.length){
      box.append(el("h3", "nw-sub", "Key stories"), list(keys, {key: true}));
    }
    const latest = [];
    days.forEach(d => (d.items || []).forEach(it => { if(!keyUrls.has(it.source && it.source.url)) latest.push(it); }));
    if(keys.length) box.append(el("h3", "nw-sub nw-sub-day", "Latest"));
    if(latest.length) box.append(list(latest.slice(0, HOME_MAX)));
    else box.append(el("p", "nw-quiet", "No industry story passed the filter in the last few days."));
    return box;
  }

  function dayNode(day){
    const box = el("div", "nw-day");
    box.append(el("h3", "nw-date", dayLabel(day.date)));
    const items = Array.isArray(day.items) ? day.items : [];
    box.append(items.length ? list(items) : el("p", "nw-quiet", "No industry story passed the filter that day."));
    return box;
  }

  function render(market, data){
    const days = (data && Array.isArray(data.days) ? data.days : []).filter(d => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date));
    days.sort((a,b) => a.date < b.date ? 1 : -1);
    const mk = () => marketNode(market);

    const home = document.getElementById("rwaHome");
    if(home && (days.length || (market && market.latest))){
      const m = mk(); if(m) home.append(m);
      if(days.length){
        home.append(storiesHome(days));
        const stamp = document.getElementById("rwaStamp");
        if(stamp){
          const age = Math.floor((Date.now() - Date.parse(days[0].date + "T00:00:00Z")) / 864e5);
          stamp.textContent = (age > 1 ? "Last update " : "Updated ") + dayLabel(days[0].date);
          if(age > 1) stamp.classList.add("nw-stale");
        }
      }
      document.getElementById("overview-rwa").hidden = false;
    }

    const arch = document.getElementById("rwaArchive");
    if(arch && (days.length || (market && market.latest))){
      const mBox = document.getElementById("rwaMarket");
      const m = mk(); if(m && mBox){ mBox.textContent = ""; mBox.append(m); }
      arch.textContent = "";
      if(days.length) days.forEach(d => arch.append(dayNode(d)));
      else arch.append(el("p", "nw-quiet", "The first stories are on their way."));
      document.getElementById("rwa").hidden = false;
      if(location.hash === "#rwa") anchorToRwa();
    }
  }

  // The section starts hidden, so a news.html#rwa link finds nothing to jump to
  // when the page loads, and the official archive above it (news.js) can render
  // later and push it down. Scroll to it once shown and keep it in place while
  // content above loads, for a few seconds or until the reader scrolls.
  function anchorToRwa(){
    const el = document.getElementById("rwa");
    let stop = false;
    // instant, not the site's smooth scrolling: a smooth scroll over the whole
    // archive is slow, restarts on every re-anchor, and stalls in background tabs
    const go = () => { if(!stop) el.scrollIntoView({block: "start", behavior: "instant"}); };
    ["wheel", "touchstart", "keydown", "mousedown"].forEach(e => addEventListener(e, () => { stop = true; }, {once: true, passive: true}));
    go();
    requestAnimationFrame(go);
    // timers as well: frame and resize callbacks do not run in a background tab
    [300, 1000, 2000, 3500].forEach(ms => setTimeout(go, ms));
    if(window.ResizeObserver){
      const ro = new ResizeObserver(go);
      ro.observe(document.body);
      setTimeout(() => ro.disconnect(), 4000);
    }
  }

  const bust = "?t=" + Math.floor(Date.now() / 36e5);
  const get = f => fetch(f + bust, {cache: "no-cache"}).then(r => r.ok ? r.json() : null).catch(() => null);
  Promise.all([get("rwa-market.json"), get("rwa.json")]).then(([m, d]) => render(m, d));
})();
