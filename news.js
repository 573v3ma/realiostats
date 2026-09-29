/* realiostats official-updates card.
   news.json is written once a day by publish_news.py, which has already
   validated every item (official accounts only, no links in text, every
   number traceable to its source post). This file still treats it as
   untrusted: text goes in via textContent only, and the only links built
   are x.com status URLs from an allowlisted handle plus a numeric id. */
(function(){
  const X_OK = ["realio_network","derekboirun","freehold_wallet","districts_xyz"];
  const PROJECTS = ["Realio","Freehold","Districts"];
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

  const el = (tag, cls, text) => { const e = document.createElement(tag); if(cls) e.className = cls; if(text != null) e.textContent = text; return e; };
  const dayLabel = iso => { const d = new Date(iso + "T12:00:00Z"); return isNaN(d) ? iso : `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  const hhmm = ts => { const d = new Date(ts); return isNaN(d) ? "" : d.toISOString().slice(11,16) + " UTC"; };

  function sourceNode(s){
    const wrap = el("span", "nw-src");
    if(s && s.kind === "x" && X_OK.includes(String(s.handle).toLowerCase()) && /^\d{5,25}$/.test(String(s.id))){
      const a = el("a", null, "@" + s.handle);
      a.href = `https://x.com/${encodeURIComponent(s.handle)}/status/${s.id}`;
      a.target = "_blank"; a.rel = "noopener nofollow";
      wrap.append("X · ", a);
    } else if(s && s.kind === "tg" && typeof s.chat === "string"){
      wrap.textContent = "Telegram · " + s.chat;
    } else return null;
    if(s.ts) wrap.append(" · " + hhmm(s.ts));
    return wrap;
  }

  function itemNode(it){
    const li = el("li", "nw-item");
    const p = PROJECTS.includes(it.project) ? it.project : "Realio";
    const head = el("div", "nw-head");
    head.append(el("span", "nw-pill nw-" + p.toLowerCase(), p), el("span", "nw-title", it.title || ""));
    li.append(head);
    if(it.text) li.append(el("p", "nw-text", it.text));
    const srcs = (Array.isArray(it.sources) ? it.sources : []).map(sourceNode).filter(Boolean);
    if(srcs.length){ const row = el("div", "nw-srcs"); srcs.forEach(n => row.append(n)); li.append(row); }
    return li;
  }

  function dayNode(day, showHeading){
    const box = el("div", "nw-day");
    if(showHeading) box.append(el("h3", "nw-date", dayLabel(day.date)));
    const items = Array.isArray(day.items) ? day.items : [];
    if(!items.length){ box.append(el("p", "nw-quiet", "No official announcements in the 24 hours before this digest.")); return box; }
    const ul = el("ul", "nw-list"); items.forEach(it => ul.append(itemNode(it))); box.append(ul);
    return box;
  }

  function render(data){
    const days = (data && Array.isArray(data.days) ? data.days : []).filter(d => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date));
    if(!days.length) return;
    days.sort((a,b) => a.date < b.date ? 1 : -1);

    const home = document.getElementById("newsHome");
    if(home){
      const latest = days[0];
      const stamp = document.getElementById("newsStamp");
      if(stamp){
        const ageDays = Math.floor((Date.now() - Date.parse(latest.date + "T00:00:00Z")) / 864e5);
        stamp.textContent = (ageDays > 1 ? "Last digest " : "") + dayLabel(latest.date) + " · previous 24 hours";
        if(ageDays > 1) stamp.classList.add("nw-stale");
      }
      home.append(dayNode(latest, false));
      document.getElementById("overview-news").hidden = false;
    }

    const arch = document.getElementById("newsArchive");
    if(arch){ arch.textContent = ""; days.forEach(d => arch.append(dayNode(d, true))); }
  }

  fetch("news.json?t=" + Math.floor(Date.now() / 36e5), {cache: "no-cache"})
    .then(r => r.ok ? r.json() : null).then(render).catch(() => {});
})();
