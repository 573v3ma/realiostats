/* realiostats — supply page. Hero, projector, emissions & integrity,
   per-chain grid, exclusions, evolution chart. Requires assets/core.js. */

/* ---- per-chain history, read from archive nodes (Sep 2026) -----------------
   HISTORY is public float per chain since the migration, the default view.
   Points before the live daily series used to be interpolated; they are now
   read at the date shown (contract totalSupply for Ethereum and BNB Chain,
   native supply less the community pool, Algorand's fixed 100M less the
   reserve and bridge wallet balances at that block). Stellar float is held
   flat at its live value because public Horizon keeps only about a year of
   history. Solana points are carried from the earlier reconstruction.

   PRE is the era before the migration, shown only when the reader asks for it.
   It is a different measure and is labelled as one: supply ISSUED per chain.
   Back then each chain minted its own RIO independently, with no burn-and-mint
   bridge, so the chains add up without double counting, but the Realio-held
   share cannot be reconstructed for every chain on every date.               */
const PRE = [
  {label:"Dec 2020", ethereum:92.76, bnb:0,  algorand:100, stellar:100, native:0,     solana:0},
  {label:"Jun 2021", ethereum:92.76, bnb:0,  algorand:100, stellar:100, native:0,     solana:0},
  {label:"Dec 2021", ethereum:92.76, bnb:0,  algorand:100, stellar:100, native:0,     solana:0},
  {label:"Jun 2022", ethereum:92.14, bnb:0,  algorand:100, stellar:100, native:0,     solana:0},
  {label:"Dec 2022", ethereum:74.49, bnb:0,  algorand:100, stellar:75,  native:0,     solana:0},
  {label:"Jun 2023", ethereum:74.49, bnb:0,  algorand:100, stellar:75,  native:45.47, solana:0},
  {label:"Dec 2023", ethereum:74.49, bnb:75, algorand:100, stellar:75,  native:47.11, solana:0},
  {label:"Mar 2024", ethereum:74.49, bnb:75, algorand:100, stellar:75,  native:48.12, solana:0},
  {label:"Jun 2024", ethereum:74.49, bnb:75, algorand:100, stellar:75,  native:48.67, solana:0},
  {label:"Sep 2024", ethereum:74.49, bnb:75, algorand:100, stellar:75,  native:49.43, solana:0},
  {label:"Oct 2024", ethereum:74.49, bnb:75, algorand:100, stellar:75,  native:49.88, solana:0}
];
const HISTORY = [
  {label:"Dec 2024", bnb:118.65, native:58.09, ethereum:56.81, algorand:56.36, stellar:5.86, solana:0},
  {label:"Mar 2025", bnb:143.00, native:66.14, ethereum:59.63, algorand:55.59, stellar:5.86, solana:0.5},
  {label:"Jun 2025", bnb:163.25, native:73.65, ethereum:65.83, algorand:49.47, stellar:5.86, solana:1.0},
  {label:"Sep 2025", bnb:162.24, native:74.29, ethereum:66.47, algorand:48.93, stellar:5.86, solana:1.0},
  {label:"Dec 2025", bnb:143.96, native:92.96, ethereum:64.40, algorand:48.21, stellar:5.86, solana:1.0},
  {label:"Mar 2026", bnb:143.80, native:92.16, ethereum:66.88, algorand:47.88, stellar:5.86, solana:1.04},
  {label:"Jun 2026", bnb:156.44, native:83.97, ethereum:69.54, algorand:7.73,  stellar:5.86, solana:1.07}
];
const STACK = [
  {key:"native",   name:"Realio Native", color:"#10b981"},
  {key:"bnb",      name:"BNB Chain",     color:"#f59e0b"},
  {key:"ethereum", name:"Ethereum",      color:"#4f46e5"},
  {key:"algorand", name:"Algorand",      color:"#0ea5e9"},
  {key:"stellar",  name:"Stellar",       color:"#64748b"},
  {key:"solana",   name:"Solana",        color:"#a855f7"}
];

const CHAINS = [
  {key:"bnb",       name:"BNB Chain",       color:"#f59e0b", verify:"https://bscscan.com/token/0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0#balances"},
  {key:"realio_native",name:"Realio Native",color:"#10b981", verify:"https://explorer.nodestake.org/realio"},
  {key:"ethereum",  name:"Ethereum",        color:"#4f46e5", verify:"https://etherscan.io/token/0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0"},
  {key:"algorand",  name:"Algorand",        color:"#0ea5e9", verify:"https://allo.info/asset/2751733"},
  {key:"stellar",   name:"Stellar",         color:"#64748b", verify:"https://stellar.expert/explorer/public/asset/RIO-GBNLJIYH34UWO5YZFA3A3HD3N76R6DOI33N4JONUOHEEYZYCAYTEJ5AK"},
  {key:"solana",    name:"Solana",          color:"#a855f7", verify:"https://solscan.io/token/HELn8rSM1rp8vAjNH4NYXzX6FvCbwWMGqLfaMgiBnZFV"},
  {key:"base",      name:"Base",            color:"#3b82f6", verify:"https://basescan.org/token/0x5e64c9049455b3bb6e9fbdc33565fa313bae9b53", note:"counted on Ethereum"}
];

// What this measures: RIO that came into existence, so it can be compared like
// for like against scheduled emission.
//
// NOT global_total_rio (= tradable + all excluded balances). That double-counts
// a lock-and-mint bridge: RIO locked in the Stellar escrow stays counted under
// "excluded" while the RIO minted against it is counted on the destination
// chain. Verified 17 Jul 2026, when a Stellar->BSC bridge (707,924.83 locked
// 19:41:55, minted 19:42:10, 15s apart) pushed global_total to +726,539/day, a
// 37x false positive.
//
// NOT tradable_total alone either. Float also grows when Realio releases
// pre-existing RIO from a team wallet, which is not new supply. Over 11-17 Jul
// the Algorand wallets released 33,991 RIO, pushing tradable ~9% above schedule
// with nothing minted.
//
// So: tradable_total + Algorand team-held. Adding those back cancels the
// release, leaving emission minus burns. The Stellar treasury is deliberately
// NOT added back: it is proven bridge escrow, and its flows already net to zero
// inside tradable_total, so adding it would reintroduce the bug inverted.
//
// Caveat: assumes the Algorand "bridge wallet" is a team wallet rather than
// escrow. Evidence supports it (uniform 3,999 drips to one fixed address, not
// user-shaped bridge withdrawals) but it is unconfirmed. If it is escrow, an
// Algorand->EVM bridge would read as a false positive here.
// 25 Aug 2026: the Algorand "compromised" bucket is added back here for exactly
// the same reason reserve and bridge_wallet are. Those RIO were already in
// existence and already excluded from float; they simply changed hands. Without
// the add-back the emptied reserve reads as a 42.8M burn, which is nonsense.
// The Stellar compromised bucket is deliberately NOT added back, mirroring the
// Stellar treasury, which has never been added back either: doing so would
// rebase the whole historical series by ~69.6M and manufacture a false spike.
// 25 Aug 2026, second revision: add back only the EXCLUDED portion of the
// compromised bucket. The rest came out of holder wallets, is counted as float
// again, and adding it here would double-count it. Older rows have no
// compromised_excluded field, so fall back to the full figure, which is what the
// split was before any of it was reclassified.
function teamHeld(s){
  const a = (s.chains && s.chains.algorand) || {};
  if(typeof a.reserve !== "number" || typeof a.bridge_wallet !== "number") return null;
  const comp = (typeof a.compromised_excluded === "number") ? a.compromised_excluded
             : (typeof a.compromised === "number" ? a.compromised : 0);
  return a.reserve + a.bridge_wallet + comp;
}
function netNewSupply(s){
  const t = teamHeld(s);
  return (typeof s.tradable_total === "number" && t !== null) ? s.tradable_total + t : null;
}

