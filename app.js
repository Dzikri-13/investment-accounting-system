const SB = window.SUPABASE_CONFIG;
const state = { securities: [], transactions: [], dividends: [], journals: [], fairValues: [], holdings: [], chart: null };

const money = n => new Intl.NumberFormat("id-ID",{style:"currency",currency:"IDR",maximumFractionDigits:0}).format(Number(n||0));
const num = n => Number(n||0);
const esc = s => String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
const dateID = d => new Date(d).toLocaleDateString("id-ID",{day:"2-digit",month:"short",year:"numeric"});
const today = () => new Date().toISOString().slice(0,10);

async function sb(path, options={}) {
  const headers = {"apikey":SB.publishableKey,"Authorization":`Bearer ${SB.publishableKey}`,"Content-Type":"application/json","Prefer":options.prefer||"return=representation",...(options.headers||{})};
  const res = await fetch(`${SB.url}/rest/v1/${path}`, {...options, headers});
  if(!res.ok){let msg="Supabase request failed"; try{const e=await res.json();msg=e.message||e.hint||e.details||msg}catch{} throw new Error(msg)}
  const text=await res.text(); return text?JSON.parse(text):[];
}
async function loadAll(){
  try{
    [state.securities,state.transactions,state.dividends,state.journals,state.fairValues]=await Promise.all([
      sb("securities?select=*&order=ticker"),
      sb("investment_transactions?select=*,securities(ticker,company_name,sector)&order=transaction_date.desc,created_at.desc"),
      sb("dividends?select=*,securities(ticker,company_name)&order=payment_date.desc,created_at.desc"),
      sb("journal_entries?select=*&order=entry_date.desc,created_at.desc"),
      sb("fair_value_adjustments?select=*,securities(ticker,company_name)&order=adjustment_date.desc,created_at.desc")
    ]);
    buildHoldings(); renderAll(); document.getElementById("last-updated").textContent="Updated "+new Date().toLocaleTimeString("id-ID",{hour:"2-digit",minute:"2-digit"});
  }catch(e){toast("Backend belum siap: "+e.message,true); document.getElementById("last-updated").textContent="Backend setup required";}
}
function buildHoldings(){
  const map={};
  state.transactions.forEach(t=>{
    const id=t.security_id; if(!map[id])map[id]={security_id:id,ticker:t.securities?.ticker||"-",company_name:t.securities?.company_name||"-",sector:t.securities?.sector||"-",shares:0,cost:0};
    const q=num(t.quantity), gross=q*num(t.price), fee=num(t.broker_fee);
    if(t.transaction_type==="BUY"){map[id].shares+=q;map[id].cost+=gross+fee}
    else {const avg=map[id].shares?map[id].cost/map[id].shares:0;map[id].cost-=avg*q;map[id].shares-=q}
  });
  state.holdings=Object.values(map).filter(x=>x.shares>0.000001).map(h=>{
    const sec=state.securities.find(s=>s.id===h.security_id); const last=num(sec?.last_price);
    const mv=h.shares*last; return {...h,avg_cost:h.cost/h.shares,last_price:last,market_value:mv,unrealized:mv-h.cost};
  });
}
function unrealizedBalanceForSecurity(securityId){
  return state.journals
    .filter(j=>j.security_id===securityId && (j.account_name==="Unrealized Holding Gain" || j.account_name==="Unrealized Holding Loss"))
    .reduce((a,j)=>a+num(j.credit)-num(j.debit),0);
}
function totalUnrealizedFromJournals(){
  return state.journals
    .filter(j=>j.account_name==="Unrealized Holding Gain" || j.account_name==="Unrealized Holding Loss")
    .reduce((a,j)=>a+num(j.credit)-num(j.debit),0);
}
function totals(){
  const invested=state.holdings.reduce((a,h)=>a+h.cost,0);
  const market=state.holdings.reduce((a,h)=>a+h.market_value,0);
  // IMPORTANT: unrealized is the balance of the unrealized journal accounts,
  // not simply Market Value - Historical Cost.
  const unreal=totalUnrealizedFromJournals();
  const realized=state.journals.filter(j=>j.account_name==="Gain on Investment").reduce((a,j)=>a+num(j.credit)-num(j.debit),0);
  const div=state.dividends.reduce((a,d)=>a+num(d.total_amount),0);
  const buys=state.transactions.filter(t=>t.transaction_type==="BUY").reduce((a,t)=>a+num(t.quantity)*num(t.price)+num(t.broker_fee),0);
  const sells=state.transactions.filter(t=>t.transaction_type==="SELL").reduce((a,t)=>a+num(t.quantity)*num(t.price)-num(t.broker_fee),0);
  return {invested,market,unreal,realized,div,cash:sells+div-buys,ret:unreal+realized+div,pct:invested?(unreal+realized+div)/invested*100:0};
}
function renderAll(){renderDashboard();renderTransactions();renderHoldings();renderDividends();renderJournals();renderReports();renderFairValue();populateSecurities();}
function renderDashboard(){
  const x=totals(); [["total-invested",x.invested],["market-value",x.market],["unrealized-gain",x.unreal],["realized-gain",x.realized],["dividend-income",x.div],["cash-balance",x.cash],["hero-return",x.ret]].forEach(([id,v])=>document.getElementById(id).textContent=money(v));
  document.getElementById("hero-return-pct").textContent=(x.pct>=0?"+":"")+x.pct.toFixed(2)+"%";
  const arr=state.holdings.filter(h=>h.market_value>0); const ctx=document.getElementById("allocation-chart");
  if(state.chart)state.chart.destroy();
  state.chart=new Chart(ctx,{type:"doughnut",data:{labels:arr.map(h=>h.ticker),datasets:[{data:arr.map(h=>h.market_value)}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:"bottom",labels:{boxWidth:10,font:{size:10}}}}}});
  const recent=state.transactions.slice(0,5); document.getElementById("recent-transactions").innerHTML=recent.length?recent.map(t=>`<div class="activity"><span class="badge ${t.transaction_type.toLowerCase()}">${t.transaction_type}</span><div><b>${esc(t.securities?.ticker||"-")}</b><small>${dateID(t.transaction_date)} · ${num(t.quantity).toLocaleString("id-ID")} shares</small></div><strong>${money(num(t.quantity)*num(t.price)+num(t.broker_fee)*(t.transaction_type==="BUY"?1:-1))}</strong></div>`).join(""):`<div class="empty">No transactions yet.</div>`;
}
function renderTransactions(){
  const q=document.getElementById("transaction-search").value.toLowerCase(), typ=document.getElementById("transaction-type-filter").value;
  const rows=state.transactions.filter(t=>(!q||(t.securities?.ticker+" "+t.securities?.company_name).toLowerCase().includes(q))&&(!typ||t.transaction_type===typ));
  document.getElementById("transactions-table").innerHTML=rows.length?rows.map(t=>`<tr><td>${dateID(t.transaction_date)}</td><td class="type-${t.transaction_type.toLowerCase()}">${t.transaction_type}</td><td><strong>${esc(t.securities?.ticker||"-")}</strong><br><small>${esc(t.securities?.company_name||"")}</small></td><td>${num(t.quantity).toLocaleString("id-ID")}</td><td>${money(t.price)}</td><td>${money(t.broker_fee)}</td><td><strong>${money(num(t.quantity)*num(t.price)+(t.transaction_type==="BUY"?num(t.broker_fee):-num(t.broker_fee)))}</strong></td><td><button class="text-btn delete-tx" data-id="${t.id}">Delete</button></td></tr>`).join(""):`<tr><td colspan="8" class="empty">No transactions found.</td></tr>`;
}
function renderHoldings(){
  document.getElementById("holdings-table").innerHTML=state.holdings.length?state.holdings.map(h=>`<tr><td><strong>${esc(h.ticker)}</strong></td><td>${esc(h.company_name)}</td><td>${esc(h.sector||"-")}</td><td>${h.shares.toLocaleString("id-ID")}</td><td>${money(h.avg_cost)}</td><td>${money(h.last_price)}</td><td>${money(h.market_value)}</td><td class="${h.unrealized>=0?'type-buy':'type-sell'}">${money(h.unrealized)}</td></tr>`).join(""):`<tr><td colspan="8" class="empty">No open holdings.</td></tr>`;
}
function renderDividends(){
  document.getElementById("dividends-table").innerHTML=state.dividends.length?state.dividends.map(d=>`<tr><td>${dateID(d.payment_date)}</td><td><strong>${esc(d.securities?.ticker||"-")}</strong></td><td>${num(d.shares).toLocaleString("id-ID")}</td><td>${money(d.dividend_per_share)}</td><td><strong>${money(d.total_amount)}</strong></td><td><button class="text-btn delete-div" data-id="${d.id}">Delete</button></td></tr>`).join(""):`<tr><td colspan="6" class="empty">No dividends recorded.</td></tr>`;
}
function renderJournals(){
  document.getElementById("journal-table").innerHTML=state.journals.length?state.journals.map(j=>`<tr><td>${dateID(j.entry_date)}</td><td><strong>${esc(j.reference_no||"-")}</strong></td><td>${esc(j.description||"")}</td><td>${esc(j.account_name)}</td><td>${money(j.debit)}</td><td>${money(j.credit)}</td><td><button class="text-btn delete-journal" data-reference="${esc(j.reference_no||"")}">Delete</button></td></tr>`).join(""):`<tr><td colspan="7" class="empty">No journal entries.</td></tr>`;
}
function renderReports(){const x=totals();document.getElementById("report-invested").textContent=money(x.invested);document.getElementById("report-realized").textContent=money(x.realized);document.getElementById("report-unrealized").textContent=money(x.unreal);document.getElementById("report-dividend").textContent=money(x.div)}
function historicalCostForSecurity(securityId){
  const txs=state.transactions.filter(t=>t.security_id===securityId).sort((a,b)=>{
    const da=(a.transaction_date||"")+" "+(a.created_at||""); const db=(b.transaction_date||"")+" "+(b.created_at||""); return da.localeCompare(db);
  });
  let shares=0,cost=0;
  txs.forEach(t=>{
    const q=num(t.quantity), gross=q*num(t.price), fee=num(t.broker_fee);
    if(t.transaction_type==="BUY"){shares+=q;cost+=gross+fee;}
    else {const avg=shares?cost/shares:0;cost-=avg*q;shares-=q;}
  });
  return {shares,cost};
}
function postedAdjustmentsBefore(securityId,date){
  return state.fairValues.filter(a=>a.security_id===securityId && a.adjustment_date < date).reduce((sum,a)=>sum+num(a.adjustment_amount),0);
}
function getFvaRows(){
  const date=document.getElementById("fva-date")?.value||today();
  return state.holdings.map(h=>{
    const historical=h.cost;
    // Carrying amount = historical cost + the current net unrealized journal balance.
    // This automatically reflects reversals caused by partial/full sales.
    const prior=unrealizedBalanceForSecurity(h.security_id);
    const carrying=historical+prior;
    const input=document.querySelector(`.fva-price[data-security-id="${h.security_id}"]`);
    const marketPrice=input?num(input.value):h.last_price;
    const fairValue=h.shares*marketPrice;
    return {...h,historical_cost:historical,prior_adjustment:prior,carrying_before:carrying,entered_price:marketPrice,fair_value:fairValue,current_adjustment:fairValue-carrying};
  });
}
function renderFairValue(){
  const date=document.getElementById("fva-date"); if(!date)return;
  if(!date.value)date.value=today();
  const rows=getFvaRows();
  document.getElementById("fair-value-table").innerHTML=rows.length?rows.map(h=>`<tr><td><strong>${esc(h.ticker)}</strong><br><small>${esc(h.company_name)}</small></td><td>${h.shares.toLocaleString("id-ID")}</td><td>${money(h.historical_cost)}</td><td>${money(h.prior_adjustment)}</td><td><strong>${money(h.carrying_before)}</strong></td><td><input class="fva-price" data-security-id="${h.security_id}" type="number" min="0" step="0.01" value="${h.last_price||0}" aria-label="Market price ${esc(h.ticker)}"></td><td>${money(h.fair_value)}</td><td class="${h.current_adjustment>=0?'fva-positive':'fva-negative'}">${money(h.current_adjustment)}</td></tr>`).join(""):`<tr><td colspan="8" class="empty">No open holdings available for adjustment.</td></tr>`;
  updateFvaSummary(rows);
  document.querySelectorAll(".fva-price").forEach(input=>input.addEventListener("input",()=>{const r=getFvaRows();updateFvaSummary(r);updateFvaTableValues(r);}));
  renderFvaHistory();
}
function updateFvaTableValues(rows){
  const tbody=document.getElementById("fair-value-table"); rows.forEach((h,i)=>{const tr=tbody.rows[i];if(!tr)return;tr.cells[6].textContent=money(h.fair_value);tr.cells[7].textContent=money(h.current_adjustment);tr.cells[7].className=h.current_adjustment>=0?'fva-positive':'fva-negative';tr.cells[4].querySelector("strong").textContent=money(h.carrying_before);});
}
function updateFvaSummary(rows){
  const fair=rows.reduce((a,h)=>a+h.fair_value,0), carrying=rows.reduce((a,h)=>a+h.carrying_before,0), adj=rows.reduce((a,h)=>a+h.current_adjustment,0);
  document.getElementById("fva-total-fair-value").textContent=money(fair);document.getElementById("fva-total-carrying").textContent=money(carrying);document.getElementById("fva-total-adjustment").textContent=money(adj);
}
function renderFvaHistory(){
  const el=document.getElementById("fair-value-history-table"); if(!el)return;
  el.innerHTML=state.fairValues.length?state.fairValues.map(a=>`<tr><td>${dateID(a.adjustment_date)}</td><td><strong>${esc(a.reference_no)}</strong></td><td><strong>${esc(a.securities?.ticker||"-")}</strong></td><td>${num(a.shares).toLocaleString("id-ID")}</td><td>${money(a.market_price)}</td><td>${money(a.carrying_amount_before)}</td><td>${money(a.fair_value)}</td><td class="${num(a.adjustment_amount)>=0?'fva-positive':'fva-negative'}">${money(a.adjustment_amount)}</td></tr>`).join(""):`<tr><td colspan="8" class="empty">No fair value adjustments posted.</td></tr>`;
}
async function postFairValueAdjustment(){
  const date=document.getElementById("fva-date").value; if(!date)throw new Error("Tanggal penyesuaian wajib diisi.");
  if(!state.holdings.length)throw new Error("Belum ada holding yang dapat disesuaikan.");
  const rows=getFvaRows(); const existing=state.fairValues.filter(a=>a.adjustment_date===date);
  const dup=rows.find(h=>existing.some(a=>a.security_id===h.security_id)); if(dup)throw new Error(`Penyesuaian ${dup.ticker} untuk ${dateID(date)} sudah pernah diposting.`);
  const meaningful=rows.filter(h=>Math.abs(h.current_adjustment)>0.0001);
  if(!meaningful.length){if(!confirm("Tidak ada perubahan fair value. Tetap posting histori penyesuaian nol?"))return;}
  for(const h of rows){
    const ref=`FVA-${date.replaceAll("-","")}-${h.ticker}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    await sb("fair_value_adjustments",{method:"POST",body:JSON.stringify({adjustment_date:date,security_id:h.security_id,shares:h.shares,market_price:h.entered_price,carrying_amount_before:h.carrying_before,fair_value:h.fair_value,adjustment_amount:h.current_adjustment,reference_no:ref})});
    if(Math.abs(h.current_adjustment)>0.0001){
      const gain=h.current_adjustment>0;
      await sb("journal_entries",{method:"POST",body:JSON.stringify([
        {entry_date:date,reference_no:ref,security_id:h.security_id,description:`Fair value adjustment ${h.ticker} at year-end`,account_name:"Investment in Shares",debit:gain?h.current_adjustment:0,credit:gain?0:-h.current_adjustment},
        {entry_date:date,reference_no:ref,security_id:h.security_id,description:`Unrealized ${gain?'holding gain':'holding loss'} ${h.ticker}`,account_name:gain?"Unrealized Holding Gain":"Unrealized Holding Loss",debit:gain?0:-h.current_adjustment,credit:gain?h.current_adjustment:0}
      ])});
    }
  }
  await loadAll();
}
function populateSecurities(){["security-select","dividend-security-select"].forEach(id=>document.getElementById(id).innerHTML=state.securities.map(s=>`<option value="${s.id}">${esc(s.ticker)} — ${esc(s.company_name)}</option>`).join(""))}
function openModal(id){document.getElementById(id).classList.add("open")}
function closeModals(){document.querySelectorAll(".modal-backdrop").forEach(x=>x.classList.remove("open"))}
function toast(msg,error=false){const d=document.createElement("div");d.className="toast"+(error?" error":"");d.textContent=msg;document.getElementById("toast-container").appendChild(d);setTimeout(()=>d.remove(),3200)}
async function addTransaction(fd){
  const type=fd.get("type"), sec=fd.get("security_id"), qty=num(fd.get("quantity")), price=num(fd.get("price")), fee=num(fd.get("fee")), date=fd.get("date");
  if(type==="SELL"){const holding=state.holdings.find(h=>h.security_id===sec);if(!holding||holding.shares<qty)throw new Error("Jumlah saham SELL melebihi holding yang tersedia.")}
  const ref="TX-"+Date.now(); const row={security_id:sec,transaction_type:type,transaction_date:date,quantity:qty,price,broker_fee:fee,reference_no:ref};
  const created=await sb("investment_transactions",{method:"POST",body:JSON.stringify(row)});
  const total=qty*price+(type==="BUY"?fee:-fee);
  if(type==="BUY"){
    await sb("journal_entries",{method:"POST",body:JSON.stringify([{entry_date:date,reference_no:ref,security_id:sec,description:`Purchase of ${qty} shares`,account_name:"Investment in Shares",debit:total,credit:0},{entry_date:date,reference_no:ref,security_id:sec,description:`Purchase of ${qty} shares`,account_name:"Cash",debit:0,credit:total}])});
  } else {
    const h=state.holdings.find(x=>x.security_id===sec);
    const carrying=h.avg_cost*qty;
    const proceeds=qty*price-fee;
    const gain=proceeds-carrying;

    // Remove the portion of the existing unrealized balance that belongs to
    // the shares being sold. This prevents old unrealized gain/loss from
    // remaining in the system after the investment is disposed.
    const currentUnrealized=unrealizedBalanceForSecurity(sec);
    const unrealizedToReverse=h.shares ? currentUnrealized*(qty/h.shares) : 0;
    const reversal=[];
    if(Math.abs(unrealizedToReverse)>0.0001){
      if(unrealizedToReverse>0){
        reversal.push(
          {entry_date:date,reference_no:ref,security_id:sec,description:`Reverse unrealized holding gain on ${qty} shares sold`,account_name:"Unrealized Holding Gain",debit:unrealizedToReverse,credit:0},
          {entry_date:date,reference_no:ref,security_id:sec,description:`Reverse unrealized holding gain on ${qty} shares sold`,account_name:"Investment in Shares",debit:0,credit:unrealizedToReverse}
        );
      } else {
        const loss=Math.abs(unrealizedToReverse);
        reversal.push(
          {entry_date:date,reference_no:ref,security_id:sec,description:`Reverse unrealized holding loss on ${qty} shares sold`,account_name:"Investment in Shares",debit:loss,credit:0},
          {entry_date:date,reference_no:ref,security_id:sec,description:`Reverse unrealized holding loss on ${qty} shares sold`,account_name:"Unrealized Holding Loss",debit:0,credit:loss}
        );
      }
    }

    await sb("journal_entries",{method:"POST",body:JSON.stringify([
      ...reversal,
      {entry_date:date,reference_no:ref,security_id:sec,description:`Sale of ${qty} shares`,account_name:"Cash",debit:proceeds,credit:0},
      {entry_date:date,reference_no:ref,security_id:sec,description:`Sale of ${qty} shares`,account_name:"Investment in Shares",debit:0,credit:carrying},
      {entry_date:date,reference_no:ref,security_id:sec,description:`Gain/Loss on sale`,account_name:"Gain on Investment",debit:gain<0?-gain:0,credit:gain>0?gain:0}
    ])});
  }
}
async function addDividend(fd){
  const sec=fd.get("security_id"), date=fd.get("date"), shares=num(fd.get("shares")), dps=num(fd.get("dps")), total=shares*dps, ref="DIV-"+Date.now();
  await sb("dividends",{method:"POST",body:JSON.stringify({security_id:sec,payment_date:date,shares,dividend_per_share:dps,total_amount:total,reference_no:ref})});
  await sb("journal_entries",{method:"POST",body:JSON.stringify([{entry_date:date,reference_no:ref,security_id:sec,description:`Dividend received`,account_name:"Cash",debit:total,credit:0},{entry_date:date,reference_no:ref,security_id:sec,description:`Dividend received`,account_name:"Dividend Income",debit:0,credit:total}])});
}
async function deleteTransaction(id){
  if(!confirm("Delete transaction and its journal entries?"))return;
  const tx=state.transactions.find(x=>x.id===id); if(!tx)return;
  await sb(`journal_entries?reference_no=eq.${encodeURIComponent(tx.reference_no)}`,{method:"DELETE",prefer:"return=minimal"});
  await sb(`investment_transactions?id=eq.${id}`,{method:"DELETE",prefer:"return=minimal"});
  await loadAll();
}

async function deleteJournal(reference){
  if(!reference) return;
  const lines=state.journals.filter(j=>j.reference_no===reference);
  if(!lines.length)return;
  const sourceType=reference.startsWith("TX-")?"transaction":reference.startsWith("DIV-")?"dividend":reference.startsWith("FVA-")?"fair value adjustment":null;
  const message=sourceType
    ? `Delete the entire ${sourceType} and all journal lines for ${reference}?\n\nThis keeps the accounting system consistent. This action cannot be undone.`
    : `Delete all journal lines for ${reference}?\n\nThis action cannot be undone.`;
  if(!confirm(message))return;

  // Journal entries in this system are generated from source transactions.
  // Delete the source record together with its journal lines so the ledger
  // never becomes disconnected from the underlying investment activity.
  if(sourceType==="transaction"){
    const tx=state.transactions.find(t=>t.reference_no===reference);
    await sb(`journal_entries?reference_no=eq.${encodeURIComponent(reference)}`,{method:"DELETE",prefer:"return=minimal"});
    if(tx) await sb(`investment_transactions?id=eq.${encodeURIComponent(tx.id)}`,{method:"DELETE",prefer:"return=minimal"});
  } else if(sourceType==="dividend"){
    const d=state.dividends.find(x=>x.reference_no===reference);
    await sb(`journal_entries?reference_no=eq.${encodeURIComponent(reference)}`,{method:"DELETE",prefer:"return=minimal"});
    if(d) await sb(`dividends?id=eq.${encodeURIComponent(d.id)}`,{method:"DELETE",prefer:"return=minimal"});
  } else if(sourceType==="fair value adjustment"){
    await sb(`journal_entries?reference_no=eq.${encodeURIComponent(reference)}`,{method:"DELETE",prefer:"return=minimal"});
    await sb(`fair_value_adjustments?reference_no=eq.${encodeURIComponent(reference)}`,{method:"DELETE",prefer:"return=minimal"});
    // The SQL trigger sync_security_price_from_fva automatically restores
    // the latest remaining FVA market price for that security.
  } else {
    await sb(`journal_entries?reference_no=eq.${encodeURIComponent(reference)}`,{method:"DELETE",prefer:"return=minimal"});
  }
  await loadAll();
  toast(`Journal ${reference} deleted.`);
}
async function deleteDividend(id){
  if(!confirm("Delete dividend and its journal entries?"))return;
  const d=state.dividends.find(x=>x.id===id); if(!d)return;
  await sb(`journal_entries?reference_no=eq.${encodeURIComponent(d.reference_no)}`,{method:"DELETE",prefer:"return=minimal"});
  await sb(`dividends?id=eq.${id}`,{method:"DELETE",prefer:"return=minimal"});
  await loadAll();
}
function setup(){
  document.querySelectorAll(".nav-item").forEach(btn=>btn.addEventListener("click",()=>switchPage(btn.dataset.page)));
  document.querySelectorAll("[data-page-jump]").forEach(b=>b.addEventListener("click",()=>switchPage(b.dataset.pageJump)));
  document.getElementById("quick-add-btn").onclick=()=>openModal("transaction-modal");
  document.getElementById("add-transaction-btn").onclick=()=>openModal("transaction-modal");
  document.getElementById("add-dividend-btn").onclick=()=>openModal("dividend-modal");
  document.getElementById("fva-date").value=today();
  document.getElementById("fva-date").addEventListener("change",renderFairValue);
  document.getElementById("post-fair-value-btn").onclick=async()=>{try{await postFairValueAdjustment();toast("Fair value adjustment posted.")}catch(x){toast(x.message,true)}};
  document.querySelectorAll(".close-modal").forEach(b=>b.onclick=closeModals);
  document.querySelectorAll(".modal-backdrop").forEach(m=>m.addEventListener("click",e=>{if(e.target===m)closeModals()}));
  document.getElementById("transaction-form").date.value=today();document.getElementById("dividend-form").date.value=today();
  document.getElementById("transaction-form").addEventListener("input",()=>{const f=new FormData(document.getElementById("transaction-form"));document.getElementById("transaction-preview").textContent=money(num(f.get("quantity"))*num(f.get("price"))+num(f.get("fee")))}); 
  document.getElementById("dividend-form").addEventListener("input",()=>{const f=new FormData(document.getElementById("dividend-form"));document.getElementById("dividend-preview").textContent=money(num(f.get("shares"))*num(f.get("dps")))});
  document.getElementById("transaction-form").onsubmit=async e=>{e.preventDefault();try{await addTransaction(new FormData(e.target));e.target.reset();e.target.date.value=today();closeModals();toast("Transaction saved.");await loadAll()}catch(x){toast(x.message,true)}};
  document.getElementById("dividend-form").onsubmit=async e=>{e.preventDefault();try{await addDividend(new FormData(e.target));e.target.reset();e.target.date.value=today();closeModals();toast("Dividend recorded.");await loadAll()}catch(x){toast(x.message,true)}};
  document.getElementById("transaction-search").oninput=renderTransactions;document.getElementById("transaction-type-filter").onchange=renderTransactions;
  document.addEventListener("click",e=>{if(e.target.matches(".delete-tx"))deleteTransaction(e.target.dataset.id);if(e.target.matches(".delete-div"))deleteDividend(e.target.dataset.id);if(e.target.matches(".delete-journal"))deleteJournal(e.target.dataset.reference)});
  loadAll();
}
function switchPage(page){
  document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));document.getElementById("page-"+page).classList.add("active");
  document.querySelectorAll(".nav-item").forEach(n=>n.classList.toggle("active",n.dataset.page===page));
  const titles={dashboard:"Investment Dashboard",transactions:"Investment Transactions",portfolio:"Portfolio Holdings","fair-value":"Fair Value Adjustment",dividends:"Dividend Income",journal:"Journal Entries",reports:"Investment Reports"};
  document.getElementById("page-title").textContent=titles[page];
}
setup();
