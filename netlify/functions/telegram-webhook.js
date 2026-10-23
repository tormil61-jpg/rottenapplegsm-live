// ============================================================
// Rotten Apple GSM — Telegram Webhook (Oct 2026 v2)
// Features: customer order/imei wizard, admin alerts,
//           channel unlock broadcasts, unlock counter
// ============================================================

const SUPA_URL   = 'https://fkiajefrdcgiobrzftjx.supabase.co';
const SUPA_KEY   = process.env.SUPABASE_ANON_KEY;
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const MILTON_ID  = 689316020;
const CHANNEL_ID = process.env.TG_CHANNEL_ID;
const PAYPAL_ME  = process.env.PAYPAL_ME_LINK || 'https://paypal.me/RottenAppleGSM';
const MIN_PROFIT = 25;
const FEE_RATE   = (0.029 + 0.0349) / 2;
const FEE_FLAT   = (0.30  + 0.49)   / 2;

const supaH = { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' };

async function supaGet(t,q){const r=await fetch(`${SUPA_URL}/rest/v1/${t}?${q}`,{headers:supaH});if(!r.ok)throw new Error(`GET ${t} ${r.status}`);return r.json();}
async function supaPatch(t,q,b){const r=await fetch(`${SUPA_URL}/rest/v1/${t}?${q}`,{method:'PATCH',headers:{...supaH,'Prefer':'return=representation'},body:JSON.stringify(b)});if(!r.ok)throw new Error(`PATCH ${t} ${r.status}`);return r.json();}
async function supaPost(t,b){const r=await fetch(`${SUPA_URL}/rest/v1/${t}`,{method:'POST',headers:{...supaH,'Prefer':'return=representation,resolution=merge-duplicates'},body:JSON.stringify(b)});if(!r.ok){const e=await r.text();throw new Error(`POST ${t} ${r.status}: ${e}`);}return r.json();}

async function tgSend(id,text,extra={}){await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:id,text,parse_mode:'HTML',...extra})});}
async function tgBroadcast(text){if(!CHANNEL_ID)return;await tgSend(CHANNEL_ID,text);}

async function getSession(k){try{const r=await fetch(`${SUPA_URL}/rest/v1/settings?key=eq.${k}&limit=1`,{headers:supaH});if(!r.ok)return null;const rows=await r.json();if(!rows.length||!rows[0].value)return null;return JSON.parse(rows[0].value);}catch{return null;}}
async function setSession(k,v){await supaPost('settings',{key:k,value:JSON.stringify(v)});}
async function clearSession(k){await fetch(`${SUPA_URL}/rest/v1/settings?key=eq.${k}`,{method:'PATCH',headers:supaH,body:JSON.stringify({value:null})});}

async function getUnlockCount(){try{const r=await fetch(`${SUPA_URL}/rest/v1/settings?key=eq.unlock_count&limit=1`,{headers:supaH});if(!r.ok)return 0;const rows=await r.json();return rows.length&&rows[0].value?parseInt(rows[0].value)||0:0;}catch{return 0;}}
async function incrementUnlockCount(){const n=await getUnlockCount()+1;await supaPost('settings',{key:'unlock_count',value:String(n)});return n;}

function calcSellPrice(cost){let r=Math.ceil((cost+MIN_PROFIT+FEE_FLAT)/(1-FEE_RATE))-0.01;return parseFloat(r.toFixed(2));}
async function nextOrderNumber(){const rows=await supaGet('orders','select=order_number&order=order_number.desc&limit=1');return rows.length?(rows[0].order_number||0)+1:1001;}

function parsePriceUpdate(text){
  const upper=text.toUpperCase();
  const isEx=upper.includes('PRICE INCREASED')||upper.includes('PRICE DECREASED')||upper.includes('PRICE INCREASE')||upper.includes('PRICE DECREASE');
  const arM=text.match(/(\d+(?:\.\d{1,2})?)\s*USD\s*[→\-]+\s*(\d+(?:\.\d{1,2})?)\s*USD/i);
  if(!isEx&&!arM)return null;
  let oldCost=null,newCost=null;
  if(arM){oldCost=parseFloat(arM[1]);newCost=parseFloat(arM[2]);}
  else{const ms=[...text.matchAll(/(\d+(?:\.\d{1,2})?)\s*USD/g)];if(!ms.length)return null;newCost=parseFloat(ms[ms.length-1][1]);}
  const lines=text.split('\n').map(l=>l.trim()).filter(Boolean);
  let sn='';for(const l of lines){if(/PRICE (IN|DE)CREASE/i.test(l))continue;if(/\d+\.\d{2}\s*USD/i.test(l))continue;if(/^[=>→↑↓\-]+$/.test(l.replace(/\s/g,'')))continue;if(l.length>3){sn=l;break;}}
  return{newCost,oldCost,serviceName:sn};
}