// Multi-day net-new = the MEDIAN of the per-day deltas, not first-vs-last.
// Endpoint-to-endpoint is fragile: if the first or last snapshot happens to
// catch a cross-chain bridge mid-settlement (one leg burned, the matching mint
// not yet landed), that single dip skews the whole multi-day figure. On 24 Jul
// the endpoint method read 16,748 (below expected) purely because that day's
// snapshot caught a bridge in flight; ending one day earlier it read 17,547.
// The median ignores such one-off spikes (7,677 / 30,226 / 8,366 in this window
// are all bridge-timing days) and tracks the true issuance rate.
function computeObserved(arr){
  const pts = (arr||[]).filter(s=>netNewSupply(s)!==null);
  if(pts.length<2) return null;
  const rates=[];
  for(let i=1;i<pts.length;i++){
    const d=(new Date(pts[i].ts)-new Date(pts[i-1].ts))/864e5;
    if(d>0) rates.push((netNewSupply(pts[i])-netNewSupply(pts[i-1]))/d);
  }
  if(!rates.length) return null;
  const sorted=rates.slice().sort((x,y)=>x-y);
  const mid=Math.floor(sorted.length/2);
  const median = sorted.length%2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
  const days=(new Date(pts[pts.length-1].ts)-new Date(pts[0].ts))/864e5;
  if(days<0.5) return null;
  return {days, perDay:median, samples:rates.length};
}
// Most recent consecutive pair of snapshots = the freshest reading available.
// Unlike computeObserved (which averages across the whole series and so smooths
// harder the longer the series gets), this stays at daily resolution: it shows
// whether net-new is easing off, and can legitimately go negative on a day when
// burns exceed emission. One sample, so it is noisier - cross-chain bridge
// transfers are not atomic, and a snapshot landing mid-transfer skews the day.
function computeLast24h(arr){
  const pts = (arr||[]).filter(s=>netNewSupply(s)!==null);
  if(pts.length<2) return null;
  const a=pts[pts.length-2], b=pts[pts.length-1];
  const days=(new Date(b.ts)-new Date(a.ts))/864e5;
  if(!(days>0)) return null;
  const d=netNewSupply(b)-netNewSupply(a);
  return {days, netNew:d, perDay:d/days};
}

// "What moved" — decompose the latest 24h into per-chain deltas (Tier 1) and a
// plain-language read of observed vs expected (Tier 2). Everything here comes
// from data already committed in supply-history.json; nothing new is fetched.
function circOf(s, key){
  const c = s.chains && s.chains[key];
  if(!c) return 0;
  const v = (c.circulating != null ? c.circulating
           : c.total != null ? c.total
           : c.total_supply);
  return typeof v === "number" ? v : 0;
}
function computeWhatMoved(arr, expectedDaily){
  const pts = (arr||[]).filter(s=>netNewSupply(s)!==null);
  if(pts.length < 2) return null;
  const a = pts[pts.length-2], b = pts[pts.length-1];
  const days = (new Date(b.ts) - new Date(a.ts)) / 864e5;
  if(!(days > 0)) return null;

  // Per-chain deltas as daily rates. Algorand is shown on the team-adjusted
  // basis (reserve+bridge added back) so releasing pre-existing RIO into float
  // does not masquerade as new supply, matching the net-new figure.
  const perChain = CHAINS.map(c=>{
    let d;
    if(c.key === "algorand"){
      const teamA = (a.chains.algorand.reserve||0)+(a.chains.algorand.bridge_wallet||0);
      const teamB = (b.chains.algorand.reserve||0)+(b.chains.algorand.bridge_wallet||0);
      d = (circOf(b,"algorand")+teamB) - (circOf(a,"algorand")+teamA);
    } else if(c.key === "base"){
      d = 0; // backing locked on Ethereum, always counts 0
    } else {
      d = circOf(b,c.key) - circOf(a,c.key);
    }
    return {key:c.key, name:c.name, color:c.color, perDay:d/days};
  }).filter(x=>Math.abs(x.perDay) >= 1)
    .sort((x,y)=>Math.abs(y.perDay)-Math.abs(x.perDay));

  const net = netNewSupply(b)-netNewSupply(a);
  const perDay = net/days;
  const exp = expectedDaily || 0;
  const gap = exp - perDay;  // positive gap = observed below emission

  // The two chains moving hardest in opposite directions: the signature of a
  // cross-chain bridge whose two legs straddle the snapshot boundary.
  const ups = perChain.filter(x=>x.perDay>0), downs = perChain.filter(x=>x.perDay<0);
  const biggestUp = ups[0], biggestDown = downs[0];
  const offsetting = biggestUp && biggestDown &&
    Math.min(biggestUp.perDay, -biggestDown.perDay) > Math.max(2*exp, 40000);

  return {days, perChain, perDay, exp, gap, offsetting};
}

// Sparkline. minRangePct is the honesty control: a plain min/max scale stretches
// ANY series to fill the box, so a 0.06% drift renders as a mountain range. If
// the real spread is smaller than minRangePct of the midpoint, the scale is
// widened so the line renders flat, which is what actually happened. Circulating
// supply moves ~0.06% in ten days and MUST look flat; price and volume swing
// tens of percent and are unaffected.
function drawSpark(id, pts, label, minRangePct){
  const svg = document.getElementById(id);
  if(!svg) return;
  if(!pts || pts.length < 2){ svg.style.display = "none"; return; }
  const W = +svg.getAttribute("width") || 132, H = 26, PAD = 3;
  let min = Math.min(...pts), max = Math.max(...pts);
  const mid = (min + max) / 2 || 1;
  const floor = Math.abs(mid) * (minRangePct || 0) / 100;
  if((max - min) < floor){ min = mid - floor/2; max = mid + floor/2; }
  const span = (max - min) || 1;
  const x = i => i * (W / (pts.length - 1));
  const y = n => H - PAD - ((n - min) / span) * (H - PAD*2);
  const line = pts.map((n,i)=>`${i?"L":"M"}${x(i).toFixed(1)},${y(n).toFixed(1)}`).join(" ");
  svg.innerHTML =
    `<path d="${line} L${W},${H} L0,${H} Z" fill="rgba(52,211,153,.14)"/>`+
    `<path d="${line}" fill="none" stroke="#34d399" stroke-width="1.5" `+
    `stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`+
    `<circle cx="${x(pts.length-1).toFixed(1)}" cy="${y(pts[pts.length-1]).toFixed(1)}" r="2.2" fill="#34d399"/>`;
  svg.setAttribute("role","img");
  svg.setAttribute("aria-label", label);
}

