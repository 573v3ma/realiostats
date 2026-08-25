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
    ctx.fillStyle = "rgba(11,16,21,0.12)";
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
function loadSupply(){
  return fetch("./supply-history.json",{cache:"no-store"})
    .then(r=>r.json())
    .then(arr=>({arr, latest:arr[arr.length-1]}))
    .catch(()=>({arr:[FALLBACK], latest:FALLBACK}));
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
  return {circ, liquidChains, onVenues, withMarket: onVenues - dead, dead};
}

/* Legacy deep links. Before the page split every section lived at
   realiostats.com/#<id>, and those URLs are out in the wild (they were the nav
   for months). A fragment never reaches the server, so Cloudflare _redirects
   cannot fix this; it has to happen in the browser. Sections still on the home
   page (#emissions, #chains, #chart, #provenance) are left alone. */
(function(){
  var moved = { holders:"holders.html",
                method:"methodology.html", faq:"methodology.html",
                contribute:"methodology.html" };
  var here = location.pathname.replace(/\/index\.html$/, "/");
  if(here !== "/" && !/\/$/.test(here)) return;      // only rewrite from the home page
  var id = location.hash.slice(1);
  if(moved[id]) location.replace(moved[id] + "#" + id);
})();