function matchServices(all,sn,sup){
  let pool=all;
  if(sup){const sl=sup.toLowerCase().replace(/\s+/g,'');const f=all.filter(s=>{const d=(s.supplier||'').toLowerCase().replace(/\s+/g,'');return d.includes(sl)||sl.includes(d);});if(f.length)pool=f;}
  const CP=['t-mobile','tmobile','sprint','metropcs','metro pcs','at&t','att','verizon','boost mobile','xfinity mobile','xfinity','cricket','dish','visible','us cellular','consumer cellular','straight talk','mint','tracfone','simple mobile','net10','total wireless','virgin','lycamobile','h2o','boost'];
  const cc=CP.filter(c=>{const e=c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return new RegExp('\\b'+e.replace(/\s+/g,'[\\s\\-]+')+'+\\b','i').test(sn);});
  const mr=sn.match(/iPhone\s+(\d{1,2})\s*[-\/–]\s*(\d{1,2})/i);const ms2=sn.match(/iPhone\s+(\d{1,2})/i);let cm=new Set(),hmi=false;
  if(mr){for(let m=parseInt(mr[1]);m<=parseInt(mr[2]);m++)cm.add(m);hmi=true;}else if(ms2){cm.add(parseInt(ms2[1]));hmi=true;}
  const hiP=/iphone/i.test(sn),hSa=/samsung/i.test(sn);
  return pool.filter(s=>{
    const hc=(s.carrier||'').toLowerCase(),hs=(s.series||'').toLowerCase(),hb=(s.brand||'').toLowerCase();
    if(hiP&&!hb.includes('apple')&&!hs.includes('iphone'))return false;
    if(hSa&&!hb.includes('samsung'))return false;
    if(cc.length&&!cc.some(c=>hc.includes(c)))return false;
    if(hmi&&cm.size){if(/all models/i.test(hs))return true;if(!/\d/.test(hs))return false;const dr=hs.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})/);const ds=hs.match(/\b(\d{1,2})\b/);let dm=new Set();if(dr){for(let m=parseInt(dr[1]);m<=parseInt(dr[2]);m++)dm.add(m);}else if(ds)dm.add(parseInt(ds[1]));if(![...cm].some(m=>dm.has(m)))return false;}
    return true;
  });
}

function parseOrderStatus(text){
  const im=text.match(/\b(\d{15})\b/);if(!im)return null;
  const imei=im[1];const isW=text.includes('✅')||/unlocked/i.test(text);const isF=text.includes('❌')||/disabled|failed|rejected/i.test(text);
  if(!isW&&!isF)return null;const status=isW?'Completed':'Failed';
  const lines=text.split('\n').map(l=>l.trim()).filter(Boolean);let detail='';
  for(const l of lines){if(l.includes(imei)||l.includes('✅')||l.includes('❌'))continue;detail=l;break;}
  return{imei,status,detail};
}

// ── Customer handler ──────────────────────────────────────────
async function handleCustomer(fromId,text,firstName){
  const lower=text.toLowerCase().trim(),parts=text.trim().split(/\s+/),cmd=parts[0].toLowerCase();

  if(cmd==='/start'||lower==='hi'||lower==='hello'){
    await tgSend(fromId,`👋 Hi ${firstName}! Welcome to <b>Rotten Apple GSM</b>.\n\n📦 /order — place an unlock order\n🔍 /imei — run an IMEI check\n📊 /status [IMEI] — check order status\n💰 /balance [email] — check your account balance\n\nOr visit <b>rottenapplegsm.com</b> to order online.`);return;}

  if(cmd==='/help'){await tgSend(fromId,`🍎 <b>Rotten Apple GSM Bot</b>\n\n/order — place an unlock order\n/imei — run an IMEI check\n/status [IMEI] — check order status\n/balance [email] — check account balance\n/cancel — cancel current wizard\n\nQuestions? Email rottenapplegsm@gmail.com`);return;}

  if(cmd==='/cancel'){
    const op=await getSession(`cust_order_${fromId}`),ip=await getSession(`cust_imei_${fromId}`);
    if(op||ip){if(op)await clearSession(`cust_order_${fromId}`);if(ip)await clearSession(`cust_imei_${fromId}`);await tgSend(fromId,'✅ Cancelled. Type /order or /imei to start again.');}
    else await tgSend(fromId,'Nothing to cancel. Type /order to place a new order.');return;}

  if(cmd==='/status'){const imei=parts[1];if(imei&&/^\d{15}$/.test(imei))await lookupOrderByImei(fromId,imei);else await tgSend(fromId,'Send your 15-digit IMEI to check order status.\nExample: <code>352999000000000</code>');return;}

  if(cmd==='/balance'){const em=parts[1];if(em&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em))await lookupBalance(fromId,em);else await tgSend(fromId,'Send your account email address to check your balance.');return;}

  if(cmd==='/order'){
    const svcs=await supaGet('services','select=id,stype,carrier,series,price,cost,active&active=eq.true&order=carrier.asc&limit=100');
    if(!svcs.length){await tgSend(fromId,'⚠️ No services available right now. Visit rottenapplegsm.com');return;}
    const grouped={};for(const s of svcs){const c=s.carrier||'Other';if(!grouped[c])grouped[c]=[];grouped[c].push(s);}
    let menu='📦 <b>Unlock Services</b>\n\nChoose a number:\n\n';const list=[];let idx=1;
    for(const[c,ss]of Object.entries(grouped)){menu+=`<b>${c}</b>\n`;for(const s of ss){menu+=`  ${idx}. ${s.stype}${s.series?` (${s.series})`:''} — <b>$${parseFloat(s.price).toFixed(2)}</b>\n`;list.push(s);idx++;}menu+='\n';}
    menu+='Reply with a number, or /cancel to stop.';
    await setSession(`cust_order_${fromId}`,{step:'pick_service',list,ts:Date.now()});await tgSend(fromId,menu);return;}

  if(cmd==='/imei'){
    const checks=await supaGet('imei_checks','select=id,label,price&order=price.asc&limit=20');
    if(!checks.length){await tgSend(fromId,'⚠️ No IMEI check services available. Visit rottenapplegsm.com');return;}
    let menu='🔍 <b>IMEI Check Services</b>\n\nChoose a number:\n\n';
    for(let i=0;i<checks.length;i++)menu+=`${i+1}. ${checks[i].label} — <b>$${parseFloat(checks[i].price).toFixed(2)}</b>\n`;
    menu+='\nNote: IMEI checks are processed automatically.\n\nReply with a number, or /cancel.';
    await setSession(`cust_imei_${fromId}`,{step:'pick_type',checks,ts:Date.now()});await tgSend(fromId,menu);return;}

  const os=await getSession(`cust_order_${fromId}`);if(os){await continueCustomerOrderWizard(fromId,text,os);return;}
  const is=await getSession(`cust_imei_${fromId}`);if(is){await continueCustomerImeiWizard(fromId,text,is);return;}

  if(/^\d{15}$/.test(text.trim())){await lookupOrderByImei(fromId,text.trim());return;}
  if(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim())){await lookupBalance(fromId,text.trim().toLowerCase());return;}

  await tgSend(fromId,'I didn\'t understand that.\n\n/order — place an unlock order\n/imei — run an IMEI check\n/status [IMEI] — check order status\n/balance [email] — check your balance');}