// Shared change chip. deadband suppresses direction for moves too small to mean
// anything, so it reads "flat" rather than implying a trend from noise.
function setChg(id, pct, deadband, tip){
  const el = document.getElementById(id);
  if(!el || typeof pct !== "number") return;
  const dir = pct > deadband ? "up" : (pct < -deadband ? "down" : "flat");
  el.className = "chg " + dir;
  el.textContent = (dir==="up"?"▲ ":dir==="down"?"▼ ":"") + (pct>=0?"+":"") + pct.toFixed(pct===0?0:2).replace(/\.?0+$/,"") + "%";
  el.title = tip;
}

// Last committed volume history, kept so the live refresh can compute a
// day-over-day change against yesterday's reading.
let VOLHIST = null;

// Progressive enhancement: the page renders instantly from the committed daily
// snapshot, then upgrades price, market cap and volume to live values if the
// browser can reach CoinGecko. Rationale: SUPPLY is our own measurement and its
// git history is the audit trail, so it stays on the daily snapshot. Price and
// volume are third-party conveniences where staleness is just wrong: a snapshot
// taken 16h earlier showed +15.91% while the real 24h move was -1.52%, the wrong
// number AND the wrong direction.
//
// CoinGecko does send Access-Control-Allow-Origin when the request carries an
// Origin header, so this works from the browser. (A server-side curl without an
// Origin shows no CORS header, which is misleading.) If the call fails or is
// rate-limited, the snapshot values simply remain, timestamped.
function applyLiveMarket(latest){
  fetch("https://api.coingecko.com/api/v3/simple/price?ids=realio-network"
       +"&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true",{cache:"no-store"})
    .then(r=>r.ok?r.json():null)
    .then(j=>{
      const d = j && j["realio-network"];
      if(!d) return;
      const p = d.usd;
      if(typeof p === "number" && p > 0){
        document.getElementById("priceNum").textContent = "$"+p.toFixed(4);
        document.getElementById("priceSrc").textContent = "via coingecko · live";
        setChg("priceChg", d.usd_24h_change, 0.5, "CoinGecko 24h change, live");
        const supply = latest && latest.tradable_total;
        if(supply){
          document.getElementById("mcapNum").textContent = fmtUsd(supply * p);
          // Market cap tracks price almost exactly: supply moves ~0.006%/day.
          setChg("mcapChg", d.usd_24h_change, 0.5, "tracks price; supply moves ~0.006% per day");
        }
        // Refresh the projector against the live price, and derive the aggregator
        // supply from CoinGecko's own market cap (mcap / price = their ~100M).
        CURRENT_PRICE = p;
        if(typeof d.usd_market_cap === "number" && d.usd_market_cap > 0) PROJ_AGG_SUPPLY = d.usd_market_cap / p;
        if(PROJ_SUPPLY){ const cur = projParse(document.getElementById("projPrice").value) || 1; renderProjector(cur, "live"); }
      }
      const v = d.usd_24h_vol;
      if(typeof v === "number" && v > 0){
        document.getElementById("volNum").textContent = fmtUsd(v);
        // Change vs yesterday's committed end-of-day reading, so both sides are
        // trailing-24h figures roughly a day apart.
        const daily = VOLHIST && VOLHIST.daily;
        if(daily && daily.length){
          const prev = daily[daily.length-1].volume_usd;
          if(prev) setChg("volChg", (v-prev)/prev*100, 0.5, "versus yesterday's reading");
        }
      }
    })
    .catch(()=>{});
}

// Volume + price trend, from volume-history.json (third-party, regenerated
// daily). Separate from render() because it is a separate file with its own
// failure mode: if it is missing or stale, the headline figures from the
// snapshot still show, just without the change and sparkline. Never touches the
// integrity checks.
function renderVolumeTrend(v){
  if(!v) return;
  if(typeof v.latest_usd === "number"){
    document.getElementById("volNum").textContent = fmtUsd(v.latest_usd);
    document.getElementById("volSrc").innerHTML =
      'exchange-reported · <a href="https://www.coingecko.com/en/coins/realio-network" target="_blank" rel="noopener">see markets</a>';
  }
  setChg("volChg", v.change_24h_pct, 0.5, "versus the same 24h window one day earlier");
  const vp = (v.daily||[]).map(d=>d.volume_usd).filter(n=>typeof n === "number");
  drawSpark("volSpark", vp, `Reported 24h trading volume over the last ${vp.length} days`, 0);

  setChg("priceChg", v.price_change_24h_pct, 0.5, "versus 24 hours earlier");
  const pp = (v.price_daily||[]).map(d=>d.price_usd).filter(n=>typeof n === "number");
  drawSpark("priceSpark", pp, `RIO price over the last ${pp.length} days`, 0);
}

// Circulating market cap trend. Deliberately NOT CoinGecko's market cap, which
// is computed from their hard-coded 100M circulating supply, the very figure
// this site disputes. This series is our own: tradable_total x price, as
// recorded in each snapshot, so it is internally consistent with the headline.
// That also means it only reaches back to the first snapshot, not 30 days.
function renderMcapTrend(arr){
  const pts = (arr||[]).map(s=>s.market_cap_usd).filter(n=>typeof n === "number");
  if(pts.length < 2) return;
  const prev = pts[pts.length-2], last = pts[pts.length-1];
  setChg("mcapChg", (last-prev)/prev*100, 0.5, "versus the previous daily snapshot");
  drawSpark("mcapSpark", pts, `Circulating market cap over the last ${pts.length} days`, 2);
}

// NOTE: there is deliberately no circulating-supply trend in the hero. A raw
// tradable_total series grows through BOTH emission and pre-existing RIO being
// released from team wallets, so its per-day rate (19,655 over 11-21 Jul) does
// not match the Emissions panel's new-supply rate (17,589), which adds team-held
// balances back. Two "RIO/day" figures with different definitions on one page
// caused real confusion. Supply-over-time lives in the Evolution chart, and
// per-day rates live in the Emissions panel, each defined once.

