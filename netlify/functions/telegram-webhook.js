// ============================================================
// Rotten Apple GSM — Telegram Webhook (Oct 2026 v3)
// F2: IMEI check results sent to customer Telegram
// F3: Full admin daily workflow via bot
// F4: Channel celebration only for unlock orders (not IMEI checks)
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

// ── Supabase helpers ──────────────────────────────────────────
async function supaGet(t,q){const r=await fetch(`${SUPA_URL}/rest/v1/${t}?${q}`,{headers:supaH});if(!r.ok)throw new Error(`GET ${t} ${r.status}`);return r.json();}
async function supaPatch(t,q,b){const r=await fetch(`${SUPA_URL}/rest/v1/${t}?${q}`,{method:'PATCH',headers:{...supaH,'Prefer':'return=representation'},body:JSON.stringify(b)});if(!r.ok)throw new Error(`PATCH ${t} ${r.status}`);return r.json();}
async function supaPost(t,b){const r=await fetch(`${SUPA_URL}/rest/v1/${t}`,{method:'POST',headers:{...supaH,'Prefer':'return=representation,resolution=merge-duplicates'},body:JSON.stringify(b)});if(!r.ok){const e=await r.text();throw new Error(`POST ${t} ${r.status}: ${e}`);}return r.json();}

// ── Balance helper (fetch-then-set, avoids SQL expressions in REST) ──
async function supaBalanceAdd(email, delta) {
  const rows = await supaGet('accounts', `email=eq.${encodeURIComponent(email)}&select=balance&limit=1`);
  const current = rows.length ? (parseFloat(rows[0].balance) || 0) : 0;
  const updated = Math.max(0, parseFloat((current + delta).toFixed(2)));
  await supaPatch('accounts', `email=eq.${encodeURIComponent(email)}`, { balance: updated });
  return updated;
}

// ── Telegram helpers ──────────────────────────────────────────
async function tgSend(id,text,extra={}){
  if(!id)return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:id,text,parse_mode:'HTML',...extra})});
}
async function tgBroadcast(text){if(!CHANNEL_ID)return;await tgSend(CHANNEL_ID,text);}

// ── Session helpers (settings table) ─────────────────────────
async function getSession(k){try{const r=await fetch(`${SUPA_URL}/rest/v1/settings?key=eq.${k}&limit=1`,{headers:supaH});if(!r.ok)return null;const rows=await r.json();if(!rows.length||!rows[0].value)return null;return JSON.parse(rows[0].value);}catch{return null;}}
async function setSession(k,v){await supaPost('settings',{key:k,value:JSON.stringify(v)});}
async function clearSession(k){await fetch(`${SUPA_URL}/rest/v1/settings?key=eq.${k}`,{method:'PATCH',headers:supaH,body:JSON.stringify({value:null})});}

// ── Unlock counter ────────────────────────────────────────────
async function getUnlockCount(){try{const r=await fetch(`${SUPA_URL}/rest/v1/settings?key=eq.unlock_count&limit=1`,{headers:supaH});if(!r.ok)return 0;const rows=await r.json();return rows.length&&rows[0].value?parseInt(rows[0].value)||0:0;}catch{return 0;}}
async function incrementUnlockCount(){const n=await getUnlockCount()+1;await supaPost('settings',{key:'unlock_count',value:String(n)});return n;}

// ── Business helpers ──────────────────────────────────────────
function calcSellPrice(cost){let r=Math.ceil((cost+MIN_PROFIT+FEE_FLAT)/(1-FEE_RATE))-0.01;return parseFloat(r.toFixed(2));}
async function nextOrderNumber(){const rows=await supaGet('orders','select=order_number&order=order_number.desc&limit=1');return rows.length?(rows[0].order_number||0)+1:1001;}
function maskImei(imei){return imei?`${imei.slice(0,6)}*****${imei.slice(-4)}`:'—';}
function statusEmoji(s){return s==='Completed'?'✅':s==='Failed'?'❌':s==='Processing'?'⚙️':s==='Pending Verification'?'⏳':'❓';}