async function lookupOrderByImei(fromId,imei){
  const orders=await supaGet('orders',`imei=eq.${imei}&order=placed.desc&limit=5`);
  if(!orders.length){await tgSend(fromId,`❓ No orders found for IMEI <code>${imei}</code>.\n\nContact us at rottenapplegsm@gmail.com`);return;}
  const lines=orders.map(o=>{const e=o.status==='Completed'?'✅':o.status==='Failed'?'❌':'⏳';return `${e} <b>#${o.order_number||o.id.slice(0,8)}</b> — ${o.status}\n   ${o.description||'—'} | ${o.placed||'—'}`;}).join('\n\n');
  await tgSend(fromId,`📦 <b>Orders for IMEI</b> <code>${imei}</code>:\n\n${lines}`);}

async function lookupBalance(fromId,email){
  const accts=await supaGet('accounts',`email=eq.${email}&limit=1`);
  if(!accts.length){await tgSend(fromId,`❓ No account found for <b>${email}</b>.\n\nSign up at rottenapplegsm.com`);return;}
  const acc=accts[0],bal=typeof acc.balance==='number'?`$${acc.balance.toFixed(2)}`:'$0.00';
  await tgSend(fromId,`👤 <b>Account</b>\nEmail: ${acc.email}\nBalance: <b>${bal}</b>\nMember since: ${(acc.created_at||'').split('T')[0]||'—'}\n\n`+(parseFloat(acc.balance)>0?'✅ You have funds — use them at rottenapplegsm.com or type /order to place an order using your balance.':'Add funds at rottenapplegsm.com'));}