// Renders the "what moved today" block under the integrity line: per-chain
// deltas (Tier 1) and a plain-language observed-vs-expected read (Tier 2).
function renderWhatMoved(arr, expectedDaily){
  const box = document.getElementById("whatMoved");
  const wm = computeWhatMoved(arr, expectedDaily);
  if(!wm || !wm.perChain.length){ if(box) box.hidden = true; return; }
  box.hidden = false;

  document.getElementById("wmChips").innerHTML = wm.perChain.map(x=>{
    const dir = x.perDay >= 0 ? "up" : "down";
    const s = x.perDay >= 0 ? "+" : "−";
    return `<span class="wm-chip"><span class="cdot" style="background:${x.color}"></span>`+
           `<span class="wm-name">${x.name}</span>`+
           `<span class="wm-val ${dir}">${s}${fmtInt(Math.abs(x.perDay))}</span></span>`;
  }).join("");

  const win = Math.abs(wm.days-1) < 0.15 ? "In the last 24h" : `Over the last ${wm.days.toFixed(1)} days`;
  let read;
  if(wm.exp && wm.gap > wm.exp*0.25){
    // Observed materially BELOW scheduled emission.
    read = `${win}, new supply ran <b>${fmtInt(wm.perDay)}/day</b>, below the scheduled <b>~${fmtInt(wm.exp)}</b>. `;
    if(wm.offsetting){
      read += `The bulk of the move is ${wm.perChain[0].name} and ${wm.perChain.find(x=>Math.sign(x.perDay)!==Math.sign(wm.perChain[0].perDay)).name} moving in opposite directions, the signature of a bridge transfer whose two legs straddle the snapshot. That kind of gap usually reverses on the next reading.`;
    } else {
      read += `Because bridging nets to zero globally, a shortfall like this reflects burns over the window (for example Districts land claims), or a bridge settling across the snapshot boundary. Both leave supply below the emission line, and only the next reading distinguishes them.`;
    }
  } else if(wm.exp && wm.perDay > wm.exp*1.25){
    read = `${win}, new supply ran <b>${fmtInt(wm.perDay)}/day</b>, above the scheduled <b>~${fmtInt(wm.exp)}</b>. The chains below show where it came from; a sustained excess with no matching burn elsewhere is what would warrant a closer look.`;
  } else {
    read = `${win}, new supply ran <b>${fmtInt(wm.perDay)}/day</b>, in line with the scheduled <b>~${fmtInt(wm.exp)}</b>. The chains below show where the movement was; cross-chain shifts net out, leaving emission minus burns.`;
  }
  document.getElementById("wmRead").innerHTML = read;
}

// Price-to-market-cap projector. Pure arithmetic (mcap = price x supply) on our
// multichain circulating supply. Two-way price <-> mcap, a log-scaled slider,
// presets, a live multiple vs today's price, and the aggregator-supply contrast
// that makes the point: the same price implies a ~3x larger cap on the real
// supply than on the ~100M aggregators report. It forecasts nothing.
let PROJ_SUPPLY = null, PROJ_AGG_SUPPLY = 100e6, CURRENT_PRICE = null;
const PROJ_MIN = 0.01, PROJ_MAX = 10;
const projParse = s => parseFloat(String(s).replace(/[^0-9.]/g, ""));
const projFmtPrice = p => p>=1 ? p.toFixed(2) : p.toFixed(4);
const projSliderToPrice = v => PROJ_MIN*Math.pow(PROJ_MAX/PROJ_MIN, v/1000);
const projPriceToSlider = p => Math.round(1000*Math.log(Math.min(PROJ_MAX,Math.max(PROJ_MIN,p))/PROJ_MIN)/Math.log(PROJ_MAX/PROJ_MIN));

function renderProjector(price, from){
  if(!PROJ_SUPPLY || !(price>0)) return;
  const mcap = price*PROJ_SUPPLY;
  // "hold" edits must not reformat the price/mcap/slider the user set.
  if(from!=="price"  && from!=="hold") document.getElementById("projPrice").value = projFmtPrice(price);
  if(from!=="mcap"   && from!=="hold") document.getElementById("projMcap").value  = Math.round(mcap).toLocaleString("en-US");
  if(from!=="slider" && from!=="hold") document.getElementById("projSlider").value = projPriceToSlider(price);
  // Optional personal readout: value of the holdings the user entered.
  const holdEl = document.getElementById("projHold");
  const hv = holdEl ? projParse(holdEl.value) : NaN;
  const holdOut = document.getElementById("projHoldOut");
  if(hv > 0){
    let t = "would be worth <b>"+fmtBig(hv*price)+"</b> at $"+projFmtPrice(price);
    if(CURRENT_PRICE>0) t += " · "+fmtBig(hv*CURRENT_PRICE)+" today";
    holdOut.innerHTML = t;
  } else {
    holdOut.innerHTML = "";
  }
  const mult = document.getElementById("projMult");
  if(CURRENT_PRICE>0){
    const x = price/CURRENT_PRICE;
    mult.innerHTML = "<b>"+fmtBig(mcap)+"</b> market cap · about <b>"+(x>=1?x.toFixed(1):x.toFixed(2))+"x</b> from today's $"+projFmtPrice(CURRENT_PRICE);
  } else {
    mult.innerHTML = "<b>"+fmtBig(mcap)+"</b> circulating market cap";
  }
}
function initProjector(supply){
  if(!(supply>0)) return;
  PROJ_SUPPLY = supply;
  const presets=[[0.10,"$0.10"],[0.50,"$0.50"],[1,"$1"],[3,"$3"],[5,"$5"],[5.12,"$5.12 · 2020 ATH"]];
  document.getElementById("projPresets").innerHTML =
    presets.map(p=>`<button type="button" class="proj-preset" data-p="${p[0]}">${p[1]}</button>`).join("");
  document.getElementById("projPresets").addEventListener("click",e=>{
    const b=e.target.closest(".proj-preset"); if(b) renderProjector(parseFloat(b.dataset.p),"preset");
  });
  const pIn=document.getElementById("projPrice"), mIn=document.getElementById("projMcap"), sl=document.getElementById("projSlider");
  pIn.addEventListener("input",()=>{ const v=projParse(pIn.value); if(v>0) renderProjector(v,"price"); });
  mIn.addEventListener("input",()=>{ const v=projParse(mIn.value); if(v>0) renderProjector(v/PROJ_SUPPLY,"mcap"); });
  sl.addEventListener("input",()=>renderProjector(projSliderToPrice(+sl.value),"slider"));
  document.getElementById("projHold").addEventListener("input",()=>renderProjector(projParse(pIn.value)||1,"hold"));
  renderProjector(1.00,"init");
}

