/* realiostats shared core: formatters, chart watermark, footer helper,
   and the one loader every page uses to read the daily supply snapshot.
   Extracted verbatim from the original single-file index.html. */

const M = n => (n/1e6);
const fmtM = n => (n>=1 ? n.toFixed(n<10?2:1) : n.toFixed(2)) + "M";
const fmtFull = n => Math.round(n).toLocaleString("en-US");

const fmtUsd = n => n>=1e6 ? "$"+(n/1e6).toFixed(2)+"M" : "$"+Math.round(n).toLocaleString("en-US");
const fmtBig = n => !isFinite(n) ? "—" : n>=1e9 ? "$"+(n/1e9).toFixed(2)+"B" : n>=1e6 ? "$"+(n/1e6).toFixed(1)+"M" : "$"+Math.round(n).toLocaleString("en-US");
const fmtInt = n => Math.round(n).toLocaleString("en-US");

/* fallback snapshot so the page renders even if the live fetch is blocked (e.g. file://) */
const FALLBACK = {"ts":"2026-07-11T12:32:23Z","native_cap":175000000,"tradable_total":326580245.0,
  "price_usd":0.03094567,"price_source":"coingecko","market_cap_usd":10106245,
  "mint":{"inflation_rate":0.08,"blocks_per_year":6311520},
  "global_total_rio":487959629,"expected_annual_emission_rio":6311580,"expected_daily_emission_rio":17292,"expected_daily_emission_nominal_rio":19629,"block_time_s":5.672,"emission_block_adjusted":true,
  "chains":{
    "realio_native":{"circulating":85110830.84},
    "bnb":{"circulating":155976321.31},
    "ethereum":{"circulating":70771577.26},
    "algorand":{"circulating":7779530.89,"reserve":43796048.93,"bridge_wallet":48424420.17},
    "stellar":{"circulating":5860051.30,"treasury":69139801.30},
    "solana":{"circulating":1081933.32},
    "base":{"circulating":0}
  }};

// Draws a faint "realiostats.com" attribution into the chart canvas (bottom-right
// of the plot area) so screenshots stay sourced. Opt-in per chart via plugins:[].
const watermarkPlugin = {
  id: "watermark",
  afterDraw(chart){
    const a = chart.chartArea; if(!a) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.font = "600 12px Inter, system-ui, sans-serif";
    ctx.fillStyle = T().wm;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText("realiostats.com", a.right - 8, a.bottom - 6);
    ctx.restore();
  }
};

function copyAddr(){
  const a=document.getElementById("donAddr").textContent.trim();
  navigator.clipboard?.writeText(a).then(()=>{const b=document.getElementById("copyBtn");b.textContent="Copied";setTimeout(()=>b.textContent="Copy",1500);});
}

/* Every page needs the latest committed snapshot. Same failure behaviour as
   before: if the fetch is blocked (file://, offline), fall back to the frozen
   snapshot so the page still renders rather than blanking. */
/* Charts measure axis labels once, when first drawn, and cache the widths by
   font name. If Inter is still loading at that moment the labels are measured
   in the fallback font, and the wider Inter digits later get clipped at the
   left edge. So nothing renders until the web fonts are in (capped at 2s so a
   blocked font server never holds the page up). */
const FONTS_READY = (document.fonts && document.fonts.ready)
  ? Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 2000))]) : Promise.resolve();
function loadSupply(){
  return Promise.all([
    fetch("./supply-history.json",{cache:"no-store"}).then(r=>r.json())
      .then(arr=>({arr, latest:arr[arr.length-1]}))
      .catch(()=>({arr:[FALLBACK], latest:FALLBACK})),
    FONTS_READY
  ]).then(([d]) => d);
}

/* Tradable float, shared.

   Used by supply.js for the liquid-float ladder and the venue tables. Kept in
   core.js rather than supply.js so any future page can quote the same numbers
   without a second definition drifting away from this one.

   Two deliberate choices, stated on the page rather than hidden:
   - onVenues / withMarket are a FLOOR, not a total. Only wallets identifiable
     from public explorer name tags are counted.
   - Bridges are excluded from the venue rungs. Bridge balances are lock-and-mint
     escrow backing wrapped RIO elsewhere, not somewhere anyone can trade.      */
function computeFloat(latest, h){
  const circ = latest.tradable_total || 0;
  const c = latest.chains || {};
  const liquidChains = ((c.bnb && c.bnb.circulating) || 0)
                     + ((c.ethereum && c.ethereum.circulating) || 0);
  const bsc = h.bsc_exchanges || [];
  const eth = (h.eth_holders || []).filter(x => !/bridge/i.test(x.type || ""));
  const sum = a => a.reduce((t,x)=>t+x.rio, 0);
  // A venue is "dead" if it carries a note (currently set by hand from the
  // CoinGecko ticker list: no listing at all, or negligible volume on a huge
  // spread). Applies to both sides, not just BNB.
  const dead = sum(bsc.filter(x=>x.note)) + sum(eth.filter(x=>x.note));
  const onVenues = sum(bsc) + sum(eth);
  // Staked RIO (native multistaking module) is already inside circulating;
  // null when the snapshot predates the field, and the page then hides that row.
  const nat = c.realio_native || {};
  const staked = typeof nat.staked === "number" ? nat.staked : null;
  const elsewhere = circ - liquidChains - (staked || 0);
  return {circ, liquidChains, onVenues, withMarket: onVenues - dead, dead, staked, elsewhere};
}

/* Legacy deep links. The supply page used to be the site root, so
   realiostats.com/#<id> links are out in the wild. The root is now the
   overview page and the supply page lives at supply.html. A fragment never
   reaches the server, so Cloudflare _redirects cannot fix this; it has to
   happen in the browser. */