async function continueCustomerOrderWizard(fromId,text,state){
  const next={...state};
  if(state.step==='pick_service'){
    const pick=parseInt(text.trim())-1;
    if(isNaN(pick)||pick<0||pick>=state.list.length){await tgSend(fromId,`⚠️ Reply with a number between 1 and ${state.list.length}, or /cancel.`);return;}
    next.service=state.list[pick];next.step='imei';await setSession(`cust_order_${fromId}`,next);
    await tgSend(fromId,`✅ Selected: <b>${next.service.carrier} ${next.service.stype}${next.service.series?` (${next.service.series})`:''}</b> — $${parseFloat(next.service.price).toFixed(2)}\n\nNow enter your <b>15-digit IMEI</b>.\n(Dial *#06# on your phone)`);return;}

  if(state.step==='imei'){
    if(!/^\d{15}$/.test(text.trim())){await tgSend(fromId,'⚠️ IMEI must be exactly 15 digits. Try again or /cancel.');return;}
    next.imei=text.trim();next.step='email';await setSession(`cust_order_${fromId}`,next);
    await tgSend(fromId,'Enter your <b>email address</b> for order updates.');return;}

  if(state.step==='email'){
    const email=text.trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){await tgSend(fromId,'⚠️ Invalid email. Try again or /cancel.');return;}
    const accts=await supaGet('accounts',`email=eq.${email}&select=balance,id,name&limit=1`);
    const acc=accts[0]||null,balance=acc?parseFloat(acc.balance)||0:0,price=parseFloat(next.service.price);
    next.email=email;next.accountId=acc?acc.id:null;next.name=acc?acc.name:'';next.balance=balance;next.price=price;next.step='payment';
    await setSession(`cust_order_${fromId}`,next);
    let msg=`📋 <b>Order Summary</b>\n\nService: ${next.service.carrier} ${next.service.stype}${next.service.series?` (${next.service.series})`:''}\nIMEI: <code>${next.imei}</code>\nAmount: <b>$${price.toFixed(2)}</b>\n\n<b>How would you like to pay?</b>\n`;
    if(balance>=price)msg+=`\n1. 💰 Account balance ($${balance.toFixed(2)} available)\n2. 💳 PayPal\n\nReply <b>1</b> or <b>2</b>.`;
    else{if(balance>0)msg+=`\n(Your balance: $${balance.toFixed(2)} — not enough for this order)\n`;msg+='\nReply <b>pay</b> to get a PayPal payment link, or /cancel.';}
    await tgSend(fromId,msg);return;}

  if(state.step==='payment'){
    const input=text.trim().toLowerCase(),price=parseFloat(state.service.price),canW=state.balance>=price;
    if((input==='1'&&canW)||input==='balance'){
      if(!state.accountId){await tgSend(fromId,'⚠️ Account not found. Please pay via PayPal.');return;}
      const a=await supaGet('accounts',`id=eq.${state.accountId}&select=balance&limit=1`);
      const cur=parseFloat(a[0]?.balance)||0;
      if(cur<price){await tgSend(fromId,`⚠️ Insufficient balance ($${cur.toFixed(2)}). Please pay via PayPal.`);return;}
      const newBal=parseFloat((cur-price).toFixed(2));await supaPatch('accounts',`id=eq.${state.accountId}`,{balance:newBal});
      const oNum=await nextOrderNumber(),oId='RA-TG-'+Date.now();
      await supaPost('orders',{id:oId,order_number:oNum,customer_name:state.name||state.email,email:state.email,description:`${state.service.carrier} ${state.service.stype}${state.service.series?` (${state.service.series})`:''}`.trim(),imei:state.imei,amount:price,cost:parseFloat(state.service.cost)||0,payment_method:'wallet',status:'Processing',placed:new Date().toISOString().split('T')[0],account_id:state.accountId,notes:'Placed via Telegram bot'});
      await clearSession(`cust_order_${fromId}`);
      await tgSend(fromId,`✅ <b>Order placed!</b>\n\nOrder: <b>#${oNum}</b>\nService: ${state.service.carrier} ${state.service.stype}\nIMEI: <code>${state.imei}</code>\nAmount: $${price.toFixed(2)} (paid from balance)\nNew balance: $${newBal.toFixed(2)}\n\nWe'll update you here as soon as it's processed. Thank you! 🙌`);
      await tgSend(MILTON_ID,`📦 <b>NEW ORDER — Bot (Wallet)</b>\nOrder #${oNum} | ${oId}\nCustomer: ${state.name||state.email} (${state.email})\nService: ${state.service.carrier} ${state.service.stype}${state.service.series?` (${state.service.series})`:''}\nIMEI: <code>${state.imei}</code>\nAmount: $${price.toFixed(2)} | Payment: Wallet (auto-deducted)`);return;}
    if(input==='2'||input==='pay'||input==='paypal'){
      const link=`${PAYPAL_ME}/${price.toFixed(2)}USD`;
      const oNum=await nextOrderNumber(),oId='RA-TG-PP-'+Date.now();
      await supaPost('orders',{id:oId,order_number:oNum,customer_name:state.name||state.email,email:state.email,description:`${state.service.carrier} ${state.service.stype}${state.service.series?` (${state.service.series})`:''}`.trim(),imei:state.imei,amount:price,cost:parseFloat(state.service.cost)||0,payment_method:'paypal',status:'Pending Verification',placed:new Date().toISOString().split('T')[0],account_id:state.accountId||null,notes:'Placed via Telegram bot — awaiting PayPal'});
      await clearSession(`cust_order_${fromId}`);
      await tgSend(fromId,`💳 <b>Pay via PayPal</b>\n\nOrder: <b>#${oNum}</b>\nAmount: <b>$${price.toFixed(2)}</b>\n\n👉 <a href="${link}">Tap here to pay on PayPal</a>\n\nIn the PayPal note, write: <code>Order #${oNum} | IMEI ${state.imei}</code>\n\nOnce we receive your payment we'll process your order and update you here. Thank you!`);
      await tgSend(MILTON_ID,`📦 <b>NEW ORDER — Bot (PayPal Pending)</b>\nOrder #${oNum} | ${oId}\nCustomer: ${state.name||state.email} (${state.email})\nService: ${state.service.carrier} ${state.service.stype}${state.service.series?` (${state.service.series})`:''}\nIMEI: <code>${state.imei}</code>\nAmount: $${price.toFixed(2)} | Payment: PayPal (pending)\n\n⚠️ Verify PayPal payment, then use /done ${state.imei} or update status in admin panel.`);return;}
    await tgSend(fromId,'⚠️ Please reply with a valid option or /cancel.');}}