function render(latest, liveSeries, fullArr){
  const multi = latest.tradable_total;
  document.getElementById("multiNum").textContent = fmtM(M(multi));
  document.getElementById("totalNum").textContent = fmtM(M(multi)) + " RIO";
  // price + circulating market cap
  const price = latest.price_usd, mcap = latest.market_cap_usd ?? (price ? multi*price : null);
  document.getElementById("priceNum").textContent = price ? "$"+price.toFixed(4) : "n/a";
  // Snapshot price is up to 24h old. Show WHEN it was taken rather than the
  // vague "at refresh"; applyLiveMarket() replaces this with "live" if the
  // browser can reach CoinGecko.
  const pts_ = new Date(latest.ts);
  const stamp = pts_.toLocaleDateString("en-GB",{day:"numeric",month:"short"})+" "+
                String(pts_.getUTCHours()).padStart(2,"0")+":"+String(pts_.getUTCMinutes()).padStart(2,"0")+" UTC";
  document.getElementById("priceSrc").textContent =
    (latest.price_source ? "via "+latest.price_source+" · " : "") + stamp;
  document.getElementById("mcapNum").textContent = mcap ? fmtUsd(mcap) : "n/a";
  // Exchange-reported, not measured on chain. Informational only: it is never
  // used by the supply-integrity checks. Null on days the CoinGecko call failed
  // and a price-only fallback served instead, shown as "unavailable" rather
  // than carrying the previous day forward.
  const vol = latest.volume_24h_usd;
  document.getElementById("volNum").textContent = vol ? fmtUsd(vol) : "n/a";
  document.getElementById("volSrc").innerHTML = vol
    ? 'exchange-reported · <a href="https://www.coingecko.com/en/coins/realio-network" target="_blank" rel="noopener">see markets</a>'
    : 'unavailable at last refresh';
  const d = new Date(latest.ts);
  document.getElementById("updated").textContent = d.toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"});

  // emissions & supply integrity
  const mint = latest.mint || {};
  const infl = mint.inflation_rate;
  document.getElementById("emRate").textContent = infl ? (infl*100).toFixed(1)+"% / yr" : "n/a";
  const ed = latest.expected_daily_emission_rio, ea = latest.expected_annual_emission_rio;
  // 8% is the configured mint parameter. The chain pays a fixed reward per block
  // and produces blocks slower than the 5s that parameter assumes, so the rate
  // actually realised on supply is lower. Show it, computed from the block-
  // adjusted annual issuance over the unminted base, so it reconciles with the
  // "Expected new RIO" figure beside it instead of contradicting it.
  const nativeSupply = latest.chains && latest.chains.realio_native
    ? (latest.chains.realio_native.total ?? latest.chains.realio_native.circulating) : null;
  const unminted = (typeof nativeSupply === "number" && latest.native_cap)
    ? (latest.native_cap - nativeSupply) : null;
  document.getElementById("emRateNote").textContent =
    (latest.emission_block_adjusted && ea && unminted && unminted > 0)
      ? "configured rate · ~"+((ea/unminted)*100).toFixed(1)+"% effective at the chain's real block speed"
      : "of unminted native supply, per year";
  document.getElementById("emDaily").textContent = ed ? "~"+fmtInt(ed) : "n/a";
  document.getElementById("emAnnual").textContent = ea
    ? "per day · ~"+fmtM(M(ea))+" / yr" + (latest.emission_block_adjusted ? " · block-rate adjusted" : "")
    : "per day";
  const l24 = computeLast24h(fullArr);
  if(l24){
    const sign = l24.perDay>=0 ? "+" : "−";
    document.getElementById("emObs24").textContent = sign+fmtInt(Math.abs(l24.perDay))+" / day";
    document.getElementById("emObs24Note").textContent = Math.abs(l24.days-1)<0.15
      ? "latest snapshot vs previous"
      : "latest pair, "+l24.days.toFixed(1)+" days apart, as a daily rate";
  }
  renderMcapTrend(fullArr);
  const obs = computeObserved(fullArr);
  const dot = document.getElementById("iDot"), it = document.getElementById("iText");
  if(obs){
    document.getElementById("emObserved").textContent = (obs.perDay>=0?"+":"")+fmtInt(obs.perDay)+" / day";
    const obsDays = Math.round(obs.days);
    document.getElementById("emObservedNote").textContent = obsDays<=1 ? "measured over the last 24h" : "median day, last "+obsDays+" days";
    const pct = infl ? (infl*100).toFixed(0) : "8";
    const comp = latest.compromised_total || 0;
    const halted = (latest.flags||[]).some(f=>String(f).indexOf("NATIVE_CHAIN_HALTED")===0);
    if(comp > 0){
      // An emission read is not meaningful across an incident window. Say so
      // rather than publishing a tidy sentence over a distorted measurement.
      dot.className="idot warn";
      const compExcl = (typeof latest.compromised_excluded === "number") ? latest.compromised_excluded : comp;
      const compFloat = (typeof latest.compromised_in_float === "number") ? latest.compromised_in_float : 0;
      it.innerHTML="Emission cannot be measured cleanly across this window. On 25 August 2026 roughly 124.4M RIO moved out of Realio-controlled wallets and holder accounts across five chains. "
        +fmtInt(comp)+" RIO is still attacker-held: "+fmtInt(compExcl)+" of it was already excluded from float before the sweep and stays excluded, while "
        +fmtInt(compFloat)+" came out of holder wallets and is still counted as circulating, because being stolen does not take a token out of public hands"
        +(halted ? ". The native chain has stopped producing blocks, so its supply reading is frozen" : "")
        +". No RIO was minted on any chain. <a href=\"incident.html\">See the incident report</a>.";
    } else if(ed && obs.perDay <= ed*1.25){
      dot.className="idot ok";
      it.textContent="Circulating RIO supply is growing within the scheduled ~"+pct+"% emission. No unexplained minting detected over the measured window.";
    } else if(ed){
      dot.className="idot warn";
      it.textContent="Circulating RIO supply grew faster than the ~"+pct+"% schedule over the measured window, worth a closer look.";
    }
  }
  renderWhatMoved(fullArr, ed);

  const grid = document.getElementById("chainGrid");
  grid.innerHTML = CHAINS.map(c=>{
    const v = latest.chains[c.key]?.circulating ?? 0;
    const val = c.key==="base" ? "0" : fmtM(M(v));
    const sub = c.key==="base" ? "backing locked on Ethereum" : fmtFull(v)+" RIO";
    return `<div class="chip">
      <div class="cn"><span class="cdot" style="background:${c.color}"></span>${c.name}</div>
      <div class="cv">${val}</div>
      <div class="cx">${sub}</div>
      <div style="margin-top:8px"><a href="${c.verify}" target="_blank" rel="noopener">Verify ↗</a></div>
    </div>`;
  }).join("");

  const a = latest.chains.algorand, s = latest.chains.stellar;
  const compCards = [
    // The card shows only the portion that stays OUT of circulating. Anything the
    // attacker took from holder wallets is still counted as float, so showing the
    // full balance here would imply it had been removed from the headline figure.
    {k:"Algorand · compromised (25 Aug 2026)", v:(typeof a.compromised_excluded==="number"?a.compromised_excluded:a.compromised),
     inFloat:(typeof a.compromised_in_float==="number"?a.compromised_in_float:0),
     addr:"RCES4II33PXVDX4ISQ3TWUZN5DP7JM6ZTDBJLARYQH53O4OLN5QTNYUJ6A",
     url:"https://allo.info/account/RCES4II33PXVDX4ISQ3TWUZN5DP7JM6ZTDBJLARYQH53O4OLN5QTNYUJ6A"},
    {k:"Stellar · compromised (25 Aug 2026)", v:(typeof s.compromised_excluded==="number"?s.compromised_excluded:s.compromised),
     inFloat:(typeof s.compromised_in_float==="number"?s.compromised_in_float:0),
     addr:"GBDMMICWFVSSU5YIKIVWG6EP3U65R2GIF7BICN3JIBES5NVGFZFLWXKZ",
     url:"https://stellar.expert/explorer/public/account/GBDMMICWFVSSU5YIKIVWG6EP3U65R2GIF7BICN3JIBES5NVGFZFLWXKZ"}
  ].filter(c=>typeof c.v==="number" && c.v>0).map(c=>`
    <div class="ex"><div class="exk">${c.k}</div><div class="exv">${fmtM(M(c.v))}</div>
      <div class="exa">${c.addr}</div>
      <div class="exn">Attacker-held reserve or treasury RIO. It was outside circulating before the sweep and stays outside it.${
        c.inFloat>0 ? " A further "+fmtInt(c.inFloat)+" RIO at this address came out of holder wallets and <b>is still counted as circulating</b>, because being stolen does not take a token out of public hands." : ""
      } <a href="incident.html">Incident report</a>.</div>
      <div style="margin-top:8px"><a href="${c.url}" target="_blank" rel="noopener">Verify ↗</a></div></div>`).join("");
  document.getElementById("exclGrid").innerHTML = compCards + `
    <div class="ex"><div class="exk">Algorand · reserve</div><div class="exv">${fmtM(M(a.reserve))}</div>
      <div class="exa">GNRGAOG65JPGWVIK2Q45R4XLLVIMF7AWVBK5TEBGWRRAZ3EHPQIN44EGFA</div>
      <div style="margin-top:8px"><a href="https://allo.info/account/GNRGAOG65JPGWVIK2Q45R4XLLVIMF7AWVBK5TEBGWRRAZ3EHPQIN44EGFA" target="_blank" rel="noopener">Verify ↗</a></div></div>
    <div class="ex"><div class="exk">Algorand · bridge wallet</div><div class="exv">${fmtM(M(a.bridge_wallet))}</div>
      <div class="exa">M3IAMWFYEIJWLWFIIOEDFOLGIVMEOB3F4I3CA4BIAHJENHUUSX63APOXXM</div>
      <div style="margin-top:8px"><a href="https://allo.info/account/M3IAMWFYEIJWLWFIIOEDFOLGIVMEOB3F4I3CA4BIAHJENHUUSX63APOXXM" target="_blank" rel="noopener">Verify ↗</a></div></div>
    <div class="ex"><div class="exk">Stellar · treasury (realio.fund)</div><div class="exv">${fmtM(M(s.treasury))}</div>
      <div class="exa">GBRKMQ4IO5UURRRFLGLDIWBOWEF7ENC2BU5PB26ATAQRSWIZALE5EW2L</div>
      <div style="margin-top:8px"><a href="https://stellar.expert/explorer/public/account/GBRKMQ4IO5UURRRFLGLDIWBOWEF7ENC2BU5PB26ATAQRSWIZALE5EW2L" target="_blank" rel="noopener">Verify ↗</a></div></div>`;

  drawChart(liveSeries);
}

