/* realiostats community mood gauge.
   sentiment.json is written once a day by publish_sentiment.py and holds
   counts only: per UTC day and source, how many community members leaned
   bullish, bearish or neutral (one vote per person per day, team and bots
   excluded). This file turns the last 7 days into a 0-100 reading.
   Everything is inserted with textContent or built as SVG nodes. */
(function(){
  const WINDOW = 7, MIN_VOTES = 25, TREND_DAYS = 30;
  const BANDS = [[20,"Bearish","bear"],[40,"Cautious","cautious"],[60,"Neutral","neutral"],[80,"Optimistic","opt"],[101,"Bullish","bull"]];
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const NS = "http://www.w3.org/2000/svg";
  const $ = id => document.getElementById(id);
  const svg = (tag, attrs) => { const e = document.createElementNS(NS, tag); for(const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  const n = v => Number.isInteger(v) && v >= 0 ? v : 0;
  const dayMs = iso => Date.parse(iso + "T00:00:00Z");
  const label = iso => { const d = new Date(iso + "T12:00:00Z"); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  const band = s => BANDS.find(b => s < b[0]);

  // bull/bear/neutral summed over sources and over the WINDOW days ending at endIso
  function windowTotals(byDate, endIso){
    const t = {bull:0, bear:0, neutral:0, days:0}, end = dayMs(endIso);
    for(let i = 0; i < WINDOW; i++){
      const d = byDate.get(new Date(end - i*864e5).toISOString().slice(0,10));
      if(!d) continue;
      t.days++;
      ["tg","x"].forEach(s => { if(d[s]){ t.bull += n(d[s].bull); t.bear += n(d[s].bear); t.neutral += n(d[s].neutral); } });
    }
    return t;
  }
  // Share of bullish among members who leaned either way, lightly smoothed
  // (+1/+2) so a thin day cannot swing to 0 or 100.
  const score = t => Math.round(100 * (t.bull + 1) / (t.bull + t.bear + 2));

  function point(cx, cy, r, s){ const a = Math.PI * (1 - s/100); return [cx + r*Math.cos(a), cy - r*Math.sin(a)]; }
  function arc(cx, cy, r, s0, s1){
    const [x0,y0] = point(cx,cy,r,s0), [x1,y1] = point(cx,cy,r,s1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }

  function drawDial(el, s){
    el.textContent = "";
    const cx = 110, cy = 104, r = 86;
    let prev = 0;
    BANDS.forEach(([hi,,cls]) => {
      const top = Math.min(hi, 100);
      el.append(svg("path", {d: arc(cx,cy,r,prev + (prev ? 1 : 0), top - (top < 100 ? 1 : 0)), class: "sm-seg sm-" + cls, "stroke-width": 16, fill: "none"}));
      prev = top;
    });
    if(s == null) return;
    const [nx,ny] = point(cx,cy,r - 26,s);
    el.append(svg("line", {x1: cx, y1: cy, x2: nx.toFixed(2), y2: ny.toFixed(2), class: "sm-needle", "stroke-width": 4, "stroke-linecap": "round"}));
    el.append(svg("circle", {cx, cy, r: 7, class: "sm-hub"}));
  }

  function drawTrend(el, pts){
    el.textContent = "";
    if(pts.length < 2) return;
    // viewBox matches the drawn width so the line and dot are not stretched
    const W = Math.max(160, Math.round(el.getBoundingClientRect().width) || 240), H = 56, pad = 4;
    el.setAttribute("viewBox", `0 0 ${W} ${H}`);
    // scale to the readings (at least 30 points tall) so a real move is visible
    const vals = pts.map(p => p.s);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if(hi - lo < 30){ const c = (hi + lo) / 2; lo = c - 15; hi = c + 15; }
    lo = Math.max(0, lo - 3); hi = Math.min(100, hi + 3);
    const x = i => pad + i * (W - 2*pad) / (pts.length - 1), y = v => H - pad - (v - lo) / (hi - lo) * (H - 2*pad);
    if(lo < 50 && hi > 50) el.append(svg("line", {x1: 0, x2: W, y1: y(50).toFixed(1), y2: y(50).toFixed(1), class: "sm-mid"}));
    el.append(svg("polyline", {points: pts.map((p,i) => `${x(i).toFixed(1)},${y(p.s).toFixed(1)}`).join(" "), class: "sm-line", fill: "none", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round"}));
    const last = pts[pts.length - 1];
    el.append(svg("circle", {cx: x(pts.length - 1).toFixed(1), cy: y(last.s).toFixed(1), r: 3.5, class: "sm-dot"}));
    el.setAttribute("aria-label", `7-day mood reading from ${label(pts[0].date)} (${pts[0].s}) to ${label(last.date)} (${last.s})`);
  }

  // RIO price change over the same 7 days, from our own daily snapshots
  function priceChange(hist, endIso){
    if(!Array.isArray(hist)) return null;
    const rows = hist.filter(r => r && typeof r.ts === "string" && typeof r.price_usd === "number" && r.price_usd > 0)
                     .map(r => ({t: Date.parse(r.ts), p: r.price_usd})).filter(r => !isNaN(r.t)).sort((a,b) => a.t - b.t);
    const end = dayMs(endIso) + 864e5 + 12*36e5;              // allow the morning snapshot after the window
    const upTo = rows.filter(r => r.t <= end);
    if(!upTo.length) return null;
    const now = upTo[upTo.length - 1], target = now.t - WINDOW*864e5;
    let then = null;
    upTo.forEach(r => { if(Math.abs(r.t - target) < 2*864e5 && (!then || Math.abs(r.t - target) < Math.abs(then.t - target))) then = r; });
    return then ? (now.p / then.p - 1) * 100 : null;
  }

  function readLine(s, chg){
    if(chg == null) return "";
    const up = chg >= 3, down = chg <= -3, warm = s >= 60, cold = s < 40;
    if(down && !cold) return "Mood is holding up while the price has fallen.";
    if(up && !warm) return "The price has risen but the community is not convinced yet.";
    if(up && warm) return "Mood and price are both pointing up.";
    if(down && cold) return "Mood and price are both pointing down.";
    return "Price has barely moved; mood is the thing to watch.";
  }

  function render(data, hist){
    const days = (data && Array.isArray(data.days) ? data.days : []).filter(d => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date));
    if(!days.length) return;
    days.sort((a,b) => a.date < b.date ? -1 : 1);
    $("overview-mood").hidden = false;   // before drawing, so the trend can measure its width
    const byDate = new Map(days.map(d => [d.date, d]));
    const latest = days[days.length - 1].date;
    const t = windowTotals(byDate, latest);
    const enough = t.bull + t.bear >= MIN_VOTES;
    const s = enough ? score(t) : null;

    drawDial($("smDial"), s);
    const b = enough ? band(s) : null;
    $("smScore").textContent = enough ? String(s) : "–";
    const lab = $("smLabel");
    lab.textContent = enough ? b[1] : "Not enough data yet";
    lab.className = "sm-label" + (enough ? " sm-t-" + b[2] : "");
    $("smCounts").textContent = enough ? `${t.bull} bullish · ${t.bear} bearish · ${t.neutral} neutral` : `${t.bull + t.bear} of ${MIN_VOTES} needed`;

    const chg = priceChange(hist, latest);
    const pc = $("smPrice");
    if(chg != null){
      pc.textContent = (chg >= 0 ? "+" : "") + chg.toFixed(1) + "%";
      pc.className = "sm-v " + (chg >= 0.5 ? "up" : chg <= -0.5 ? "down" : "flat");
    }
    $("smRead").textContent = enough ? readLine(s, chg) : "";

    const pts = [];
    const first = dayMs(days[0].date) + (WINDOW - 1) * 864e5;
    for(let i = TREND_DAYS - 1; i >= 0; i--){
      const iso = new Date(dayMs(latest) - i*864e5).toISOString().slice(0,10);
      if(dayMs(iso) < first) continue;
      const w = windowTotals(byDate, iso);
      if(w.bull + w.bear >= MIN_VOTES) pts.push({date: iso, s: score(w)});
    }
    drawTrend($("smTrend"), pts);
    if(pts.length > 1) $("smTrendCap").textContent = `7-day reading, ${label(pts[0].date)} to ${label(latest)}`;

    const age = Math.floor((Date.now() - dayMs(latest)) / 864e5);
    const st = $("smStamp");
    st.textContent = `Last ${WINDOW} days to ${label(latest)}` + (age > 2 ? " · not updated since" : "");
    if(age > 2) st.classList.add("nw-stale");
  }

  const hour = Math.floor(Date.now() / 36e5);
  Promise.all([
    fetch("sentiment.json?t=" + hour, {cache: "no-cache"}).then(r => r.ok ? r.json() : null),
    fetch("./supply-history.json").then(r => r.ok ? r.json() : null).catch(() => null)
  ]).then(([d, h]) => render(d, h)).catch(() => {});
})();