async function continueCustomerImeiWizard(fromId,text,state){
  const next={...state};
  if(state.step==='pick_type'){
    const pick=parseInt(text.trim())-1;
    if(isNaN(pick)||pick<0||pick>=state.checks.length){await tgSend(fromId,`⚠️ Reply with a number between 1 and ${state.checks.length}, or /cancel.`);return;}
    next.checkType=state.checks[pick];next.step='imei';await setSession(`cust_imei_${fromId}`,next);
    await tgSend(fromId,`✅ Selected: <b>${next.checkType.label}</b> — $${parseFloat(next.checkType.price).toFixed(2)}\n\nEnter your <b>15-digit IMEI</b>.\n(Dial *#06# on your phone)`);return;}

  if(state.step==='imei'){
    if(!/^\d{15}$/.test(text.trim())){await tgSend(fromId,'⚠️ IMEI must be 15 digits. Try again or /cancel.');return;}
    next.imei=text.trim();next.step='email';await setSession(`cust_imei_${fromId}`,next);
    await tgSend(fromId,'Enter your <b>email address</b> to receive the results.');return;}

  if(state.step==='email'){
    const email=text.trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){await tgSend(fromId,'⚠️ Invalid email. Try again or /cancel.');return;}
    const accts=await supaGet('accounts',`email=eq.${email}&select=balance,id,name&limit=1`);
    const acc=accts[0]||null,balance=acc?parseFloat(acc.balance)||0:0,price=parseFloat(next.checkType.price);
    next.email=email;next.accountId=acc?acc.id:null;next.name=acc?acc.name:'';next.balance=balance;next.price=price;next.step='payment';
    await setSession(`cust_imei_${fromId}`,next);
    let msg=`📋 <b>IMEI Check Summary</b>\n\nCheck: ${next.checkType.label}\nIMEI: <code>${next.imei}</code>\nPrice: <b>$${price.toFixed(2)}</b>\n\n`;
    if(balance>=price)msg+=`<b>Pay with:</b>\n1. 💰 Account balance ($${balance.toFixed(2)}) — instant\n2. 💳 PayPal\n\nReply <b>1</b> or <b>2</b>.`;
    else{if(balance>0)msg+=`(Balance: $${balance.toFixed(2)} — insufficient)\n\n`;msg+='Reply <b>pay</b> to get a PayPal link, or /cancel.';}
    await tgSend(fromId,msg);return;}

  if(state.step==='payment'){
    const input=text.trim().toLowerCase(),price=parseFloat(state.checkType.price),canW=state.balance>=price;
    if((input==='1'&&canW)||input==='balance'){
      if(!state.accountId){await tgSend(fromId,'⚠️ Account not found. Please pay via PayPal.');return;}
      const a=await supaGet('accounts',`id=eq.${state.accountId}&select=balance&limit=1`);
      const cur=parseFloat(a[0]?.balance)||0;if(cur<price){await tgSend(fromId,'⚠️ Insufficient balance. Please pay via PayPal.');return;}
      const nb=parseFloat((cur-price).toFixed(2));await supaPatch('accounts',`id=eq.${state.accountId}`,{balance:nb});
      await clearSession(`cust_imei_${fromId}`);
      await tgSend(fromId,`✅ <b>Payment confirmed!</b> $${price.toFixed(2)} deducted from your balance.\n\nIMEI: <code>${state.imei}</code>\nCheck: ${state.checkType.label}\n\n⏳ Results will be sent to <b>${state.email}</b> shortly.\nIMEI checks are processed automatically — results usually arrive within minutes.`);
      await tgSend(MILTON_ID,`🔍 <b>IMEI CHECK — Bot (Wallet)</b>\nCustomer: ${state.name||state.email} (${state.email})\nIMEI: <code>${state.imei}</code>\nCheck: ${state.checkType.label} — $${price.toFixed(2)}\nPayment: Wallet (auto-deducted)`);return;}
    if(input==='2'||input==='pay'||input==='paypal'){
      const link=`${PAYPAL_ME}/${price.toFixed(2)}USD`;
      await clearSession(`cust_imei_${fromId}`);
      await tgSend(fromId,`💳 <b>Pay via PayPal</b>\n\nIMEI Check: ${state.checkType.label}\nAmount: <b>$${price.toFixed(2)}</b>\n\n👉 <a href="${link}">Tap here to pay on PayPal</a>\n\nIn the PayPal note, write: <code>IMEI Check | ${state.imei}</code>\n\nAfter payment we'll run your IMEI check and send results to ${state.email}.`);
      await tgSend(MILTON_ID,`🔍 <b>IMEI CHECK REQUEST — Bot (PayPal Pending)</b>\nCustomer: ${state.name||state.email} (${state.email})\nIMEI: <code>${state.imei}</code>\nCheck: ${state.checkType.label} — $${price.toFixed(2)}\n⚠️ Verify PayPal payment then run the check via admin panel.`);return;}
    await tgSend(fromId,'⚠️ Please reply with a valid option or /cancel.');}}