let EVO_CHART = null, EVO_LIVE = [], EVO_RANGE = "mig";

function setEvoRange(r){
  EVO_RANGE = r;
  document.querySelectorAll("#evoRange button").forEach(b=>{
    const on = b.dataset.range === r;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  const note = document.getElementById("evoNote");
  if(note) note.hidden = (r !== "all");
  drawChart(EVO_LIVE);
}

function drawChart(liveSeries){
  EVO_LIVE = liveSeries || EVO_LIVE;
  const all = EVO_RANGE === "all";
  /* Full history is a quarterly view: 46 daily points would squeeze five years
     of history into the left edge. The daily detail is the default view. */
  const live = all ? EVO_LIVE.slice(-1) : EVO_LIVE;
  const rows = (all ? PRE : []).concat(HISTORY, live);
  const nPre = all ? PRE.length : 0;
  const nRecon = nPre + HISTORY.length;
  const labels = rows.map(r=>r.label);
  const liveRadius = labels.map((_,i)=> i>=nRecon ? 3 : 0);
  void live;
  const datasets = STACK.map((s,i)=>({
    label:s.name, data:rows.map(r=> r[s.key] ?? 0),
    borderColor:s.color, backgroundColor:s.color+"cc",
    fill: i===0 ? "origin" : "-1", stack:"s", borderWidth:1, tension:.2,
    pointRadius:liveRadius, pointBackgroundColor:s.color, pointBorderColor:"#fff", pointBorderWidth:1
  }));
  if(!all){
    datasets.push({label:"175M native emission cap (reference)", data:labels.map(()=>175),
      borderColor:"#9aa7b2", borderWidth:1.4, borderDash:[6,5], pointRadius:0, fill:false, stack:"ref"});
  }

  /* Era divider: everything left of it is issued supply, everything right of it
     is public float. The step at the line is the change of measure, not a burn. */
  const eraPlugin = {
    id:"era",
    beforeDatasetsDraw(chart){
      if(!all) return;
      const {ctx,chartArea,scales}=chart;
      const x=(scales.x.getPixelForValue(nPre-1)+scales.x.getPixelForValue(nPre))/2;
      ctx.save();
      ctx.fillStyle="rgba(100,116,139,0.07)";
      ctx.fillRect(chartArea.left,chartArea.top,x-chartArea.left,chartArea.bottom-chartArea.top);
      ctx.restore();
    },
    afterDatasetsDraw(chart){
      const {ctx,chartArea,scales}=chart;
      ctx.save();
      ctx.font="600 11px Inter,system-ui,sans-serif";
      if(all){
        const x=(scales.x.getPixelForValue(nPre-1)+scales.x.getPixelForValue(nPre))/2;
        const yv=v=>scales.y.getPixelForValue(v);
        /* reference levels, each drawn only across the era it belongs to */
        ctx.setLineDash([6,5]);ctx.lineWidth=1.4;
        ctx.strokeStyle="rgba(192,86,63,0.75)";
        ctx.beginPath();ctx.moveTo(chartArea.left,yv(100));ctx.lineTo(x,yv(100));ctx.stroke();
        ctx.strokeStyle="rgba(154,167,178,0.95)";
        ctx.beginPath();ctx.moveTo(x,yv(175));ctx.lineTo(chartArea.right,yv(175));ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle="#c0563f";ctx.textAlign="left";
        ctx.fillText("100M whitepaper maximum", chartArea.left+8, yv(100)-6);
        ctx.fillStyle="#8b97a3";ctx.textAlign="right";
        ctx.fillText("175M native emission cap", chartArea.right-8, yv(175)-6);
        /* era divider */
        ctx.strokeStyle="rgba(15,23,42,0.4)";ctx.lineWidth=1;
        ctx.beginPath();ctx.moveTo(x,chartArea.top);ctx.lineTo(x,chartArea.bottom);ctx.stroke();
        ctx.fillStyle="#475569";
        ctx.textAlign="right";ctx.fillText("Issued supply", x-8, chartArea.top+13);
        ctx.textAlign="left"; ctx.fillText("Public float", x+8, chartArea.top+13);
        const ath=PRE.findIndex(r=>r.label==="Mar 2024");
        if(ath>=0){
          const xa=scales.x.getPixelForValue(ath);
          ctx.strokeStyle="rgba(15,23,42,0.28)";ctx.setLineDash([3,4]);
          ctx.beginPath();ctx.moveTo(xa,chartArea.top+30);ctx.lineTo(xa,chartArea.bottom);ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle="#0b1015";ctx.textAlign="right";
          ctx.fillText("All-time high", xa-6, chartArea.top+28);
        }
      } else {
        const x2=scales.x.getPixelForValue(2);
        ctx.fillStyle="rgba(100,116,139,0.14)";
        ctx.fillRect(chartArea.left,chartArea.top,x2-chartArea.left,chartArea.bottom-chartArea.top);
        ctx.strokeStyle="rgba(100,116,139,0.45)";ctx.setLineDash([4,4]);ctx.lineWidth=1;
        ctx.beginPath();ctx.moveTo(x2,chartArea.top);ctx.lineTo(x2,chartArea.bottom);ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle="#64748b";ctx.textAlign="left";
        ctx.fillText("Migration & bridge ramp (Oct 2024 to mid 2025)", chartArea.left+8, chartArea.top+13);
      }
      ctx.restore();
    }
  };

  if(EVO_CHART) EVO_CHART.destroy();
  EVO_CHART = new Chart(document.getElementById("evo"),{
    type:"line",
    data:{labels,datasets},
    plugins:[eraPlugin, watermarkPlugin],
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:300},
      interaction:{mode:"index",intersect:false},
      scales:{
        y:{stacked:true,beginAtZero:true,suggestedMax:all?400:360,grid:{color:"#eef1f4"},
           ticks:{callback:v=>v+"M",color:"#69747f",font:{family:"Inter"}}},
        x:{grid:{display:false},ticks:{color:"#69747f",font:{family:"Inter",size:11},maxRotation:0,autoSkipPadding:14}}
      },
      plugins:{
        legend:{labels:{color:"#0b1015",font:{family:"Inter",size:12},boxWidth:12,usePointStyle:true}},
        tooltip:{callbacks:{
          label:c=>` ${c.dataset.label}: ${(+c.parsed.y).toFixed(1)}M`,
          footer:items=>{
            const t=items.filter(i=>i.dataset.stack==="s").reduce((a,i)=>a+(+i.parsed.y||0),0);
            const pre = all && items.length && items[0].dataIndex < nPre;
            return (pre ? "Total issued on-chain: " : "Total circulating: ")+t.toFixed(1)+"M";}
        }}
      }
    }
  });
}

