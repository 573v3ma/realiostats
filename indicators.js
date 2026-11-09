/* realiostats price indicators (Nov 2026). Shared by the home page (chart
   overlays and the "Where the price sits" card) and the methodology page (the
   backtest table), so both always use the same maths on the same data.

   Data: price-history.json, every closed daily KuCoin RIO-USDT candle since
   26 April 2024, written by fetch_price_history.py in the daily Action. KuCoin
   is one venue; its closes match the site's own snapshots within a few percent
   (checked against all 105 snapshots on 9 Nov 2026). CoinGecko's history is not
   used here because its RIO prices for February to 27 March 2026 are wrong.

   The live price can be passed in as today's provisional close. It feeds the
   price-only indicators (averages, RSI, bands) but not the range or VWAP, which
   need a full day's high, low and volume.

   Loaded after core.js. Defines one global, IND. All maths is plain arrays of
   numbers; nothing here touches the page except renderBacktest(), which only
   runs when the methodology page's #btTable exists. */
const IND = (function(){
  const DAY = 864e5;

  /* ---------- series maths (each returns an array aligned to the input, null until warmed up) ---------- */
  function sma(a, k){
    const out = new Array(a.length).fill(null);
    let s = 0;
    for(let i = 0; i < a.length; i++){
      s += a[i];
      if(i >= k) s -= a[i - k];
      if(i >= k - 1) out[i] = s / k;
    }
    return out;
  }
  // Wilder's RSI, the standard 14-day definition.
  function rsi(a, k){
    k = k || 14;
    const out = new Array(a.length).fill(null);
    let g = 0, l = 0;
    for(let i = 1; i < a.length; i++){
      const up = Math.max(a[i] - a[i - 1], 0), dn = Math.max(a[i - 1] - a[i], 0);
      if(i <= k){ g += up / k; l += dn / k; if(i < k) continue; }
      else { g = (g * (k - 1) + up) / k; l = (l * (k - 1) + dn) / k; }
      out[i] = l ? 100 - 100 / (1 + g / l) : 100;
    }
    return out;
  }
  // Bollinger bands: 20-day average +/- 2 population standard deviations.
  function bands(a, k, m){
    k = k || 20; m = m || 2;
    const mid = sma(a, k), lo = new Array(a.length).fill(null), hi = lo.slice(), pb = lo.slice();
    for(let i = k - 1; i < a.length; i++){
      let v = 0;
      for(let j = i - k + 1; j <= i; j++) v += (a[j] - mid[i]) ** 2;
      const sd = Math.sqrt(v / k);
      lo[i] = mid[i] - m * sd; hi[i] = mid[i] + m * sd;
      pb[i] = sd ? (a[i] - lo[i]) / (hi[i] - lo[i]) : 0.5;
    }
    return {mid, lo, hi, pb};
  }
  // Rolling volume-weighted average price: dollars traded / RIO traded.
  function vwap(q, v, k){
    const out = new Array(q.length).fill(null);
    let sq = 0, sv = 0;
    for(let i = 0; i < q.length; i++){
      sq += q[i]; sv += v[i];
      if(i >= k){ sq -= q[i - k]; sv -= v[i - k]; }
      if(i >= k - 1 && sv > 0) out[i] = sq / sv;
    }
    return out;
  }
  // Average true range as a share of the close: the size of a normal day's swing.
  function atrPct(h, l, c, k){
    k = k || 14;
    const out = new Array(c.length).fill(null);
    const tr = c.map((x, i) => i ? Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])) : h[i] - l[i]);
    const m = sma(tr, k);
    for(let i = 0; i < c.length; i++) if(m[i] != null) out[i] = m[i] / c[i];
    return out;
  }
  // Share of the last k closes below today's close (0 = lowest, 1 = highest).
  function rankIn(a, i, k){
    if(i < k - 1) return null;
    let below = 0;
    for(let j = i - k + 1; j <= i; j++) if(a[j] < a[i]) below++;
    return below / k;
  }
  const median = a => { if(!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  /* ---------- data ---------- */
  let LOADED = null;
  function load(url){
    if(LOADED) return LOADED;
    LOADED = fetch(url || "./price-history.json", {cache: "no-store"})
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if(!j || !Array.isArray(j.days) || j.days.length < 220) return null;
        const H = {date: [], t: [], o: [], h: [], l: [], c: [], v: [], q: [], source: j.source, generated: j.generated_at};
        j.days.forEach(r => {
          if(!Array.isArray(r) || !(r[4] > 0)) return;
          H.date.push(r[0]);
          H.t.push(Date.parse(r[0] + "T00:00:00Z") + DAY);   // a daily close is the price at the END of its day
          H.o.push(+r[1]); H.h.push(+r[2]); H.l.push(+r[3]); H.c.push(+r[4]); H.v.push(+r[5] || 0); H.q.push(+r[6] || 0);
        });
        return H.c.length >= 220 ? H : null;
      })
      .catch(() => null);
    return LOADED;
  }

  /* Every series the page draws or reads, with the live price appended as a
     provisional last close when it is newer than the last closed candle. */
  function series(H, live){
    const t = H.t.slice(), c = H.c.slice();
    const prov = !!(live && live.v > 0 && live.t > t[t.length - 1] + 36e5);
    if(prov){ t.push(live.t); c.push(live.v); }
    const n = H.c.length;
    const vw = vwap(H.q, H.v, 90);
    if(prov) vw.push(null);
    return {t, c, prov, n,
      sma20: sma(c, 20), sma30: sma(c, 30), sma50: sma(c, 50), sma200: sma(c, 200),
      rsi14: rsi(c, 14), bb: bands(c, 20, 2), vwap90: vw,
      vwap180: vwap(H.q, H.v, 180), atr: atrPct(H.h, H.l, H.c, 14)};
  }

  /* Today's readings, each with a plain-language label. Labels describe where
     the price sits; they are deliberately not buy or sell calls (see the
     backtest on the methodology page for why). */
  function readings(H, live){
    const S = series(H, live), i = S.c.length - 1, k = S.n - 1;   // i: latest incl. live, k: last closed day
    const p = S.c[i];
    const vs = m => m ? p / m - 1 : null;
    const r = S.rsi14[i], pb = S.bb.pb[i];
    // Trend: the rio-bot's rule on daily closes. Price above its 30-day average
    // AND that average higher than a week ago = uptrend, mirror = downtrend.
    const m30 = S.sma30[i], m30w = S.sma30[i - 7];
    const trend = p > m30 && m30 > m30w ? "up" : p < m30 && m30 < m30w ? "down" : "flat";
    const yr = Math.max(0, k - 364);
    let hi = -Infinity, lo = Infinity, hiI = k, loI = k;
    for(let j = yr; j <= k; j++){ if(H.h[j] > hi){ hi = H.h[j]; hiI = j; } if(H.l[j] < lo){ lo = H.l[j]; loI = j; } }
    return {
      price: p, provisional: S.prov, asOf: H.date[k], from: H.date[0],
      rsi: r, rsiTag: r == null ? "" : r < 30 ? "Oversold" : r > 70 ? "Overbought" : r < 45 ? "Weak" : r > 55 ? "Firm" : "Neutral",
      bbPb: pb, bbLo: S.bb.lo[i], bbHi: S.bb.hi[i],
      bbTag: pb == null ? "" : pb < 0 ? "Below the lower band" : pb < 0.2 ? "Near the lower band" : pb > 1 ? "Above the upper band" : pb > 0.8 ? "Near the upper band" : "Inside the bands",
      sma20: S.sma20[i], vs20: vs(S.sma20[i]),
      sma50: S.sma50[i], vs50: vs(S.sma50[i]), sma50Rising: S.sma50[i] > S.sma50[i - 7],
      sma200: S.sma200[i], vs200: vs(S.sma200[i]), sma200Rising: S.sma200[i] > S.sma200[i - 7],
      vwap90: S.vwap90[k], vsVwap90: vs(S.vwap90[k]), vwap180: S.vwap180[k],
      atr: S.atr[k],
      trend,
      yrHi: hi, yrHiDate: H.date[hiI], yrLo: lo, yrLoDate: H.date[loI],
      vsYrLo: lo ? p / lo - 1 : null, vsYrHi: hi ? p / hi - 1 : null,
      yrPos: hi > lo ? (p - lo) / (hi - lo) : null,
      rank90: rankIn(S.c, i, 90)
    };
  }

  /* ---------- backtest ----------
     For each rule: on every day it was true, what did the price do over the
     next 7 and 30 days? Compared with the same figure for every day. Starts
     once the 200-day average exists. An "episode" is a run of signal days with
     no gap longer than the 30-day horizon, so one long oversold stretch counts
     once, which is the honest sample size. */
  const RULES = [
    {key: "all", name: "Every day (the baseline)", f: () => true},
    {key: "rsi30", name: "RSI under 30 (oversold)", f: (S, i) => S.rsi14[i] < 30},
    {key: "rsi70", name: "RSI over 70 (overbought)", f: (S, i) => S.rsi14[i] > 70},
    {key: "bblo", name: "Below the lower Bollinger band", f: (S, i) => S.bb.pb[i] < 0},
    {key: "low90", name: "Bottom 10% of its 90-day range", f: (S, i) => { const r = rankIn(S.c, i, 90); return r != null && r < 0.1; }},
    {key: "u50", name: "More than 25% under the 50-day average", f: (S, i) => S.c[i] < 0.75 * S.sma50[i]},
    {key: "u200", name: "More than 30% under the 200-day average", f: (S, i) => S.c[i] < 0.7 * S.sma200[i]},
    {key: "volup", name: "Volume over 2x its 30-day median, on an up day", f: (S, i, H) => S.c[i] > S.c[i - 1] && H.q[i] > 2 * median(H.q.slice(i - 29, i + 1))},
    {key: "up50", name: "Above a rising 50-day average", f: (S, i) => S.c[i] > S.sma50[i] && S.sma50[i] > S.sma50[i - 5]}
  ];
  function backtest(H){
    const S = series(H, null), n = S.c.length, start = 199;
    const fwd = (i, h) => S.c[i + h] / S.c[i] - 1;
    return RULES.map(rule => {
      const days = [];
      for(let i = start; i < n - 7; i++) if(rule.f(S, i, H)) days.push(i);
      const r7 = days.map(i => fwd(i, 7));
      const d30 = days.filter(i => i < n - 30), r30 = d30.map(i => fwd(i, 30));
      let ep = d30.length ? 1 : 0;
      for(let j = 1; j < d30.length; j++) if(d30[j] - d30[j - 1] > 30) ep++;
      return {key: rule.key, name: rule.name, days: d30.length, episodes: rule.key === "all" ? null : ep,
        med7: median(r7), med30: median(r30), up30: r30.length ? r30.filter(x => x > 0).length / r30.length : null};
    });
  }
  const BT_FROM = H => H.date[199];

  /* ---------- methodology page: the live backtest table ---------- */
  function renderBacktest(){
    const tb = document.getElementById("btTable");
    if(!tb) return;
    const pc = x => x == null ? "–" : (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(100 * x).toFixed(0) + "%";
    load().then(H => {
      if(!H){ document.getElementById("btRead").textContent = "The price history could not be loaded just now."; return; }
      const rows = backtest(H), base = rows[0];
      tb.innerHTML = rows.map(r => {
        const thin = r.episodes != null && r.episodes < 5;
        const cls = r.med30 == null || r.key === "all" ? "" : r.med30 > base.med30 ? "ok" : "burn";
        return `<tr${r.key === "all" ? ' class="tot"' : ""}><td>${r.name}</td><td>${r.days}</td><td>${r.episodes == null ? "–" : r.episodes + (thin ? " *" : "")}</td>`
          + `<td>${pc(r.med7)}</td><td class="${cls}">${pc(r.med30)}</td><td>${r.up30 == null ? "–" : Math.round(100 * r.up30) + "%"}</td></tr>`;
      }).join("");
      const f = d => { const x = new Date(d + "T00:00:00Z"); return x.getUTCDate() + " " + ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][x.getUTCMonth()] + " " + x.getUTCFullYear(); };
      document.getElementById("btSpan").textContent = f(BT_FROM(H)) + " to " + f(H.date[H.date.length - 1]);
      // The read-out sentence is computed, so it can never drift from the table.
      const os = rows.filter(r => ["rsi30", "bblo", "low90"].includes(r.key) && r.med30 != null);
      const worse = os.filter(r => r.med30 < base.med30).length;
      const ob = rows.find(r => r.key === "rsi70");
      const parts = [];
      if(os.length) parts.push(worse === os.length
        ? "Every oversold reading in the table was followed by a weaker 30 days than an average day: in this history, oversold tended to get more oversold."
        : worse === 0 ? "Every oversold reading in the table was followed by a stronger 30 days than an average day."
        : worse + " of the " + os.length + " oversold readings were followed by a weaker 30 days than an average day, so the evidence is mixed.");
      if(ob && ob.med30 != null) parts.push("Overbought readings were followed by a median " + pc(ob.med30) + " over 30 days, against " + pc(base.med30) + " on an average day.");
      parts.push("Rows marked * rest on fewer than five separate episodes, too few to lean on.");
      document.getElementById("btRead").textContent = parts.join(" ");
    });
  }
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", renderBacktest);
  else renderBacktest();

  return {load, series, readings, backtest, BT_FROM, sma, rsi, bands, vwap, median};
})();
