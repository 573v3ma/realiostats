/* realiostats — holders page. Per-chain holder base, EVM holder evolution,
   native holder evolution. Requires core.js.
   The liquid-float section moved to the supply page (supply.js) so the caveat
   sits beside the circulating-supply figure it qualifies. */

// Holder base. A per-chain table (native read live each day; BNB reconstructed
// from full transfer history, refreshed separately; Ethereum likewise) plus
// a native evolution chart that accrues from the daily readings.
let HB_NATIVE = null, HB_EVM = null, HB_CHAINS = null;
function renderHolderTable(){
  const body = document.getElementById("hbTableBody");
  if(!body) return;
  const f = n => (n||0).toLocaleString("en-US");
  const g = (d,k) => d[k] == null ? '<td class="hb-na">n/a</td>' : `<td>${f(d[k])}</td>`;
  const row = (name,d) => d
    ? `<tr><td>${name}</td><td>${f(d.total)}</td><td>${f(d.gte_100)}</td><td>${f(d.gte_1k)}</td><td>${f(d.gte_10k)}</td>${g(d,"gte_100k")}</tr>`
    : `<tr><td>${name}</td><td colspan="5" class="hb-pending">being added</td></tr>`;
  const bnb = HB_EVM && HB_EVM.chains && HB_EVM.chains.bnb;
  const eth = HB_EVM && HB_EVM.chains && HB_EVM.chains.ethereum;
  const cx  = (HB_CHAINS && HB_CHAINS.chains) || {};
  const algo = cx.algorand, xlm = cx.stellar, sol = cx.solana, base = cx.base;
  const rows = [row("Realio Native", HB_NATIVE), row("BNB Chain", bnb), row("Ethereum", eth),
                row("Algorand", algo), row("Stellar", xlm), row("Solana", sol), row("Base", base)];
  const parts = [HB_NATIVE, bnb, eth, algo, xlm, sol, base].filter(Boolean);
  if(parts.length > 1){
    const sum = k => parts.reduce((a,d)=>a+(d[k]||0), 0);
    rows.push(`<tr class="lq-total"><td>Combined</td><td>${f(sum("total"))}</td><td>${f(sum("gte_100"))}</td><td>${f(sum("gte_1k"))}</td><td>${f(sum("gte_10k"))}</td><td>${f(sum("gte_100k"))}</td></tr>`);
  }
  body.innerHTML = rows.join("");
  const note = document.getElementById("hbTableNote");
  if(note){
    // Every row counts the same thing: addresses holding more than zero. The
    // per-chain method differs, so it is spelled out rather than implied.
    let t = "Every row counts addresses holding more than zero RIO, so the chains are comparable. "
      + "Realio Native counts each wallet's liquid + staked RIO (module accounts excluded), read live each day. "
      + "BNB Chain and Ethereum"
      + (HB_EVM && HB_EVM.as_of ? " as of " + HB_EVM.as_of : "")
      + ", each reconstructed from its full ERC-20 transfer history and reconciled against on-chain total supply. "
      + "Algorand, Stellar, Solana and Base"
      + (HB_CHAINS && HB_CHAINS.as_of ? " as of " + HB_CHAINS.as_of : "")
      + ", read from public keyless endpoints: asset balances on Algorand, accounts by asset on Stellar, "
      + "token accounts aggregated by owner on Solana, and transfer logs netted per address on Base.";
    if(xlm && xlm.trustlines) t += " Stellar shows " + f(xlm.trustlines)
      + " trustlines, but opening one costs nothing and most hold nothing, so only funded accounts are counted here.";
    if(base) t += " Base RIO is bridged from Ethereum under lock and mint, so it adds nothing to circulating supply: these are holder addresses only.";
    note.textContent = t;
  }
}