const perChain = s => ({
  label:new Date(s.ts).toLocaleDateString("en-GB",{day:"numeric",month:"short"}),
  bnb:+M(s.chains.bnb.circulating).toFixed(2),
  native:+M(s.chains.realio_native.circulating).toFixed(2),
  ethereum:+M(s.chains.ethereum.circulating).toFixed(2),
  algorand:+M(s.chains.algorand.circulating).toFixed(2),
  stellar:+M(s.chains.stellar.circulating).toFixed(2),
  solana:+M(s.chains.solana.circulating).toFixed(2)
});

/* Tradable float ladder. computeFloat() lives in core.js because the supply
   page quotes the bottom rung too; one definition, one computation, so the two
   pages cannot drift into different numbers for the same thing. */
/* What actually constrains selling is not where the coins sit, it is how thin
   the market is. The old wording here claimed the venue-held float explained
   price impact, which it does not: an exchange's hot wallet is customer custody,
   not depth on the order book. Daily traded volume is the honest anchor, and it
   is already published in volume-history.json. */
let FLOAT_F = null, FLOAT_VOL = null;
function renderFloatRead(){
  const el = document.getElementById("floatRead");
  if(!el || !FLOAT_F) return;
  const f = FLOAT_F, v = FLOAT_VOL;
  const usd = v && v.latest_usd, px = v && v.price_latest_usd;
  const rioPerDay = (usd && px) ? usd/px : null;

  let t = "What limits selling is not where the coins sit, it is how thin the market is. ";
  if(rioPerDay > 0){
    t += "Reported volume across every venue is about <b>"+fmtUsd(usd)+" a day</b>, roughly <b>"
       + fmtM(M(rioPerDay))+" RIO</b>. Even the bottom rung above is around <b>"
       + Math.round(f.withMarket/rioPerDay)+" days</b> of total global trading, and circulating supply is "
       + "about <b>"+Math.round(f.circ/rioPerDay)+" days</b> of it. ";
  } else {
    t += "Daily traded volume is a small fraction of any rung above. ";
  }
  t += "That is why a relatively modest amount of buying or selling moves the price more than the headline "
     + "market cap implies, and it cuts both ways: sharp rallies on light volume, and equally sharp falls. "
     + "None of this is fixed. Supply can bridge between chains and reach a venue in minutes, so today's "
     + "picture is a snapshot, not a permanent floor.";
  el.innerHTML = t;
}

function renderFloatLadder(latest, h){
  const el = document.getElementById("floatLadder");
  if(!el || !h || !latest) return;
  const f = computeFloat(latest, h);
  const pc = n => f.circ ? (100*n/f.circ).toFixed(1)+"%" : "—";

  const rungs = [
    {v:fmtM(M(f.circ)), sub:"circulating", cls:"",
     k:"Every RIO that exists and can be traded",
     x:"Summed once across all seven chains, net of Realio-controlled reserve, treasury and bridge "
      +'wallets. This is the <a href="#top">headline figure at the top of this page</a> and the correct '
      +"denominator "
      +"for market cap. It is not a claim that all of it could be sold."},

    {v:fmtM(M(f.liquidChains)), sub:pc(f.liquidChains)+" of circ.", cls:"",
     k:"Sitting where the volume is",
     x:"RIO on BNB Chain and Ethereum, where essentially all real exchange and DEX volume settles. Fully "
      +"on-chain with no labelling judgement, but most of it sits in ordinary wallets rather than on a "
      +"venue, so it overstates what is sellable today."},

    {v:fmtM(M(f.onVenues)), sub:pc(f.onVenues)+" of circ.", cls:"",
     k:'Identified on a venue <span class="rtag grey">a floor</span>',
     x:"Exchange wallets plus DEX pool liquidity we could identify from public explorer name tags. Bridge "
      +"escrow is excluded: it backs wrapped RIO elsewhere and cannot be traded. Smaller labelled wallets "
      +"sit below the top holders, so the true figure is somewhat higher."},

    {v:fmtM(M(f.withMarket)), sub:"already on a venue", cls:"is-final",
     k:'Sitting on a venue with a live market <span class="rtag">inventory in place</span>',
     x:"The rung above, less the <b>"+fmtM(M(f.dead))+"</b> parked on venues that list RIO but show no "
      +"functioning market. <b>This is not a ceiling on what could be sold.</b> Anything on the liquid "
      +"chains is minutes from an exchange deposit, and a swap into a DEX pool needs no deposit at all. "
      +"It measures inventory already in position, not permission to trade."}
  ];

  el.innerHTML = rungs.map(r =>
    `<div class="rung ${r.cls}">
       <div><div class="rv">${r.v}</div><span class="rvsub">${r.sub}</span></div>
       <div><div class="rk">${r.k}</div><div class="rx">${r.x}</div></div>
     </div>`).join("");

  FLOAT_F = f;
  renderFloatRead();

  document.getElementById("floatCap").innerHTML =
    "Rungs 1 and 2 are read live on-chain each day. Rungs 3 and 4 come from <code>holders.json</code>, a "
    +"dated snapshot of public explorer name tags"
    +(h.as_of ? " last refreshed <b>"+h.as_of+"</b>" : "")
    +", because wallet labels are not in any free API and balances drift as venues rotate wallets. "
    +"Percentages are computed against the current live supply, so a dated numerator is divided by a live "
    +"denominator. Treat the bottom two rungs as a well-sourced lower bound rather than an exact total: they count only venues whose wallets we could label, and several smaller markets are not yet included. "
    +"Circulating supply is unchanged by any of this: this section describes where that supply sits, not a "
    +"different supply figure.";
}