// ── Price/result parsers ──────────────────────────────────────
function parsePriceUpdate(text){
  const m=text.match(/(\w[\w\s]*?)\s*[:\-–]\s*\$?([\d.]+)/i);
  if(!m)return null;
  return{service:m[1].trim(),price:parseFloat(m[2])};
}
function matchServices(all,sn,sup){
  const sl=sn.toLowerCase(),supl=sup?sup.toLowerCase():'';
  return all.filter(s=>{
    const tl=s.name.toLowerCase(),dl=(s.description||'').toLowerCase();
    const provMatch=supl&&(tl.includes(supl)||dl.includes(supl));
    return tl.includes(sl)||dl.includes(sl)||provMatch;
  });
}
function parseOrderStatus(text){
  const tl=text.toLowerCase();
  if(/unlock|success|complete|done|approved/i.test(tl))return'Completed';
  if(/fail|reject|invalid|error|not eligible/i.test(tl))return'Failed';
  return null;
}

// ── Customer lookup helpers ───────────────────────────────────
async function lookupOrderByImei(fromId,imei){
  try{
    const rows=await supaGet('orders',`imei=eq.${encodeURIComponent(imei)}&select=*&order=created_at.desc&limit=1`);
    if(!rows.length)return tgSend(fromId,'No order found for that IMEI.');
    const o=rows[0];
    const price=o.sell_price?`$${o.sell_price}`:'N/A';
    await tgSend(fromId,
      `📦 <b>Order #${o.order_number}</b>\n`+
      `Status: ${statusEmoji(o.status)} ${o.status}\n`+
      `Service: ${o.service_name||'—'}\n`+
      `IMEI: ${maskImei(imei)}\n`+
      `Price: ${price}`);
  }catch(e){await tgSend(fromId,'Error looking up order.');}
}
async function lookupBalance(fromId,email){
  try{
    const rows=await supaGet('accounts',`email=eq.${encodeURIComponent(email)}&select=balance,full_name&limit=1`);
    if(!rows.length)return tgSend(fromId,'No account found for that email.');
    const a=rows[0];
    await tgSend(fromId,`💰 <b>${a.full_name||email}</b>\nWallet balance: <b>$${(a.balance||0).toFixed(2)}</b>`);
  }catch(e){await tgSend(fromId,'Error looking up balance.');}
}

// ── Customer IMEI check wizard ────────────────────────────────
async function continueCustomerImeiWizard(fromId,text,state){
  const step=state.step;
  if(step==='pick_type'){
    try{
      const rows=await supaGet('services','type=eq.IMEI Check&select=id,name,sell_price&order=name');
      if(!rows.length){await clearSession(`cust_imei_${fromId}`);return tgSend(fromId,'No IMEI check services available right now.');}
      const btns=rows.map(s=>[{text:`${s.name} — $${s.sell_price}`,callback_data:`imei_${s.id}`}]);
      await setSession(`cust_imei_${fromId}`,{...state,step:'awaiting_type',services:rows,custTgId:fromId});
      return tgSend(fromId,'Select an IMEI check service:',{reply_markup:{inline_keyboard:btns}});
    }catch{return tgSend(fromId,'Error loading services. Try again.');}
  }
  if(step==='awaiting_type'&&text.startsWith('/imei_cb_')){
    const id=parseInt(text.replace('/imei_cb_',''));
    const svc=state.services.find(s=>s.id===id);
    if(!svc)return tgSend(fromId,'Invalid selection.');
    await setSession(`cust_imei_${fromId}`,{...state,step:'imei',serviceId:id,serviceName:svc.name,price:svc.sell_price,custTgId:fromId});
    return tgSend(fromId,`<b>${svc.name}</b> — $${svc.sell_price}\n\nEnter the IMEI number:`);
  }
  if(step==='imei'){
    if(!/^\d{15,17}$/.test(text.trim()))return tgSend(fromId,'Please enter a valid IMEI (15-17 digits).');
    await setSession(`cust_imei_${fromId}`,{...state,step:'email',imei:text.trim()});
    return tgSend(fromId,'Enter your email address:');
  }
  if(step==='email'){
    if(!text.includes('@'))return tgSend(fromId,'Please enter a valid email.');
    const st={...state,step:'payment',email:text.trim()};
    await setSession(`cust_imei_${fromId}`,st);
    const accRows=await supaGet('accounts',`email=eq.${encodeURIComponent(text.trim())}&select=balance&limit=1`);
    const bal=accRows.length?(accRows[0].balance||0):0;
    let msg=`✅ Ready to submit IMEI check!\n\n`+
      `Service: ${st.serviceName}\nIMEI: ${maskImei(st.imei)}\nPrice: $${st.price}\n\n`;
    if(bal>=st.price){msg+=`💰 Wallet balance: $${bal.toFixed(2)}\n\nReply <b>wallet</b> to pay from balance, or <b>paypal</b> for PayPal.`;}
    else{msg+=`Pay via PayPal:\n${PAYPAL_ME}/${st.price}\n\nOnce paid, reply <b>paid</b> to confirm.`;}
    return tgSend(fromId,msg);
  }
  if(step==='payment'){
    const tl=text.toLowerCase().trim();
    if(tl==='wallet'||tl==='paid'||tl==='paypal'){
      const payMethod=tl==='wallet'?'wallet':'paypal';
      try{
        const orderNum=await nextOrderNumber();
        await supaPost('imei_checks',{
          imei:state.imei,service_id:state.serviceId,service_name:state.serviceName,
          email:state.email,status:'Pending',price:state.price,
          payment_method:payMethod,cust_tg_id:fromId,order_number:orderNum
        });
        if(payMethod==='wallet'){
          await supaBalanceAdd(state.email, -state.price);
        }
        await clearSession(`cust_imei_${fromId}`);
        await tgSend(fromId,`🎉 IMEI check submitted!\nOrder #${orderNum}\nWe'll notify you here when the result is ready.`);
        await tgSend(MILTON_ID,
          `📋 <b>New IMEI Check #${orderNum}</b>\n`+
          `Service: ${state.serviceName}\nIMEI: ${state.imei}\n`+
          `Email: ${state.email}\nPayment: ${payMethod}\n`+
          `Use /imei_done ${state.imei} [result] when complete`);
      }catch(e){await tgSend(fromId,'Error submitting. Please try again.');}
    }else{return tgSend(fromId,'Reply <b>wallet</b>, <b>paypal</b>, or <b>paid</b> to confirm.');}
  }
}