// EVM holder-base evolution (BNB + Ethereum), monthly since the Oct 2024
// migration. Reads chains.<c>.history from holders-evm.json, produced in one
// pass over each token's full transfer history. A metric toggle switches the
// threshold; both chains plot on a shared month axis.
let HB_EVM_CHART = null, HB_EVM_METRIC = "gte_100", HB_EVM_WIRED = false;
const HB_METRIC_LABEL = {gte_100:"100+ RIO", gte_1k:"1,000+ RIO", gte_10k:"10,000+ RIO", gte_100k:"100,000+ RIO", total:"All holders"};
function renderHolderEvm(){
  const card = document.getElementById("hbEvmCard"); if(!card) return;
  const cx = (HB_EVM && HB_EVM.chains) || {};
  // Base joins the two reconstructed chains: it is an EVM chain whose whole
  // transfer log fits in one public request, so its monthly history is free.
  // Algorand, Stellar and Solana stay out of this chart, snapshot only.
  const bx = (HB_CHAINS && HB_CHAINS.chains) || {};
  const have = [["Ethereum","#818cf8", cx.ethereum && cx.ethereum.history],
                ["BNB Chain","#fbbf24", cx.bnb && cx.bnb.history],
                ["Base","#38bdf8", bx.base && bx.base.history]]
               .filter(x => x[2] && x[2].length);
  if(!have.length){ card.hidden = true; return; }
  card.hidden = false;
  if(!HB_EVM_WIRED){
    document.querySelectorAll("#hbMetricRow .hb-mbtn").forEach(b => b.addEventListener("click", () => {
      HB_EVM_METRIC = b.dataset.m;
      document.querySelectorAll("#hbMetricRow .hb-mbtn").forEach(x => x.classList.toggle("is-on", x === b));
      renderHolderEvm();
    }));
    HB_EVM_WIRED = true;
  }
  const set = new Set(); have.forEach(([,,h]) => h.forEach(p => set.add(p.month)));
  const months = [...set].sort();
  const labels = months.map(m => { const [y,mo] = m.split("-");
    return new Date(y, mo-1, 1).toLocaleDateString("en-GB",{month:"short",year:"2-digit"}); });
  const series = have.map(([name,color,h]) => {
    const bym = {}; h.forEach(p => bym[p.month] = p[HB_EVM_METRIC]);
    return {name, color, data: months.map(m => bym[m] ?? null)};
  });
  // Stacked translucent bands, the same look as the supply chart: the top edge
  // of the stack is the combined total across the EVM chains shown. A chain with
  // no data yet for a month (Base before Sep 2025) stacks as zero.
  const datasets = series.map((s,i) => ({label:s.name, data:s.data.map(v => v ?? 0), borderColor:s.color,
    backgroundColor:fadeFill(s.color,.38,.12), ...LINE_STYLE, pointBackgroundColor:s.color, pointBorderColor:T().bg,
    fill: i === 0 ? "origin" : "-1", stack:"s"}));
  if(HB_EVM_CHART) HB_EVM_CHART.destroy();
  HB_EVM_CHART = new Chart(document.getElementById("hbEvmCanvas"),{
    type:"line", plugins:[watermarkPlugin], data:{labels, datasets},
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},
      scales:{
        y:{stacked:true,beginAtZero:true,grid:{color:T().grid},ticks:{color:T().tick,font:{family:"Inter"}}},
        x:{grid:{display:false},ticks:{color:T().tick,font:{family:"Inter",size:11},maxRotation:0,autoSkipPadding:14}}
      },
      plugins:{
        legend:chartLegend(),
        tooltip:chartTooltip({title:i => i[0].label + " · " + HB_METRIC_LABEL[HB_EVM_METRIC],
          label:c => ` ${c.dataset.label}: ${fmtInt(c.parsed.y)}`,
          footer:items => "Combined: " + fmtInt(items.reduce((t,i) => t + (+i.parsed.y || 0), 0))})
      }
    }
  });
}

// Native holder evolution. Same metric toggle as the EVM chart, but a single
// Realio Native line. Native cannot be reconstructed historically (no cheap
// Cosmos historical holder query), so it is counted forward only from the first
// daily reading and grows one point per day.
let HB_NAT_METRIC = "gte_100", HB_NAT_CHART = null, HB_NAT_WIRED = false, HB_NAT_PTS = [];
function renderNativeChart(){
  const card = document.getElementById("hbChartCard"); if(!card) return;
  const building = document.getElementById("hbBuilding");
  const pts = HB_NAT_PTS;
  if(!pts.length){ card.hidden = true; if(building) building.hidden = false; return; }
  card.hidden = false; if(building) building.hidden = true;
  if(!HB_NAT_WIRED){
    document.querySelectorAll("#hbNativeMetricRow .hb-mbtn").forEach(b => b.addEventListener("click", () => {
      HB_NAT_METRIC = b.dataset.m;
      document.querySelectorAll("#hbNativeMetricRow .hb-mbtn").forEach(x => x.classList.toggle("is-on", x === b));
      renderNativeChart();
    }));
    HB_NAT_WIRED = true;
  }
  const labels = pts.map(s => new Date(s.ts).toLocaleDateString("en-GB",{day:"numeric",month:"short"}));
  const data = pts.map(s => s.native_holders[HB_NAT_METRIC]);
  if(HB_NAT_CHART) HB_NAT_CHART.destroy();
  HB_NAT_CHART = new Chart(document.getElementById("holdersCanvas"),{
    type:"line",
    plugins:[watermarkPlugin],
    data:{labels, datasets:[{label:"Native, " + HB_METRIC_LABEL[HB_NAT_METRIC], data,
      borderColor:"#34d399", backgroundColor:fadeFill("#34d399",.30,0), ...LINE_STYLE,
      pointBackgroundColor:"#34d399", pointBorderColor:T().bg, fill:"origin"}]},
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},
      scales:{
        y:{beginAtZero:true,grid:{color:T().grid},ticks:{color:T().tick,font:{family:"Inter"}}},
        x:{grid:{display:false},ticks:{color:T().tick,font:{family:"Inter",size:11},maxRotation:0,autoSkipPadding:14}}
      },
      plugins:{legend:chartLegend(), tooltip:chartTooltip()}
    }
  });
}
function renderHolderBase(arr){
  const pts = (arr||[]).filter(s=>s.native_holders && typeof s.native_holders.total === "number");
  if(pts.length){ HB_NATIVE = pts[pts.length-1].native_holders; }
  renderHolderTable();
  HB_NAT_PTS = pts;
  renderNativeChart();
}

loadSupply().then(({arr})=>{
  // Native holder counts and the native evolution chart come from the same
  // daily snapshot series the supply page uses.
  renderHolderBase(arr);
  // EVM holder counts (reconstructed, refreshed separately). Fills the BNB/ETH
  // rows once loaded; native already rendered from the daily snapshot.
  fetch("./holders-evm.json",{cache:"no-store"}).then(r=>r.ok?r.json():null)
    .then(e=>{ HB_EVM = e; renderHolderTable(); renderHolderEvm(); }).catch(()=>{});
  // Algorand, Stellar, Solana and Base, read from public keyless endpoints.
  // Fills their table rows, and adds the Base line to the EVM chart.
  fetch("./holders-chains.json",{cache:"no-store"}).then(r=>r.ok?r.json():null)
    .then(c=>{ HB_CHAINS = c; renderHolderTable(); renderHolderEvm(); }).catch(()=>{});
});
