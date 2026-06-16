// Self-contained dashboard HTML (inline CSS + JS, no build step).
// Polls /api/market and /api/wallets; toggles call /api/wallets/:id/arm.
export function dashboardHtml(opts: { dryRun: boolean; market: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>42 Trading Bot</title>
<style>
  :root { --bg:#0b0e14; --card:#151a23; --line:#232b38; --fg:#e6edf3; --muted:#8b98a9;
          --green:#3fb950; --red:#f85149; --accent:#58a6ff; --warn:#d29922; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex;
           align-items:center; gap:12px; flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0; }
  .pill { font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--muted); }
  .pill.dry { color:var(--warn); border-color:var(--warn); }
  .pill.live { color:var(--red); border-color:var(--red); }
  main { padding:20px; max-width:1100px; margin:0 auto; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
  .stat { background:#0f141c; border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
  .stat .k { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  .stat .v { font-size:18px; font-weight:600; margin-top:2px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:right; padding:7px 10px; border-bottom:1px solid var(--line); }
  th:first-child, td:first-child { text-align:left; }
  th { color:var(--muted); font-weight:500; font-size:11px; text-transform:uppercase; }
  .pos { color:var(--green); } .neg { color:var(--red); } .mut { color:var(--muted); }
  .wallet-head { display:flex; align-items:center; gap:14px; cursor:pointer; flex-wrap:wrap; }
  .wallet-head .label { font-weight:600; font-size:15px; }
  .wallet-head .addr { color:var(--muted); font-family:ui-monospace,monospace; font-size:12px;
                       cursor:pointer; border-bottom:1px dashed var(--line); }
  .wallet-head .addr:hover { color:var(--accent); border-bottom-color:var(--accent); }
  .spacer { flex:1; }
  .mini { font-size:12px; color:var(--muted); }
  .switch { position:relative; width:46px; height:24px; flex:0 0 auto; }
  .switch input { opacity:0; width:0; height:0; }
  .slider { position:absolute; inset:0; background:#30363d; border-radius:999px; transition:.2s; }
  .slider::before { content:""; position:absolute; height:18px; width:18px; left:3px; top:3px;
                    background:#fff; border-radius:50%; transition:.2s; }
  input:checked + .slider { background:var(--green); }
  input:checked + .slider::before { transform:translateX(22px); }
  .arm-wrap { display:flex; align-items:center; gap:8px; }
  .arm-wrap .txt { font-size:12px; width:56px; }
  .body { margin-top:14px; display:none; }
  .body.open { display:block; }
  .empty { color:var(--muted); padding:8px 0; }
  #login { max-width:340px; margin:80px auto; }
  #login input { width:100%; padding:10px; background:#0f141c; border:1px solid var(--line);
                 color:var(--fg); border-radius:8px; margin:8px 0; }
  button { background:var(--accent); color:#05080d; border:0; padding:9px 14px; border-radius:8px;
           font-weight:600; cursor:pointer; }
  .err { color:var(--red); font-size:13px; min-height:18px; }
  a { color:var(--accent); }
  .ts { color:var(--muted); font-size:11px; }
  .paused-card { border-color:var(--red); background:#2a1416; }
  .paused-card .hl { color:var(--red); font-weight:700; font-size:15px; }
  #resumeBtn { background:var(--green); color:#05080d; }
</style>
</head>
<body>
<header>
  <h1>🤖 42 Trading Bot</h1>
  <span class="pill ${opts.dryRun ? "dry" : "live"}">${opts.dryRun ? "DRY-RUN" : "LIVE TRADING"}</span>
  <span class="pill">market ${opts.market.slice(0, 8)}…${opts.market.slice(-4)}</span>
  <span class="spacer"></span>
  <span id="updated" class="ts"></span>
  <button id="logout" style="display:none;background:#30363d;color:var(--fg)">Logout</button>
</header>

<div id="login" style="display:none">
  <div class="card">
    <h2 style="margin-top:0;font-size:16px">Sign in</h2>
    <input id="pw" type="password" placeholder="Dashboard password" />
    <button id="loginBtn">Enter</button>
    <div class="err" id="loginErr"></div>
  </div>
</div>

<main id="app" style="display:none">
  <div id="automation"></div>
  <div id="toolbar" style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <button id="reportBtn">📋 Send summary to Slack</button>
    <span style="flex:1"></span>
    <input id="withdrawTo" placeholder="0x destination address"
           style="width:340px;max-width:60vw;padding:8px;background:#0f141c;border:1px solid var(--line);color:var(--fg);border-radius:8px;font-family:ui-monospace,monospace;font-size:12px" />
    <button id="withdrawBtn" style="background:var(--red)">💸 Withdraw all funds</button>
  </div>
  <div class="card" id="market"></div>
  <div id="wallets"></div>
</main>

<script>
const $ = (s) => document.querySelector(s);
const fmt = (n, d=2) => (n==null||isNaN(n)) ? "–" : Number(n).toLocaleString(undefined,{maximumFractionDigits:d});
const cls = (n) => n>0 ? "pos" : n<0 ? "neg" : "mut";
const sign = (n,d=2) => (n>=0?"+":"") + fmt(n,d);
const open = new Set(JSON.parse(localStorage.getItem("open")||"[]"));

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401) { showLogin(); throw new Error("unauthorized"); }
  if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error || r.statusText);
  return r.json();
}
function showLogin(){ $("#login").style.display="block"; $("#app").style.display="none"; $("#logout").style.display="none"; }
function showApp(){ $("#login").style.display="none"; $("#app").style.display="block"; $("#logout").style.display="inline-block"; }

async function login(){
  $("#loginErr").textContent="";
  try {
    await api("/api/login",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({password:$("#pw").value})});
    showApp(); refresh();
  } catch(e){ $("#loginErr").textContent = "Wrong password"; }
}

function renderMarket(m){
  const top = [...m.outcomes].sort((a,b)=>b.price-a.price).slice(0,12);
  $("#updated").textContent = "updated " + new Date(m.fetchedAt).toLocaleTimeString();
  $("#market").innerHTML =
    '<h2 style="margin:0 0 4px;font-size:16px">'+escape(m.question)+'</h2>'+
    '<div class="mini">'+m.status+(m.endDate?' · ends '+new Date(m.endDate).toLocaleString():'')+' · '+m.numOutcomes+' outcomes</div>'+
    '<div class="grid" style="margin:14px 0">'+
      stat("Market cap", fmt(m.totalMarketCap,0)+" USDT")+
      stat("Volume", fmt(m.volume,0)+" USDT")+
      stat("Traders", fmt(m.traders,0))+
      stat("Status", m.status)+
    '</div>'+
    '<table><thead><tr><th>Outcome</th><th>Price</th><th>Mkt cap</th><th>Supply</th><th>1h</th><th>24h</th><th>Vol</th></tr></thead><tbody>'+
    top.map(o=>{
      const c1=o.metrics&&o.metrics.priceChange1h, c24=o.metrics&&o.metrics.priceChange24h;
      return '<tr><td>'+escape(o.name)+'</td><td>'+fmt(o.price,4)+'</td><td>'+fmt(o.marketCap,0)+
        '</td><td>'+fmt(o.supply,0)+'</td><td class="'+cls(c1)+'">'+(c1!=null?sign(c1,1)+'%':'–')+
        '</td><td class="'+cls(c24)+'">'+(c24!=null?sign(c24,1)+'%':'–')+'</td><td class="mut">'+fmt(o.volume,0)+'</td></tr>';
    }).join("")+'</tbody></table>';
}

function renderWallets(ws){
  $("#wallets").innerHTML = ws.length ? ws.map(walletCard).join("") :
    '<div class="card empty">No wallets loaded. Set WALLET_1_KEY (etc.) in the environment.</div>';
  ws.forEach(w=>{
    const cb = document.getElementById("arm-"+w.id);
    if(cb) cb.addEventListener("change", ()=>toggleArm(w.id, cb.checked, cb));
    const head = document.getElementById("head-"+w.id);
    if(head) head.addEventListener("click",(e)=>{ if(e.target.closest(".arm-wrap")||e.target.closest(".addr"))return; toggleBody(w.id); });
    const ad = document.getElementById("addr-"+w.id);
    if(ad) ad.addEventListener("click",(e)=>{ e.stopPropagation(); copyAddr(ad); });
  });
}
async function copyAddr(el){
  const addr = el.dataset.addr, orig = el.textContent;
  try { await navigator.clipboard.writeText(addr); }
  catch(_){ try { prompt("Copy address:", addr); return; } catch(__){ return; } }
  el.textContent = "copied ✓"; setTimeout(()=>{ el.textContent = orig; }, 1200);
}
async function sendReport(){
  const b = $("#reportBtn"); if(!b) return; const orig = b.textContent;
  b.disabled = true; b.textContent = "Sending…";
  try { await api("/api/report",{method:"POST"}); b.textContent = "Sent to Slack ✓"; }
  catch(e){ b.textContent = "Failed"; alert("Failed: "+e.message); }
  setTimeout(()=>{ b.disabled = false; b.textContent = orig; }, 2500);
}
async function withdrawAll(){
  const to = ($("#withdrawTo").value||"").trim();
  if(!/^0x[0-9a-fA-F]{40}$/.test(to)){ alert("Enter a valid 0x destination address."); return; }
  if(!confirm("Withdraw ALL funds?\\n\\nThis pauses the bot, sells every position to USDT, and sends USDT then BNB from ALL wallets to:\\n"+to+"\\n\\nThis cannot be undone.")) return;
  const b = $("#withdrawBtn"); b.disabled = true; b.textContent = "Draining…";
  try { await api("/api/withdraw",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({to,confirm:true})});
        alert("Withdraw started. Watch Slack for per-wallet progress and the completion alert."); }
  catch(e){ alert("Withdraw failed to start: "+e.message); b.disabled=false; b.textContent="💸 Withdraw all funds"; }
}

function walletCard(w){
  const isOpen = open.has(w.id);
  const rows = w.positions.length ? w.positions.map(p=>
    '<tr><td>'+escape(p.name)+'</td><td>'+fmt(p.entryPrice,4)+'</td><td>'+fmt(p.currentPrice,4)+
    '</td><td>'+fmt(p.usdtCost,2)+'</td><td>'+fmt(p.currentValue,2)+'</td><td class="'+cls(p.unrealizedPnlUsdt)+'">'+
    sign(p.unrealizedPnlUsdt,2)+' ('+sign(p.unrealizedPnlPct,1)+'%)</td><td class="mut">'+p.fill+'</td></tr>'
  ).join("") : '<tr><td colspan="7" class="empty">No open positions</td></tr>';
  return '<div class="card"><div class="wallet-head" id="head-'+w.id+'">'+
    '<span class="label">'+escape(w.label)+'</span>'+
    '<span class="addr" id="addr-'+w.id+'" data-addr="'+w.address+'" title="Click to copy full address">'+w.address.slice(0,8)+'…'+w.address.slice(-6)+'</span>'+
    '<span class="spacer"></span>'+
    '<span class="mini">BNB '+fmt(w.bnb,4)+' · USDT '+fmt(w.usdt,2)+'</span>'+
    '<span class="mini">pos '+fmt(w.positionValueUsdt,2)+' · rPnL <span class="'+cls(w.realizedPnlUsdt)+'">'+sign(w.realizedPnlUsdt,2)+'</span></span>'+
    '<label class="arm-wrap" title="Safe switch — bot trades this wallet only when ON">'+
      '<span class="txt '+(w.armed?'pos':'mut')+'">'+(w.armed?'ARMED':'SAFE')+'</span>'+
      '<span class="switch"><input type="checkbox" id="arm-'+w.id+'" '+(w.armed?'checked':'')+'/><span class="slider"></span></span>'+
    '</label></div>'+
    '<div class="body'+(isOpen?' open':'')+'" id="body-'+w.id+'">'+
      (w.claimableUsdt>0?'<div class="mini" style="color:var(--warn)">Claimable: '+fmt(w.claimableUsdt,2)+' USDT</div>':'')+
      '<table><thead><tr><th>Outcome</th><th>Entry</th><th>Now</th><th>Cost</th><th>Value</th><th>uPnL</th><th>Fill</th></tr></thead>'+
      '<tbody>'+rows+'</tbody></table></div></div>';
}

function toggleBody(id){
  const b=document.getElementById("body-"+id); if(!b)return;
  b.classList.toggle("open");
  if(b.classList.contains("open")) open.add(id); else open.delete(id);
  localStorage.setItem("open", JSON.stringify([...open]));
}
async function toggleArm(id, armed, cb){
  try { await api("/api/wallets/"+id+"/arm",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({armed})});
        refresh(); }
  catch(e){ cb.checked = !armed; alert("Failed: "+e.message); }
}
function stat(k,v){ return '<div class="stat"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>'; }
function escape(s){ return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

function renderAutomation(a){
  const el = $("#automation"); if(!el) return;
  if (a && a.withdrawing) {
    el.innerHTML = '<div class="card paused-card"><span class="hl">💸 Withdraw in progress</span> '+
      '<span class="mini">draining all wallets → watch Slack for progress</span></div>';
    return;
  }
  if (a && a.paused) {
    el.innerHTML = '<div class="card paused-card"><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">'+
      '<span class="hl">⛔ Automation paused</span>'+
      '<span class="mini">'+escape(a.paused.reason)+'</span>'+
      '<span class="ts">since '+new Date(a.paused.at).toLocaleString()+'</span>'+
      '<span class="spacer"></span>'+
      '<button id="resumeBtn">Resume automation</button></div></div>';
    const b = $("#resumeBtn"); if(b) b.addEventListener("click", resume);
  } else { el.innerHTML = ""; }
}
async function resume(){
  const b = $("#resumeBtn"); if(b){ b.disabled=true; b.textContent="Resuming…"; }
  try { await api("/api/resume",{method:"POST"}); }
  catch(e){ alert("Resume failed: "+e.message); }
  refresh();
}

async function refresh(){
  try {
    const [m, w, a] = await Promise.all([api("/api/market"), api("/api/wallets"), api("/api/automation")]);
    showApp(); renderAutomation(a); renderMarket(m); renderWallets(w.wallets);
  } catch(e){ /* 401 handled in api() */ }
}

$("#loginBtn").addEventListener("click", login);
$("#reportBtn").addEventListener("click", sendReport);
$("#withdrawBtn").addEventListener("click", withdrawAll);
$("#pw").addEventListener("keydown",(e)=>{ if(e.key==="Enter") login(); });
$("#logout").addEventListener("click", async()=>{ await fetch("/api/logout",{method:"POST"}); showLogin(); });
refresh();
setInterval(refresh, 15000);
</script>
</body>
</html>`;
}