// ── Admin handler ─────────────────────────────────────────────
async function handleAdmin(msg,text){
  const lower=text.toLowerCase().trim(),parts=text.trim().split(/\s+/),cmd=parts[0].toLowerCase();

  if(cmd==='/help'||cmd==='/start'){
    await tgSend(MILTON_ID,'🍎 <b>Rotten Apple GSM — Admin</b>\n\n<b>Orders</b>\n/order add — create an order manually\n/done [IMEI] — mark Completed + broadcast unlock\n/reject [IMEI] — mark Failed\n\n<b>Services</b>\n/service add — add a new service\n\n<b>Stats</b>\n/stats — orders, accounts and unlock count\n\n<b>Forwarded messages</b>\nPrice update → confirm/cancel\nSupplier result with IMEI → auto-updates order\n\nconfirm / cancel — apply or discard pending update');return;}

  if(cmd==='/stats'){
    const[ao,aa,uc]=await Promise.all([supaGet('orders','select=id,status&limit=5000'),supaGet('accounts','select=id&limit=5000'),getUnlockCount()]);
    const comp=ao.filter(o=>o.status==='Completed').length,pend=ao.filter(o=>['Pending Verification','Processing'].includes(o.status)).length;
    await tgSend(MILTON_ID,`📊 <b>Stats</b>\n\n📦 Total orders: <b>${ao.length}</b>\n✅ Completed: <b>${comp}</b>\n⏳ Pending/Processing: <b>${pend}</b>\n👤 Total accounts: <b>${aa.length}</b>\n🔓 Unlocks broadcast: <b>${uc}</b>`);return;}

  if(/^\d+$/.test(lower.trim())){
    const pending=await getSession('pending_price_update');
    if(pending&&pending.candidates&&!pending.ids){
      const pick=parseInt(lower.trim())-1;
      if(pick<0||pick>=pending.candidates.length){await tgSend(MILTON_ID,`⚠️ Invalid number. Reply 1–${pending.candidates.length}.`);return;}
      const ch=pending.candidates[pick],cd=pending.oldCost?parseFloat((pending.newCost-pending.oldCost).toFixed(2)):0,ns=parseFloat((ch.price+cd).toFixed(2));
      await setSession('pending_price_update',{ids:ch.id.toString(),newCost:pending.newCost,oldCost:pending.oldCost,serviceName:pending.serviceName,supplierName:pending.supplierName,ts:Date.now()});
      await tgSend(MILTON_ID,`✅ Selected: ${ch.carrier} | ${ch.stype}\nCost: $${ch.cost} → $${pending.newCost} | Sell: $${ch.price} → $${ns}\n\nReply <b>confirm</b> to apply, or <b>cancel</b> to skip.`);return;}}

  if(lower==='confirm'){
    const p=await getSession('pending_price_update');if(!p){await tgSend(MILTON_ID,'⚠️ No pending price update.');return;}
    if(Date.now()-p.ts>3600000){await clearSession('pending_price_update');await tgSend(MILTON_ID,'⚠️ Update expired. Forward the price message again.');return;}
    const ids=p.ids.split(',').filter(Boolean),cd=p.oldCost?parseFloat((p.newCost-p.oldCost).toFixed(2)):0;
    const br=await supaGet('services',`id=in.(${ids.join(',')})&select=id,carrier,cost,price`);
    for(const s of br)await supaPatch('services',`id=eq.${s.id}`,{cost:p.newCost,price:parseFloat((s.price+cd).toFixed(2))});
    await clearSession('pending_price_update');
    const ss=br.map(s=>`• ${s.carrier}: $${s.price} → $${parseFloat((s.price+cd).toFixed(2))}`).join('\n');
    await tgSend(MILTON_ID,`✅ <b>Price updated — ${ids.length} service${ids.length>1?'s':''}</b>\nService: "${p.serviceName}"\nCost: ${p.oldCost?`$${p.oldCost} → `:''}$${p.newCost}\n\nSell prices:\n${ss}`);
    await tgBroadcast(`💰 <b>Price Update</b>\n${p.serviceName}\nPrice ${cd<0?'decreased':'increased'} by $${Math.abs(cd)}.\n\nOrder at rottenapplegsm.com`);return;}

  if(lower==='cancel'){
    const pp=await getSession('pending_price_update'),po=await getSession('admin_new_order'),ps=await getSession('admin_new_service');
    if(pp){await clearSession('pending_price_update');await tgSend(MILTON_ID,'❌ Price update cancelled.');return;}
    if(po){await clearSession('admin_new_order');await tgSend(MILTON_ID,'❌ New order cancelled.');return;}
    if(ps){await clearSession('admin_new_service');await tgSend(MILTON_ID,'❌ New service cancelled.');return;}
    await tgSend(MILTON_ID,'Nothing pending to cancel.');return;}

  if(cmd==='/done'){
    const imei=parts[1];if(!imei||!/^\d{15}$/.test(imei)){await tgSend(MILTON_ID,'Usage: /done 123456789012345');return;}
    const orders=await supaGet('orders',`imei=eq.${imei}&limit=1`);if(!orders.length){await tgSend(MILTON_ID,`⚠️ No order found for IMEI <code>${imei}</code>`);return;}
    const o=orders[0];await supaPatch('orders',`id=eq.${o.id}`,{status:'Completed',completed:new Date().toISOString().split('T')[0]});
    const total=await incrementUnlockCount(),sn=o.description||'Unlock Service';
    await tgSend(MILTON_ID,`✅ <b>Order Completed (Unlocked)</b>\nOrder: #${o.order_number||o.id.slice(0,8)}\nCustomer: ${o.customer_name||'Guest'}\nIMEI: <code>${imei}</code>\n🔓 Total unlocks broadcast: ${total}`);
    await tgBroadcast(`🔓 <b>Successful Unlock!</b>\n\n✅ ${sn}\nIMEI: <code>${imei.slice(0,6)}*****${imei.slice(-4)}</code>\n\n🏆 <b>${total} phones unlocked</b> and counting!\nOrder yours at <b>rottenapplegsm.com</b>`);return;}

  if(cmd==='/reject'){
    const imei=parts[1];if(!imei||!/^\d{15}$/.test(imei)){await tgSend(MILTON_ID,'Usage: /reject 123456789012345');return;}
    const orders=await supaGet('orders',`imei=eq.${imei}&limit=1`);if(!orders.length){await tgSend(MILTON_ID,`⚠️ No order found for IMEI <code>${imei}</code>`);return;}
    await supaPatch('orders',`id=eq.${orders[0].id}`,{status:'Failed'});
    await tgSend(MILTON_ID,`❌ <b>Order Rejected</b>\nOrder: #${orders[0].order_number||orders[0].id.slice(0,8)}\nCustomer: ${orders[0].customer_name||'Guest'}\nIMEI: <code>${imei}</code>`);return;}

  if(cmd==='/order'&&parts[1]?.toLowerCase()==='add'){await setSession('admin_new_order',{step:'email',ts:Date.now()});await tgSend(MILTON_ID,'📦 <b>New Order — Step 1/5</b>\n\nEnter customer <b>email</b>\n(or type cancel)');return;}
  if(cmd==='/service'&&parts[1]?.toLowerCase()==='add'){await setSession('admin_new_service',{step:'name',ts:Date.now()});await tgSend(MILTON_ID,'🔧 <b>New Service — Step 1/4</b>\n\nEnter the service <b>name/description</b>\nExample: T-Mobile iPhone 14-16 Unlock\n(or type cancel)');return;}

  const pO=await getSession('admin_new_order');if(pO&&!cmd.startsWith('/')&&lower!=='confirm'&&lower!=='cancel'){await continueOrderWizard(pO,text);return;}
  const pS=await getSession('admin_new_service');if(pS&&!cmd.startsWith('/')&&lower!=='confirm'&&lower!=='cancel'){await continueServiceWizard(pS,text);return;}

  const ou=parseOrderStatus(text);
  if(ou){
    const{imei,status,detail}=ou;const orders=await supaGet('orders',`imei=eq.${imei}&limit=1`);
    if(!orders.length){await tgSend(MILTON_ID,`⚠️ No order found for IMEI <code>${imei}</code>`);return;}
    const o=orders[0];await supaPatch('orders',`id=eq.${o.id}`,{status,updated_at:new Date().toISOString()});
    const e=status==='Completed'?'✅':'❌';
    await tgSend(MILTON_ID,`${e} <b>Order ${status==='Completed'?'UNLOCKED':'FAILED'}</b>\nOrder: #${o.order_number||o.id.slice(0,8)}\nIMEI: <code>${imei}</code>\nCustomer: ${o.customer_name||'Guest'}\nService: ${o.description||'—'}\n${detail?`Note: ${detail}`:''}`);
    if(status==='Completed'){const total=await incrementUnlockCount();await tgBroadcast(`🔓 <b>Successful Unlock!</b>\n\n✅ ${o.description||'Unlock Service'}\nIMEI: <code>${imei.slice(0,6)}*****${imei.slice(-4)}</code>\n\n🏆 <b>${total} phones unlocked</b> and counting!\nOrder yours at <b>rottenapplegsm.com</b>`);}
    return;}

  const pu=parsePriceUpdate(text);
  if(pu){
    const{newCost,oldCost,serviceName}=pu;const sn=msg.forward_from_chat?.title||msg.forward_from?.first_name||msg.forward_sender_name||null;
    if(!serviceName){await tgSend(MILTON_ID,`⚠️ Price detected ($${newCost}) but couldn't read the service name. Forward the full supplier message.`);return;}
    const all=await supaGet('services','select=id,carrier,stype,brand,series,cost,price,supplier&active=eq.true&limit=500');
    const matches=matchServices(all,serviceName,sn);
    if(!matches.length){await tgSend(MILTON_ID,`⚠️ <b>No match found</b>\nSupplier: ${sn||'Unknown'}\nService: "${serviceName}"\nNew cost: $${newCost}\n\nCheck the supplier field on your services in Admin.`);return;}
    const pd=oldCost?parseFloat((newCost-oldCost).toFixed(2)):0;
    if(matches.length===1){const s=matches[0],ns=parseFloat((s.price+pd).toFixed(2));await setSession('pending_price_update',{ids:s.id.toString(),newCost,oldCost,serviceName,supplierName:sn,ts:Date.now()});await tgSend(MILTON_ID,`💰 <b>Price update ready</b>\nSupplier: <b>${sn||'Unknown'}</b>\nService: "${serviceName}"\n\n• ${s.carrier} | ${s.stype} (${s.series||'no series'})\n  Cost: $${s.cost} → $${newCost} | Sell: $${s.price} → $${ns}\n\nReply <b>confirm</b> to apply, or <b>cancel</b> to skip.`);}
    else{const pl=matches.map((s,i)=>{const ns=parseFloat((s.price+pd).toFixed(2));return `${i+1}. ${s.carrier} | ${s.stype} (${s.series||'no series'})\n   Cost: $${s.cost} → $${newCost} | Sell: $${s.price} → $${ns}`;}).join('\n\n');await setSession('pending_price_update',{ids:null,candidates:matches.map(s=>({id:s.id,carrier:s.carrier,stype:s.stype,series:s.series,cost:s.cost,price:s.price})),newCost,oldCost,serviceName,supplierName:sn,ts:Date.now()});await tgSend(MILTON_ID,`💰 <b>${matches.length} services matched</b>\nSupplier: <b>${sn||'Unknown'}</b>\nService: "${serviceName}"\n\n${pl}\n\nReply with a number to select (e.g. <b>1</b>), or <b>cancel</b>.`);}
    return;}

  await tgSend(MILTON_ID,'I didn\'t recognize that. Type /help to see all commands.');}