function renderHolders(latest, h){
  if(!h || !latest) return;
  renderFloatLadder(latest, h);
  const lq = document.getElementById("lqRead");
  if(lq){
    const f = computeFloat(latest, h);
    lq.innerHTML = "Circulating supply remains <b>"+fmtM(M(f.circ))+"</b>. Of that, <b>"
      +fmtM(M(f.liquidChains))+"</b> sits on the two liquid chains and <b>"+fmtM(M(f.withMarket))
      +"</b> is identifiably on a venue with an active market. Three different questions, three different "
      +"answers, and none of them changes the supply count.";
  }
  const bnb = (latest.chains && latest.chains.bnb &&
    (latest.chains.bnb.circulating ?? latest.chains.bnb.total_supply)) || 0;
  const circ = latest.tradable_total || 0;
  const body = document.getElementById("bscHoldersBody");
  if(body && Array.isArray(h.bsc_exchanges)){
    let tot = 0, wtot = 0;
    const rows = h.bsc_exchanges.slice().sort((a,b)=>b.rio-a.rio).map(x=>{
      tot += x.rio; wtot += x.wallets;
      const pB = bnb ? (100*x.rio/bnb).toFixed(1)+"%" : "—";
      const pC = circ ? (100*x.rio/circ).toFixed(1)+"%" : "—";
      const tag = x.note ? ` <span class="lq-tag">${x.note}</span>` : "";
      return `<tr><td>${x.entity}${tag}</td><td>${x.wallets}</td><td>${fmtM(M(x.rio))}</td><td>${pB}</td><td>${pC}</td></tr>`;
    }).join("");
    const tB = bnb ? (100*tot/bnb).toFixed(0)+"%" : "—";
    const tC = circ ? (100*tot/circ).toFixed(1)+"%" : "—";
    body.innerHTML = rows +
      `<tr class="lq-total"><td>Identified exchanges</td><td>${wtot}</td><td>${fmtM(M(tot))}</td><td>${tB}</td><td>${tC}</td></tr>`;
    document.getElementById("bscHoldersSub").innerHTML =
      `Held in exchange wallets, which custody user funds. Not exhaustive: smaller labelled wallets sit below the top holders, so the real exchange-held total is a little higher.`;
  }
  const eth = (latest.chains && latest.chains.ethereum &&
    (latest.chains.ethereum.circulating ?? latest.chains.ethereum.total_supply)) || 0;
  const ebody = document.getElementById("ethHoldersBody");
  if(ebody && Array.isArray(h.eth_holders)){
    let etot = 0;
    const rows = h.eth_holders.slice().sort((a,b)=>b.rio-a.rio).map(x=>{
      etot += x.rio;
      const pE = eth ? (100*x.rio/eth).toFixed(1)+"%" : "—";
      const pC = circ ? (100*x.rio/circ).toFixed(1)+"%" : "—";
      // Same "no active market" tag the BNB table shows, so the two are consistent.
      const tag = x.note ? ` <span class="lq-tag">${x.note}</span>` : "";
      return `<tr><td>${x.holder}${tag}</td><td>${x.type}</td><td>${fmtM(M(x.rio))}</td><td>${pE}</td><td>${pC}</td></tr>`;
    }).join("");
    const tE = eth ? (100*etot/eth).toFixed(1)+"%" : "—";
    const tC = circ ? (100*etot/circ).toFixed(1)+"%" : "—";
    ebody.innerHTML = rows +
      `<tr class="lq-total"><td>Identified</td><td></td><td>${fmtM(M(etot))}</td><td>${tE}</td><td>${tC}</td></tr>`;
    document.getElementById("ethHoldersSub").textContent = h.eth_dispersed_note || "";
  }
  // Bridge throttles, read live from the snapshot. Two directions, stated
  // neutrally: the EVM mint cap is the gate for off-venue RIO reaching a
  // sellable venue; the native ratelimit governs the reverse flow.
  const bc = latest.bridge_caps || {};
  const capsEl = document.getElementById("lqCaps");
  const capM = v => { const m=v/1e6; return (m%1===0 ? m.toFixed(0) : m.toFixed(2).replace(/0+$/,"")) + "M"; };
  const evmB = bc.evm_daily_mint_cap_bnb, evmE = bc.evm_daily_mint_cap_eth, nat = bc.native_bridge_ratelimit;
  if(capsEl && (evmB || evmE)){
    const evmTxt = (evmB && evmE && evmB === evmE)
      ? "<b>"+capM(evmB)+" per day</b> onto each chain"
      : "<b>"+(evmB?capM(evmB):"n/a")+"/day</b> onto BNB Chain and <b>"+(evmE?capM(evmE):"n/a")+"/day</b> onto Ethereum";
    let t = "Getting off-venue RIO onto the liquid chains is throttled on-chain. Minting onto the EVM chains is capped at "+evmTxt+
            " (a mutable limit set by the bridge admin), so that is the real speed limit on supply reaching a major venue.";
    if(nat) t += " A separate <b>"+capM(nat)+" per day</b> limit governs the opposite flow, RIO bridging onto the native chain.";
    t += " Both are read live from the contracts and the bridge module.";
    capsEl.innerHTML = t;
    capsEl.hidden = false;
  }
  if(h.as_of){
    document.getElementById("lqCap").innerHTML =
      "Holdings as of "+h.as_of+", from "+(h.source||"public explorers")+". Balances drift as wallets rotate; verify live on "+
      '<a href="https://bscscan.com/token/0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0#balances" target="_blank" rel="noopener">BscScan</a> and '+
      '<a href="https://etherscan.io/token/0x94a8b4ee5cd64c79d0ee816f467ea73009f51aa0#balances" target="_blank" rel="noopener">Etherscan</a>. '+
      "Percentages are computed against the current live supply. Circulating supply is unchanged by any of this; the section describes distribution, not a different total.";
  }
}

loadSupply().then(({arr, latest})=>{
  render(latest, arr.map(perChain), arr);
  // Projector uses our multichain supply and today's price as its anchor.
  CURRENT_PRICE = latest.price_usd || null;
  initProjector(latest.tradable_total);
  // Committed volume history first: it draws the sparklines and gives
  // applyLiveMarket a baseline for the day-over-day volume change. Then the live
  // upgrade on top. Every stage is independently catch-guarded, so a failure at
  // any point leaves the page showing the last good values rather than blanking.
  // The market-cap clarifier is the site's most load-bearing caveat, so it
  // states the actual liquid figure inline rather than only linking to it.
  // Same computeFloat() the holders page uses, so the two can never disagree.
  // Liquid float: dated venue snapshot, percentages computed live. Silent if absent.
  fetch("./holders.json",{cache:"no-store"}).then(r=>r.ok?r.json():null)
    .then(h=>renderHolders(latest,h)).catch(()=>{});
  return fetch("./volume-history.json",{cache:"no-store"})
    .then(r=>r.ok?r.json():null)
    .then(v=>{ VOLHIST = v; renderVolumeTrend(v); FLOAT_VOL = v; renderFloatRead(); })
    .catch(()=>{})
    .then(()=>applyLiveMarket(latest));
});