// ── Customer order wizard ─────────────────────────────────────
async function continueCustomerOrderWizard(fromId,text,state){
  const step=state.step;
  if(step==='pick_service'){
    try{
      const rows=await supaGet('services',"type=neq.IMEI Check&select=id,name,sell_price&order=name");
      if(!rows.length){await clearSession(`cust_order_${fromId}`);return tgSend(fromId,'No unlock services available right now.');}
      const btns=rows.map(s=>[{text:`${s.name} — $${s.sell_price}`,callback_data:`svc_${s.id}`}]);
      await setSession(`cust_order_${fromId}`,{...state,step:'awaiting_service',services:rows,custTgId:fromId});
      return tgSend(fromId,'Select an unlock service:',{reply_markup:{inline_keyboard:btns}});
    }catch{return tgSend(fromId,'Error loading services. Try again.');}
  }
  if(step==='awaiting_service'&&text.startsWith('/svc_cb_')){
    const id=parseInt(text.replace('/svc_cb_',''));
    const svc=state.services.find(s=>s.id===id);
    if(!svc)return tgSend(fromId,'Invalid selection.');
    await setSession(`cust_order_${fromId}`,{...state,step:'imei',serviceId:id,serviceName:svc.name,price:svc.sell_price,custTgId:fromId});
    return tgSend(fromId,`<b>${svc.name}</b> — $${svc.sell_price}\n\nEnter the IMEI number:`);
  }
  if(step==='imei'){
    if(!/^\d{15,17}$/.test(text.trim()))return tgSend(fromId,'Please enter a valid IMEI (15-17 digits).');
    await setSession(`cust_order_${fromId}`,{...state,step:'email',imei:text.trim()});
    return tgSend(fromId,'Enter your email address:');
  }
  if(step==='email'){
    if(!text.includes('@'))return tgSend(fromId,'Please enter a valid email.');
    const st={...state,step:'payment',email:text.trim()};
    await setSession(`cust_order_${fromId}`,st);
    const accRows=await supaGet('accounts',`email=eq.${encodeURIComponent(text.trim())}&select=balance&limit=1`);
    const bal=accRows.length?(accRows[0].balance||0):0;
    let msg=`✅ Ready to place your order!\n\n`+
      `Service: ${st.serviceName}\nIMEI: ${maskImei(st.imei)}\nPrice: $${st.price}\n\n`;
    if(bal>=st.price){msg+=`💰 Wallet balance: $${bal.toFixed(2)}\n\nReply <b>wallet</b> to pay from balance, or <b>paypal</b> for PayPal.`;}
    else{msg+=`Pay via PayPal:\n${PAYPAL_ME}/${st.price}\n\nOnce paid, reply <b>paid</b> to confirm.`;}
    return tgSend(fromId,msg);
  }
  if(step==='payment'){
    const tl=text.toLowerCase().trim();
    if(tl==='wallet'||tl==='paid'||tl==='paypal'){
      const payMethod=tl==='wallet'?'wallet':'paypal';
      try{
        const orderNum=await nextOrderNumber();
        await supaPost('orders',{
          order_number:orderNum,service_id:state.serviceId,service_name:state.serviceName,
          imei:state.imei,email:state.email,status:'Pending Verification',
          sell_price:state.price,payment_method:payMethod,cust_tg_id:fromId
        });
        if(payMethod==='wallet'){
          await supaBalanceAdd(state.email, -state.price);
        }
        await clearSession(`cust_order_${fromId}`);
        await tgSend(fromId,`🎉 Order placed!\nOrder #${orderNum}\nStatus: ⏳ Pending Verification\nWe'll update you here when your IMEI is unlocked!`);
        await tgSend(MILTON_ID,
          `📦 <b>New Order #${orderNum}</b>\n`+
          `Service: ${state.serviceName}\nIMEI: ${state.imei}\n`+
          `Email: ${state.email}\nAmount: $${state.price}\nPayment: ${payMethod}\n`+
          `\n/verify ${orderNum} — confirm payment\n/reject ${orderNum} — reject order`);
      }catch(e){await tgSend(fromId,'Error placing order. Please try again.');}
    }else{return tgSend(fromId,'Reply <b>wallet</b>, <b>paypal</b>, or <b>paid</b> to confirm.');}
  }
}