async function continueOrderWizard(state,text){
  const next={...state};
  if(state.step==='email'){next.email=text.trim().toLowerCase();next.step='name';await setSession('admin_new_order',next);await tgSend(MILTON_ID,'Step 2/5: Enter customer <b>full name</b>');return;}
  if(state.step==='name'){next.customerName=text.trim();next.step='imei';await setSession('admin_new_order',next);await tgSend(MILTON_ID,'Step 3/5: Enter the <b>IMEI</b> (15 digits, or "none" to skip)');return;}
  if(state.step==='imei'){next.imei=text.trim().toLowerCase()==='none'?'':text.trim();next.step='service';await setSession('admin_new_order',next);await tgSend(MILTON_ID,'Step 4/5: Enter the <b>service description</b>\nExample: T-Mobile iPhone 15 Unlock');return;}
  if(state.step==='service'){next.description=text.trim();next.step='amount';await setSession('admin_new_order',next);await tgSend(MILTON_ID,'Step 5/5: Enter the <b>amount charged</b> (e.g. 49.99)');return;}
  if(state.step==='amount'){const amt=parseFloat(text.trim().replace(/[^0-9.]/g,''));if(isNaN(amt)||amt<=0){await tgSend(MILTON_ID,'⚠️ Invalid amount. Enter a number like 49.99');return;}next.amount=amt;next.step='review';await setSession('admin_new_order',next);await tgSend(MILTON_ID,`📋 <b>Review new order</b>\n\nEmail: ${next.email}\nName: ${next.customerName}\nIMEI: ${next.imei||'N/A'}\nService: ${next.description}\nAmount: $${next.amount.toFixed(2)}\n\nReply <b>confirm</b> to create, or <b>cancel</b> to discard.`);return;}
  if(state.step==='review'&&text.trim().toLowerCase()==='confirm'){
    const ex=await supaGet('accounts',`email=eq.${state.email}&limit=1`);let aid=null;
    if(ex.length)aid=ex[0].id;else{const na=await supaPost('accounts',{email:state.email,name:state.customerName,balance:0,created_at:new Date().toISOString()});aid=na[0]?.id||null;}
    const on=await nextOrderNumber();
    await supaPost('orders',{id:'RA-ADMIN-'+Date.now(),order_number:on,customer_name:state.customerName,email:state.email,description:state.description,imei:state.imei||'',amount:state.amount,cost:0,payment_method:'Manual',status:'Processing',placed:new Date().toISOString().split('T')[0],account_id:aid,notes:'Manually created via Telegram bot'});
    await clearSession('admin_new_order');
    await tgSend(MILTON_ID,`✅ <b>Order #${on} created!</b>\nCustomer: ${state.customerName} (${state.email})\nIMEI: ${state.imei||'N/A'}\nService: ${state.description}\nAmount: $${state.amount.toFixed(2)}\nAccount: ${!ex.length?'🆕 new account created':'existing account linked'}`);}}