(function(){
  var moved = { holders:"holders.html",
                method:"methodology.html", faq:"methodology.html",
                contribute:"methodology.html",
                liquidity:"supply.html", emissions:"supply.html", chains:"supply.html",
                excluded:"supply.html", chart:"supply.html", provenance:"supply.html",
                calculator:"supply.html", proj:"supply.html" };
  var here = location.pathname.replace(/\/index\.html$/, "/");
  if(here !== "/" && !/\/$/.test(here)) return;      // only rewrite from the root
  var id = location.hash.slice(1);
  if(moved[id]) location.replace(moved[id] + "#" + id);
})();

/* Theme. Dark is the default; the nav button switches to light and the choice
   is remembered per browser. The attribute itself is set by a one-line script
   in each page's <head>, before first paint, so there is no flash.

   Charts cannot read CSS, so they take colours from T(), which reads the
   --chart-* tokens. On a switch, retheme() swaps every old token value for the
   new one inside each live chart's own config and redraws it. Custom canvas
   drawing (the supply chart's era markers, the watermark) calls T() at draw
   time, so it follows automatically. */
function T(){
  const cs = getComputedStyle(document.documentElement);
  const g = k => cs.getPropertyValue(k).trim();
  return { ink:g("--chart-ink"), grid:g("--chart-grid"), tick:g("--chart-tick"),
           guide:g("--chart-guide"), wm:g("--chart-wm"), bg:g("--bg") };
}
/* Shared chart styling, so every chart on the site looks like one family:
   translucent fills that fade downward, smooth lines, no point markers until
   hover, dot legends and a dark rounded tooltip. */
const hexA = (h,a) => { const n=parseInt(h.slice(1),16); return `rgba(${n>>16&255},${n>>8&255},${n&255},${a})`; };
// colour may be a hex string or a function returning one (read at draw time,
// so fills follow a theme switch).
function fadeFill(color, top, bottom){
  return ctx => {
    const c = typeof color === "function" ? color() : color;
    const a = ctx.chart.chartArea;
    if(!a) return hexA(c, (top+bottom)/2);
    const g = ctx.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom);
    g.addColorStop(0, hexA(c, top)); g.addColorStop(1, hexA(c, bottom));
    return g;
  };
}
function chartLegend(){
  return {labels:{color:T().ink,font:{family:"Inter",size:12},boxWidth:8,boxHeight:8,usePointStyle:true,pointStyle:"circle",padding:16,
    generateLabels:ch=>Chart.defaults.plugins.legend.labels.generateLabels(ch).map(l=>{
      const ds=ch.data.datasets[l.datasetIndex], c=ds.legendColor||ds.borderColor;
      return typeof c==="string" ? {...l, fillStyle:c, strokeStyle:c} : l; })}};
}
function chartTooltip(callbacks){
  return {backgroundColor:"rgba(15,20,26,.94)",borderColor:"rgba(255,255,255,.08)",borderWidth:1,padding:12,cornerRadius:10,
    titleColor:"#f0f4f7",bodyColor:"#cfd8df",footerColor:"#f0f4f7",boxPadding:4,usePointStyle:true,callbacks:callbacks||{}};
}
const LINE_STYLE = {borderWidth:2, tension:.35, cubicInterpolationMode:"monotone",
  pointRadius:0, pointHoverRadius:4, pointHitRadius:8, pointBorderWidth:2};

function applyChartDefaults(){
  if(!window.Chart) return;
  const t = T();
  Chart.defaults.color = t.tick;
  Chart.defaults.borderColor = t.grid;
}
function retheme(from, to){
  const map = {};
  Object.keys(from).forEach(k => { if(from[k] && from[k] !== to[k]) map[from[k]] = to[k]; });
  const walk = (o, depth) => {
    if(!o || typeof o !== "object" || depth > 9) return;
    for(const k of Object.keys(o)){
      const v = o[k];
      if(typeof v === "string"){ if(map[v]) o[k] = map[v]; }
      else if(Array.isArray(v)){
        for(let i=0;i<v.length;i++){
          if(typeof v[i] === "string"){ if(map[v[i]]) v[i] = map[v[i]]; }
          else if(v[i] && typeof v[i] === "object") walk(v[i], depth+1);
        }
      }
      else if(v && typeof v === "object" && k !== "chart") walk(v, depth+1);
    }
  };
  if(!window.Chart) return;
  Object.values(Chart.instances || {}).forEach(ch => {
    try{ walk(ch.config.options, 0); walk(ch.config.data, 0); ch.update("none"); }catch(e){}
  });
}
function toggleTheme(){
  const root = document.documentElement;
  const from = T();
  const next = root.dataset.theme === "light" ? "dark" : "light";
  root.dataset.theme = next;
  try{ localStorage.setItem("rs-theme", next); }catch(e){}
  applyChartDefaults();
  retheme(from, T());
}
applyChartDefaults();

/* Overview page (body[data-summary]). It shows a handful of blocks from the
   supply, holders and network pages by loading those pages' own scripts
   unchanged, so every number is computed by exactly the same code as on the
   full pages. Those scripts write to elements the overview does not have, so
   here, and only here, a missing id resolves to a detached placeholder and a
   chart aimed at one is not built. On every other page behaviour is untouched. */
(function(){
  if(!document.body || !document.body.hasAttribute("data-summary")) return;
  const real = document.getElementById.bind(document);
  document.getElementById = id => real(id) || document.createElement("div");
  if(window.Chart){
    const RealChart = window.Chart;
    window.Chart = new Proxy(RealChart, {
      construct(target, args){
        const el = args[0];
        if(!(el && el.isConnected && el.tagName === "CANVAS"))
          return { destroy(){}, update(){}, data:{datasets:[]}, options:{} };
        return Reflect.construct(target, args);
      }
    });
  }
})();