// ── Customer handler ──────────────────────────────────────────
async function handleCustomer(fromId,text,firstName){
  const tl=text.toLowerCase().trim();
  // Active wizards
  const orderState=await getSession(`cust_order_${fromId}`);
  if(orderState)return continueCustomerOrderWizard(fromId,text,orderState);
  const imeiState=await getSession(`cust_imei_${fromId}`);
  if(imeiState)return continueCustomerImeiWizard(fromId,text,imeiState);

  if(tl==='/start'||tl==='hi'||tl==='hello'||tl==='menu'){
    return tgSend(fromId,
      `👋 Hi ${firstName}! Welcome to Rotten Apple GSM.\n\n`+
      `What would you like to do?\n\n`+
      `/order — Place an unlock order\n`+
      `/imei — IMEI check\n`+
      `/status [IMEI] — Check order status\n`+
      `/balance [email] — Check wallet balance`);
  }
  if(tl==='/order'||tl==='order'){
    await setSession(`cust_order_${fromId}`,{step:'pick_service',custTgId:fromId});
    return continueCustomerOrderWizard(fromId,text,{step:'pick_service',custTgId:fromId});
  }
  if(tl==='/imei'||tl==='imei check'){
    await setSession(`cust_imei_${fromId}`,{step:'pick_type',custTgId:fromId});
    return continueCustomerImeiWizard(fromId,text,{step:'pick_type',custTgId:fromId});
  }
  if(tl.startsWith('/status ')){
    const imei=tl.replace('/status ','').trim();
    return lookupOrderByImei(fromId,imei);
  }
  if(tl.startsWith('/balance ')){
    const email=text.trim().replace('/balance ','').trim();
    return lookupBalance(fromId,email);
  }
  if(tl==='/cancel'){
    await clearSession(`cust_order_${fromId}`);
    await clearSession(`cust_imei_${fromId}`);
    return tgSend(fromId,'Session cancelled. Type /start to begin again.');
  }
  return tgSend(fromId,'Type /start to see available options.');
}