async function continueServiceWizard(state,text){
  const next={...state};
  if(state.step==='name'){next.name=text.trim();next.step='carrier';await setSession('admin_new_service',next);await tgSend(MILTON_ID,'Step 2/4: Enter the <b>carrier</b> (e.g. T-Mobile, AT&T, Cricket)');return;}
  if(state.step==='carrier'){next.carrier=text.trim();next.step='cost';await setSession('admin_new_service',next);await tgSend(MILTON_ID,'Step 3/4: Enter the <b>supplier cost</b> (e.g. 85.00)');return;}
  if(state.step==='cost'){const cost=parseFloat(text.trim().replace(/[^0-9.]/g,''));if(isNaN(cost)||cost<=0){await tgSend(MILTON_ID,'⚠️ Invalid cost. Enter a number.');return;}next.cost=cost;next.price=calcSellPrice(cost);next.step='supplier';await setSession('admin_new_service',next);await tgSend(MILTON_ID,`Cost: $${cost} → Auto sell: $${next.price} (your $${MIN_PROFIT} profit included)\n\nStep 4/4: Enter the <b>supplier name</b> (e.g. XpertUnlock)`);return;}
  if(state.step==='supplier'){next.supplier=text.trim();next.step='review';await setSession('admin_new_service',next);await tgSend(MILTON_ID,`📋 <b>Review new service</b>\n\nName: ${next.name}\nCarrier: ${next.carrier}\nCost: $${next.cost} | Sell: $${next.price}\nSupplier: ${next.supplier}\n\nReply <b>confirm</b> to add, or <b>cancel</b> to discard.`);return;}
  if(state.step==='review'&&text.trim().toLowerCase()==='confirm'){
    await supaPost('services',{id:'svc-'+Date.now(),name:next.name,carrier:next.carrier,cost:next.cost,price:next.price,supplier:next.supplier,active:true,created_at:new Date().toISOString()});
    await clearSession('admin_new_service');
    await tgSend(MILTON_ID,`✅ <b>Service added!</b>\n${next.name}\nCarrier: ${next.carrier}\nCost: $${next.cost} | Sell: $${next.price}\nSupplier: ${next.supplier}`);
    await tgBroadcast(`🆕 <b>New Service Available</b>\n${next.name}\nCarrier: ${next.carrier} | Price: $${next.price}\n\nOrder at rottenapplegsm.com`);}}

// ── Main export ───────────────────────────────────────────────
exports.handler=async(event)=>{
  if(event.httpMethod!=='POST')return{statusCode:200,body:'Rotten Apple GSM Telegram Webhook'};
  let body;try{body=JSON.parse(event.body);}catch{return{statusCode:400,body:'Bad JSON'};}

  if(body.type==='new_order'){
    const o=body.order;if(o)await tgSend(MILTON_ID,`📦 <b>NEW ORDER — Website</b>\nOrder #${o.orderNumber||o.order_number} | ${o.id}\nCustomer: ${o.name||o.customer_name||'Guest'} (${o.email||'—'})\nService: ${o.desc||o.description||'—'}\nIMEI: <code>${o.imeiMasked||o.imei||'—'}</code>\nAmount: $${parseFloat(o.amount||0).toFixed(2)} | Payment: ${o.paymentMethod||o.payment_method||'—'}\nStatus: ${o.status||'Pending Verification'}`);
    return{statusCode:200,body:'ok'};}

  if(body.type==='new_account'){
    const a=body.account;if(a)await tgSend(MILTON_ID,`👤 <b>NEW ACCOUNT — Website</b>\nName: ${a.name}\nEmail: ${a.email}\nJoined: ${new Date().toLocaleDateString()}`);
    return{statusCode:200,body:'ok'};}

  const msg=body.message||body.channel_post;if(!msg)return{statusCode:200,body:'ok'};
  const fromId=msg.from?.id||msg.chat?.id,text=msg.text||msg.caption||'';if(!text)return{statusCode:200,body:'ok'};

  try{if(fromId===MILTON_ID)await handleAdmin(msg,text);else await handleCustomer(fromId,text,msg.from?.first_name||'there');}
  catch(err){console.error('Telegram webhook error:',err);if(fromId===MILTON_ID)await tgSend(MILTON_ID,`⚠️ Bot error: ${err.message}`).catch(()=>{});}

  return{statusCode:200,body:'ok'};};