// ── Admin wizards (add order / add service) ───────────────────
async function continueOrderWizard(state,text){
  if(state.step==='service'){
    state.service=text;state.step='imei';
    await setSession('admin_order_wiz',state);
    return tgSend(MILTON_ID,'IMEI?');
  }
  if(state.step==='imei'){
    if(!/^\d{15,17}$/.test(text.trim()))return tgSend(MILTON_ID,'Invalid IMEI. Try again:');
    state.imei=text.trim();state.step='email';
    await setSession('admin_order_wiz',state);
    return tgSend(MILTON_ID,'Customer email?');
  }
  if(state.step==='email'){
    state.email=text.trim();state.step='price';
    await setSession('admin_order_wiz',state);
    return tgSend(MILTON_ID,'Sell price (e.g. 49.99)?');
  }
  if(state.step==='price'){
    const p=parseFloat(text);
    if(isNaN(p)||p<=0)return tgSend(MILTON_ID,'Invalid price. Try again:');
    const orderNum=await nextOrderNumber();
    await supaPost('orders',{order_number:orderNum,service_name:state.service,imei:state.imei,email:state.email,sell_price:p,status:'Pending Verification',payment_method:'manual'});
    await clearSession('admin_order_wiz');
    return tgSend(MILTON_ID,`✅ Order #${orderNum} created.\n${state.service} | ${maskImei(state.imei)} | $${p}`);
  }
}
async function continueServiceWizard(state,text){
  if(state.step==='name'){
    state.name=text;state.step='cost';
    await setSession('admin_svc_wiz',state);
    return tgSend(MILTON_ID,'Cost price (your supplier cost)?');
  }
  if(state.step==='cost'){
    const c=parseFloat(text);
    if(isNaN(c)||c<=0)return tgSend(MILTON_ID,'Invalid cost. Try again:');
    const sell=calcSellPrice(c);
    state.cost=c;state.sellSuggested=sell;state.step='sell';
    await setSession('admin_svc_wiz',state);
    return tgSend(MILTON_ID,`Suggested sell price: <b>$${sell}</b>\nReply with this price or enter a different amount:`);
  }
  if(state.step==='sell'){
    const s=parseFloat(text)||state.sellSuggested;
    await supaPost('services',{name:state.name,cost_price:state.cost,sell_price:s,type:'Unlock',is_active:true});
    await clearSession('admin_svc_wiz');
    return tgSend(MILTON_ID,`✅ Service <b>${state.name}</b> added.\nCost: $${state.cost} | Sell: $${s}`);
  }
}

// ── Admin handler ─────────────────────────────────────────────
async function handleAdmin(msg,text){
  const tl=text.toLowerCase().trim();
  const parts=text.trim().split(/\s+/);
  const cmd=parts[0].toLowerCase();

  // Active wizards
  const owiz=await getSession('admin_order_wiz');
  if(owiz)return continueOrderWizard(owiz,text);
  const swiz=await getSession('admin_svc_wiz');
  if(swiz)return continueServiceWizard(swiz,text);

  // ── /help ──
  if(cmd==='/help'){
    return tgSend(MILTON_ID,
      `<b>🍎 Rotten Apple GSM — Admin Bot</b>\n\n`+
      `<b>Orders</b>\n`+
      `/pending — Pending Verification orders\n`+
      `/processing — Processing orders\n`+
      `/orders — Last 10 orders\n`+
      `/verify [order#] — Confirm payment → Processing\n`+
      `/done [IMEI] — Mark unlocked + celebrate\n`+
      `/reject [order#] — Reject + refund wallet\n`+
      `/refund [order#] — Refund to wallet\n`+
      `/note [order#] [text] — Add note to order\n\n`+
      `<b>IMEI Checks</b>\n`+
      `/imei_done [IMEI] [result] — Send result to customer\n\n`+
      `<b>Customers</b>\n`+
      `/customer [email] — Account + recent orders\n`+
      `/balance add [email] [amount]\n`+
      `/balance set [email] [amount]\n\n`+
      `<b>Services</b>\n`+
      `/service add — Add new service\n`+
      `/service list — List active services\n\n`+
      `<b>Stats</b>\n`+
      `/stats — Revenue + unlock count`);
  }

  // ── /stats ──
  if(cmd==='/stats'){
    const [orders,count]=await Promise.all([
      supaGet('orders','select=sell_price,status'),
      getUnlockCount()
    ]);
    const total=orders.reduce((s,o)=>s+(o.sell_price||0),0);
    const completed=orders.filter(o=>o.status==='Completed').length;
    return tgSend(MILTON_ID,
      `📊 <b>Stats</b>\nTotal orders: ${orders.length}\nCompleted: ${completed}\nRevenue: $${total.toFixed(2)}\n🔓 Total unlocked: ${count}`);
  }

  // ── /pending ──
  if(cmd==='/pending'){
    const rows=await supaGet('orders','status=eq.Pending%20Verification&select=order_number,service_name,imei,email,sell_price,created_at&order=created_at.asc&limit=15');
    if(!rows.length)return tgSend(MILTON_ID,'No pending orders.');
    const lines=rows.map(o=>`#${o.order_number} ${o.service_name} | ${maskImei(o.imei)} | $${o.sell_price}\n${o.email}\n/verify ${o.order_number}`);
    return tgSend(MILTON_ID,`⏳ <b>Pending Verification (${rows.length})</b>\n\n${lines.join('\n\n')}`);
  }

  // ── /processing ──
  if(cmd==='/processing'){
    const rows=await supaGet('orders','status=eq.Processing&select=order_number,service_name,imei,email,sell_price&order=created_at.asc&limit=15');
    if(!rows.length)return tgSend(MILTON_ID,'No orders in processing.');
    const lines=rows.map(o=>`#${o.order_number} ${o.service_name} | ${maskImei(o.imei)}\n${o.email}`);
    return tgSend(MILTON_ID,`⚙️ <b>Processing (${rows.length})</b>\n\n${lines.join('\n\n')}`);
  }

  // ── /orders ──
  if(cmd==='/orders'){
    const rows=await supaGet('orders','select=order_number,service_name,imei,status,sell_price&order=created_at.desc&limit=10');
    if(!rows.length)return tgSend(MILTON_ID,'No orders yet.');
    const lines=rows.map(o=>`#${o.order_number} ${statusEmoji(o.status)} ${o.service_name} | ${maskImei(o.imei)} | $${o.sell_price}`);
    return tgSend(MILTON_ID,`📦 <b>Last 10 Orders</b>\n\n${lines.join('\n')}`);
  }

  // ── /verify [order#] ──
  if(cmd==='/verify'&&parts[1]){
    const num=parseInt(parts[1]);
    const rows=await supaGet('orders',`order_number=eq.${num}&select=*&limit=1`);
    if(!rows.length)return tgSend(MILTON_ID,`Order #${num} not found.`);
    const o=rows[0];
    await supaPatch('orders',`order_number=eq.${num}`,{status:'Processing'});
    await tgSend(MILTON_ID,`✅ Order #${num} → <b>Processing</b>`);
    if(o.cust_tg_id){
      await tgSend(o.cust_tg_id,
        `✅ <b>Payment confirmed!</b>\nOrder #${num} is now processing.\nService: ${o.service_name}\nIMEI: ${maskImei(o.imei)}\nWe'll notify you when it's unlocked! 🔓`);
    }
    return;
  }

  // ── /done [IMEI] — F4: ONLY unlock celebration, not IMEI checks ──
  if(cmd==='/done'&&parts[1]){
    const imei=parts[1].trim();
    const rows=await supaGet('orders',`imei=eq.${encodeURIComponent(imei)}&status=eq.Processing&select=*&limit=1`);
    if(!rows.length)return tgSend(MILTON_ID,`No processing order found for IMEI ${imei}.`);
    const o=rows[0];
    await supaPatch('orders',`imei=eq.${encodeURIComponent(imei)}&status=eq.Processing`,{status:'Completed'});
    const count=await incrementUnlockCount();
    // Celebrate on channel (F4: unlock orders ONLY)
    await tgBroadcast(
      `🎉🔓 <b>IMEI UNLOCKED!</b> 🔓🎉\n\n`+
      `Another device is FREE!\n`+
      `Service: ${o.service_name}\n\n`+
      `🏆 <b>Total unlocks: ${count}</b>\n\n`+
      `Rotten Apple GSM — Fast, reliable unlocks.\nOrder at rottenapplegsm.com`);
    // Notify customer via Telegram if we have their ID
    if(o.cust_tg_id){
      await tgSend(o.cust_tg_id,
        `🎉🔓 <b>Your IMEI is UNLOCKED!</b>\n\nOrder #${o.order_number}\nService: ${o.service_name}\nIMEI: ${maskImei(imei)}\n\nThank you for choosing Rotten Apple GSM!`);
    }
    return tgSend(MILTON_ID,`✅ #${o.order_number} marked Completed. Unlock #${count} celebrated!`);
  }

  // ── /imei_done [IMEI] [result...] — F2: result to customer, NO celebration ──
  if(cmd==='/imei_done'&&parts[1]){
    const imei=parts[1].trim();
    const result=parts.slice(2).join(' ')||'Check complete.';
    const rows=await supaGet('imei_checks',`imei=eq.${encodeURIComponent(imei)}&status=eq.Pending&select=*&limit=1`);
    if(!rows.length)return tgSend(MILTON_ID,`No pending IMEI check for ${imei}.`);
    const chk=rows[0];
    await supaPatch('imei_checks',`imei=eq.${encodeURIComponent(imei)}&status=eq.Pending`,{status:'Completed',result});
    // F2: Send result to customer bot
    const custId=chk.cust_tg_id;
    if(custId){
      await tgSend(custId,
        `📋 <b>IMEI Check Result</b>\n\nIMEI: ${maskImei(imei)}\nService: ${chk.service_name}\n\nResult: ${result}`);
    }
    // Also email the customer (website handles this) — just confirm to admin
    return tgSend(MILTON_ID,`✅ IMEI check #${chk.order_number||imei} marked Complete.\nResult sent to customer${custId?' via Telegram':' (no Telegram ID on file)'}.`);
  }

  // ── /reject [order#] ──
  if(cmd==='/reject'&&parts[1]){
    const num=parseInt(parts[1]);
    const rows=await supaGet('orders',`order_number=eq.${num}&select=*&limit=1`);
    if(!rows.length)return tgSend(MILTON_ID,`Order #${num} not found.`);
    const o=rows[0];
    await supaPatch('orders',`order_number=eq.${num}`,{status:'Failed'});
    if(o.payment_method==='wallet'&&o.email){
      await supaBalanceAdd(o.email, o.sell_price || 0);
      await tgSend(MILTON_ID,`Wallet refunded $${o.sell_price} to ${o.email}`);
    }
    if(o.cust_tg_id){
      await tgSend(o.cust_tg_id,`❌ Order #${num} could not be processed. If you paid, a refund will be issued. Contact support if needed.`);
    }
    return tgSend(MILTON_ID,`Order #${num} rejected.`);
  }

  // ── /refund [order#] ──
  if(cmd==='/refund'&&parts[1]){
    const num=parseInt(parts[1]);
    const rows=await supaGet('orders',`order_number=eq.${num}&select=*&limit=1`);
    if(!rows.length)return tgSend(MILTON_ID,`Order #${num} not found.`);
    const o=rows[0];
    if(o.email){
      await supaBalanceAdd(o.email, o.sell_price || 0);
    }
    await supaPatch('orders',`order_number=eq.${num}`,{status:'Refunded'});
    if(o.cust_tg_id){
      await tgSend(o.cust_tg_id,`💰 Order #${num} has been refunded. $${o.sell_price} added to your wallet.`);
    }
    return tgSend(MILTON_ID,`✅ Order #${num} refunded. $${o.sell_price||0} → ${o.email}`);
  }

  // ── /note [order#] [text] ──
  if(cmd==='/note'&&parts.length>=3){
    const num=parseInt(parts[1]);
    const note=parts.slice(2).join(' ');
    const rows=await supaGet('orders',`order_number=eq.${num}&select=notes&limit=1`);
    if(!rows.length)return tgSend(MILTON_ID,`Order #${num} not found.`);
    const existing=rows[0].notes||'';
    const updated=existing?`${existing}\n${note}`:note;
    await supaPatch('orders',`order_number=eq.${num}`,{notes:updated});
    return tgSend(MILTON_ID,`✅ Note added to Order #${num}.`);
  }

  // ── /customer [email] ──
  if(cmd==='/customer'&&parts[1]){
    const email=parts[1].trim();
    const [accRows,orderRows]=await Promise.all([
      supaGet('accounts',`email=eq.${encodeURIComponent(email)}&select=*&limit=1`),
      supaGet('orders',`email=eq.${encodeURIComponent(email)}&select=order_number,service_name,status,sell_price&order=created_at.desc&limit=5`)
    ]);
    if(!accRows.length)return tgSend(MILTON_ID,`No account found for ${email}`);
    const a=accRows[0];
    const oLines=orderRows.map(o=>`#${o.order_number} ${statusEmoji(o.status)} ${o.service_name} $${o.sell_price}`).join('\n')||'No orders';
    return tgSend(MILTON_ID,
      `👤 <b>${a.full_name||email}</b>\nEmail: ${email}\nBalance: $${(a.balance||0).toFixed(2)}\nJoined: ${a.created_at?.split('T')[0]||'—'}\n\n<b>Recent Orders:</b>\n${oLines}`);
  }

  // ── /balance add/set [email] [amount] ──
  if(cmd==='/balance'&&parts.length>=4){
    const op=parts[1].toLowerCase();
    const email=parts[2].trim();
    const amt=parseFloat(parts[3]);
    if(isNaN(amt))return tgSend(MILTON_ID,'Invalid amount.');
    if(op==='add'){
      await supaBalanceAdd(email, amt);
      return tgSend(MILTON_ID,`✅ Added $${amt} to ${email}'s wallet.`);
    }
    if(op==='set'){
      await supaPatch('accounts',`email=eq.${encodeURIComponent(email)}`,{balance:amt});
      return tgSend(MILTON_ID,`✅ Set ${email}'s wallet to $${amt}.`);
    }
    return tgSend(MILTON_ID,'Usage: /balance add [email] [amount] or /balance set [email] [amount]');
  }

  // ── /service list / add ──
  if(cmd==='/service'){
    if(parts[1]==='add'){
      await setSession('admin_svc_wiz',{step:'name'});
      return tgSend(MILTON_ID,'Service name?');
    }
    if(parts[1]==='list'){
      const rows=await supaGet('services','is_active=eq.true&select=name,sell_price,type&order=name');
      if(!rows.length)return tgSend(MILTON_ID,'No active services.');
      return tgSend(MILTON_ID,'<b>Active Services</b>\n'+rows.map(s=>`• ${s.name} — $${s.sell_price} (${s.type})`).join('\n'));
    }
  }

  // ── /order add ──
  if(cmd==='/order'&&parts[1]==='add'){
    await setSession('admin_order_wiz',{step:'service'});
    return tgSend(MILTON_ID,'Service name for this order?');
  }

  // ── Forwarded supplier messages ──
  if(msg.forward_from||msg.forward_from_chat||msg.forward_date){
    const pu=parsePriceUpdate(text);
    if(pu){
      const all=await supaGet('services','select=id,name,description,cost_price');
      const matches=matchServices(all,pu.service,'');
      if(!matches.length)return tgSend(MILTON_ID,`No matching service found for "${pu.service}".`);
      for(const svc of matches){
        const newSell=calcSellPrice(pu.price);
        await supaPatch('services',`id=eq.${svc.id}`,{cost_price:pu.price,sell_price:newSell});
        await tgSend(MILTON_ID,`✅ Updated <b>${svc.name}</b>\nCost: $${pu.price} → Sell: $${newSell}`);
      }
      return;
    }
    const status=parseOrderStatus(text);
    if(status){
      return tgSend(MILTON_ID,`Detected status: <b>${status}</b>\nForward me the IMEI too, then use /done [IMEI] or /reject [order#].`);
    }
  }

  return tgSend(MILTON_ID,'Unknown command. Try /help');
}

// ── Main Netlify handler ──────────────────────────────────────
exports.handler = async (event) => {
  try{
    const body=JSON.parse(event.body||'{}');

    // ── F3: Website → bot alerts (new_order / new_account) ──
    if(body.type==='new_order'&&body.order){
      const o=body.order;
      await tgSend(MILTON_ID,
        `📦 <b>New Order #${o.order_number||'?'} from website</b>\n`+
        `Service: ${o.service_name||'—'}\nIMEI: ${maskImei(o.imei)}\n`+
        `Email: ${o.email||'—'}\nAmount: $${o.sell_price||'?'}\n`+
        `Payment: ${o.payment_method||'—'}\n\n`+
        `/verify ${o.order_number} — confirm\n/reject ${o.order_number} — reject`);
      return {statusCode:200,body:'ok'};
    }
    if(body.type==='new_account'&&body.account){
      const a=body.account;
      await tgSend(MILTON_ID,
        `🆕 <b>New Account</b>\n`+
        `Name: ${a.full_name||'—'}\nEmail: ${a.email||'—'}\n`+
        `Joined: ${new Date().toLocaleDateString('en-CA')}`);
      return {statusCode:200,body:'ok'};
    }

    // ── Telegram webhook update ──
    if(!body.message)return {statusCode:200,body:'ok'};
    const msg=body.message;
    const fromId=msg.from?.id;
    const text=(msg.text||'').trim();
    const firstName=msg.from?.first_name||'there';
    if(!fromId||!text)return {statusCode:200,body:'ok'};

    if(fromId===MILTON_ID){
      await handleAdmin(msg,text);
    } else {
      await handleCustomer(fromId,text,firstName);
    }
    return {statusCode:200,body:'ok'};
  }catch(err){
    console.error('handler error:',err.message);
    return {statusCode:200,body:'ok'};
  }
};
