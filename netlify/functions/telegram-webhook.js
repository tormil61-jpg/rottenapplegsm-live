// ============================================================
// Rotten Apple GSM — Telegram Webhook (full rewrite Oct 2026)
// ============================================================

const SUPA_URL       = 'https://fkiajefrdcgiobrzftjx.supabase.co';
const SUPA_KEY       = process.env.SUPABASE_ANON_KEY;
const TG_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const MILTON_ID      = 689316020;
const CHANNEL_ID     = process.env.TG_CHANNEL_ID;

const FEE_RATE   = (0.029 + 0.0349) / 2;
const FEE_FLAT   = (0.30  + 0.49)   / 2;
const MIN_PROFIT = 25;

const supaHeaders = {
  'apikey': SUPA_KEY,
  'Authorization': `Bearer ${SUPA_KEY}`,
  'Content-Type': 'application/json'
};

async function supaGet(table, query) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}?${query}`, { headers: supaHeaders });
  if (!res.ok) throw new Error(`Supabase GET ${table} ${res.status}`);
  return res.json();
}

async function supaPatch(table, query, body) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: { ...supaHeaders, 'Prefer': 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${table} ${res.status}`);
  return res.json();
}

async function supaPost(table, body) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...supaHeaders, 'Prefer': 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase POST ${table} ${res.status}: ${err}`);
  }
  return res.json();
}

async function tgSend(chatId, text, extra = {}) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra })
  });
}

async function tgBroadcast(text) {
  if (!CHANNEL_ID) return;
  await tgSend(CHANNEL_ID, text);
}

function calcSellPrice(cost) {
  const rawPrice = (cost + MIN_PROFIT + FEE_FLAT) / (1 - FEE_RATE);
  let rounded = Math.ceil(rawPrice) - 0.01;
  if (rounded < rawPrice) rounded += 1;
  return parseFloat(rounded.toFixed(2));
}

function parsePriceUpdate(text) {
  const upper = text.toUpperCase();
  const isExplicit = upper.includes('PRICE INCREASED') || upper.includes('PRICE DECREASED') ||
                     upper.includes('PRICE INCREASE')  || upper.includes('PRICE DECREASE');
  const arrowMatch = text.match(/(\d+(?:\.\d{1,2})?)\s*USD\s*[→\-]+\s*(\d+(?:\.\d{1,2})?)\s*USD/i);

  if (!isExplicit && !arrowMatch) return null;

  let oldCost = null;
  let newCost = null;

  if (arrowMatch) {
    oldCost = parseFloat(arrowMatch[1]);
    newCost = parseFloat(arrowMatch[2]);
  } else {
    const priceMatches = [...text.matchAll(/(\d+(?:\.\d{1,2})?)\s*USD/g)];
    if (!priceMatches.length) return null;
    newCost = parseFloat(priceMatches[priceMatches.length - 1][1]);
  }

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let serviceName = '';
  for (const line of lines) {
    if (/PRICE (IN|DE)CREASE/i.test(line)) continue;
    if (/\d+\.\d{2}\s*USD/i.test(line)) continue;
    if (/^[=>→↑↓\-]+$/.test(line.replace(/\s/g, ''))) continue;
    if (line.length > 3) { serviceName = line; break; }
  }

  return { newCost, oldCost, serviceName };
}

function matchServices(allServices, serviceName, supplierName) {
  const svcLower = serviceName.toLowerCase();
  let pool = allServices;
  if (supplierName) {
    const supLower = supplierName.toLowerCase();
    const filtered = allServices.filter(s =>
      (s.supplier || '').toLowerCase().includes(supLower) ||
      supLower.includes((s.supplier || '').toLowerCase().trim())
    );
    if (filtered.length > 0) pool = filtered;
  }

  const GENERIC = new Set(['iphone','ipad','samsung','galaxy','series','premium','standard','pro',
    'max','plus','ultra','mini','usa','the','and','for','unlock','service','support','all',
    'carrier','clean','unbarring','cleaning','check','eligibility','duo','sprint']);

  const carrierWords = svcLower
    .replace(/[^a-z0-9 &/]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !GENERIC.has(w));

  const modelRangeMatch = serviceName.match(/(\d{1,2})\s*[-]\s*(\d{1,2})/);
  const singleModelMatch = serviceName.match(/\b(X|XS|XR|SE|6S?|7|8|9|10|11|12|13|14|15|16|17|18|19|20)\b/gi);

  let coveredModels = new Set();
  let skipModelFilter = false;

  if (modelRangeMatch) {
    const start = parseInt(modelRangeMatch[1]);
    const end   = parseInt(modelRangeMatch[2]);
    if (end - start > 8) { skipModelFilter = true; }
    else { for (let m = start; m <= end; m++) coveredModels.add(String(m)); }
  } else if (singleModelMatch) {
    singleModelMatch.forEach(m => coveredModels.add(m.toUpperCase()));
  } else {
    skipModelFilter = true;
  }

  const hasiPhone  = /iphone/i.test(serviceName);
  const hasSamsung = /samsung/i.test(serviceName);

  return pool.filter(s => {
    const hCarrier = (s.carrier || '').toLowerCase();
    const hSeries  = (s.series  || '').toLowerCase();
    const hBrand   = (s.brand   || '').toLowerCase();
    const hStype   = (s.stype   || '').toLowerCase();

    if (hasiPhone  && !hBrand.includes('apple') && !hStype.includes('iphone') && !hSeries.includes('iphone')) return false;
    if (hasSamsung && !hBrand.includes('samsung')) return false;

    if (carrierWords.length > 0) {
      const carrierHit = carrierWords.some(w => hCarrier.includes(w));
      if (!carrierHit) return false;
    }

    if (!skipModelFilter && coveredModels.size > 0) {
      const svcModels = (hSeries + ' ' + hStype).match(/\b(X|XS|XR|SE|\d{1,2})\b/gi) || [];
      const svcModelSet = new Set(svcModels.map(m => m.toUpperCase()));
      const overlap = [...coveredModels].some(m => svcModelSet.has(m.toUpperCase()));
      if (!overlap) return false;
    }
    return true;
  });
}

function parseOrderStatus(text) {
  const imeiMatch = text.match(/\b(\d{15})\b/);
  if (!imeiMatch) return null;
  const imei   = imeiMatch[1];
  const isWin  = text.includes('✅') || /unlocked/i.test(text);
  const isFail = text.includes('❌') || /disabled|failed|rejected/i.test(text);
  if (!isWin && !isFail) return null;
  const status = isWin ? 'Completed' : 'Failed';
  const lines  = text.split('\n').map(l => l.trim()).filter(Boolean);
  let detail   = '';
  for (const line of lines) {
    if (line.includes(imei) || line.includes('✅') || line.includes('❌')) continue;
    detail = line; break;
  }
  return { imei, status, detail };
}

async function nextOrderNumber() {
  const rows = await supaGet('orders', 'select=order_number&order=order_number.desc&limit=1');
  return rows.length ? (rows[0].order_number || 0) + 1 : 1001;
}

async function getSession(key) {
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/settings?key=eq.${key}&limit=1`, { headers: supaHeaders });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!rows.length || !rows[0].value) return null;
    return JSON.parse(rows[0].value);
  } catch { return null; }
}

async function setSession(key, value) {
  await supaPost('settings', { key, value: JSON.stringify(value) });
}

async function clearSession(key) {
  await fetch(`${SUPA_URL}/rest/v1/settings?key=eq.${key}`, {
    method: 'PATCH',
    headers: supaHeaders,
    body: JSON.stringify({ value: null })
  });
}

async function handleCustomer(fromId, text, firstName) {
  const lower = text.toLowerCase().trim();

  if (lower === '/start' || lower === 'hi' || lower === 'hello') {
    await tgSend(fromId,
      `👋 Hi ${firstName}! Welcome to <b>Rotten Apple GSM</b>.\n\n` +
      `I can help you:\n` +
      `• Check your order status — send your IMEI number\n` +
      `• Check your account balance — send your email address\n\n` +
      `Type your IMEI or email to get started.`
    );
    return;
  }

  if (/^\d{15}$/.test(text.trim())) {
    const imei = text.trim();
    const orders = await supaGet('orders', `imei=eq.${imei}&order=placed.desc&limit=5`);
    if (!orders.length) {
      await tgSend(fromId,
        `❓ No orders found for IMEI <code>${imei}</code>.\n\nContact us at rottenapplegsm@gmail.com`
      );
      return;
    }
    const lines = orders.map(o => {
      const emoji = o.status === 'Completed' ? '✅' : o.status === 'Failed' ? '❌' : '⏳';
      return `${emoji} <b>#${o.order_number || o.id.slice(0,8)}</b> — ${o.status}\n   ${o.description || '—'} | ${o.placed || '—'}`;
    }).join('\n\n');
    await tgSend(fromId, `📦 <b>Orders for IMEI</b> <code>${imei}</code>:\n\n${lines}`);
    return;
  }

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim())) {
    const email = text.trim().toLowerCase();
    const accounts = await supaGet('accounts', `email=eq.${email}&limit=1`);
    if (!accounts.length) {
      await tgSend(fromId,
        `❓ No account found for <b>${email}</b>.\n\nTry sending your IMEI number instead.`
      );
      return;
    }
    const acc = accounts[0];
    const balance = typeof acc.balance === 'number' ? `$${acc.balance.toFixed(2)}` : '$0.00';
    await tgSend(fromId,
      `👤 <b>Account</b>\nEmail: ${acc.email}\nBalance: <b>${balance}</b>\nMember since: ${acc.created_at ? acc.created_at.split('T')[0] : '—'}`
    );
    return;
  }

  await tgSend(fromId,
    `I didn't understand that. Try:\n` +
    `• Your <b>15-digit IMEI</b> to check order status\n` +
    `• Your <b>email address</b> to check your balance`
  );
}

async function continueOrderWizard(state, text) {
  const next = { ...state };

  if (state.step === 'email') {
    next.email = text.trim().toLowerCase();
    next.step  = 'name';
    await setSession('admin_new_order', next);
    await tgSend(MILTON_ID, `Step 2 of 5: Enter customer <b>full name</b>`);
    return;
  }
  if (state.step === 'name') {
    next.customerName = text.trim();
    next.step = 'imei';
    await setSession('admin_new_order', next);
    await tgSend(MILTON_ID, `Step 3 of 5: Enter the <b>IMEI</b> (15 digits, or "none" to skip)`);
    return;
  }
  if (state.step === 'imei') {
    next.imei = text.trim().toLowerCase() === 'none' ? '' : text.trim();
    next.step = 'service';
    await setSession('admin_new_order', next);
    await tgSend(MILTON_ID, `Step 4 of 5: Enter the <b>service description</b>\nExample: T-Mobile iPhone 15 Unlock`);
    return;
  }
  if (state.step === 'service') {
    next.description = text.trim();
    next.step = 'amount';
    await setSession('admin_new_order', next);
    await tgSend(MILTON_ID, `Step 5 of 5: Enter the <b>amount charged</b> (e.g. 49.99)`);
    return;
  }
  if (state.step === 'amount') {
    const amount = parseFloat(text.trim().replace(/[^0-9.]/g, ''));
    if (isNaN(amount) || amount <= 0) {
      await tgSend(MILTON_ID, `⚠️ Invalid amount. Enter a number like 49.99`);
      return;
    }
    next.amount = amount;
    next.step = 'review';
    await setSession('admin_new_order', next);
    await tgSend(MILTON_ID,
      `📋 <b>Review new order</b>\n\n` +
      `Email: ${next.email}\nName: ${next.customerName}\nIMEI: ${next.imei || 'N/A'}\n` +
      `Service: ${next.description}\nAmount: $${next.amount.toFixed(2)}\n\n` +
      `Reply <b>confirm</b> to create, or <b>cancel</b> to discard.`
    );
    return;
  }
  if (state.step === 'review' && text.trim().toLowerCase() === 'confirm') {
    let accountId = null;
    const existingAccounts = await supaGet('accounts', `email=eq.${state.email}&limit=1`);
    if (existingAccounts.length) {
      accountId = existingAccounts[0].id;
    } else {
      const newAcct = await supaPost('accounts', {
        email: state.email, name: state.customerName, balance: 0,
        created_at: new Date().toISOString()
      });
      accountId = newAcct[0]?.id || null;
    }
    const orderNumber = await nextOrderNumber();
    await supaPost('orders', {
      id: 'RA-ADMIN-' + Date.now(), order_number: orderNumber,
      customer_name: state.customerName, email: state.email,
      description: state.description, imei: state.imei || '',
      amount: state.amount, cost: 0, payment_method: 'Manual',
      status: 'Processing', placed: new Date().toISOString().split('T')[0],
      account_id: accountId, notes: 'Manually created via Telegram bot'
    });
    await clearSession('admin_new_order');
    const isNew = !existingAccounts.length;
    await tgSend(MILTON_ID,
      `✅ <b>Order #${orderNumber} created!</b>\n` +
      `Customer: ${state.customerName} (${state.email})\n` +
      `IMEI: ${state.imei || 'N/A'}\nService: ${state.description}\n` +
      `Amount: $${state.amount.toFixed(2)}\n` +
      `Account: ${isNew ? '🆕 new account created' : 'existing account linked'}`
    );
    return;
  }
}

async function continueServiceWizard(state, text) {
  const next = { ...state };

  if (state.step === 'name') {
    next.name = text.trim(); next.step = 'carrier';
    await setSession('admin_new_service', next);
    await tgSend(MILTON_ID, `Step 2 of 4: Enter the <b>carrier</b> (e.g. T-Mobile, AT&T, Cricket)`);
    return;
  }
  if (state.step === 'carrier') {
    next.carrier = text.trim(); next.step = 'cost';
    await setSession('admin_new_service', next);
    await tgSend(MILTON_ID, `Step 3 of 4: Enter the <b>supplier cost</b> (e.g. 85.00)`);
    return;
  }
  if (state.step === 'cost') {
    const cost = parseFloat(text.trim().replace(/[^0-9.]/g, ''));
    if (isNaN(cost) || cost <= 0) { await tgSend(MILTON_ID, `⚠️ Invalid cost. Enter a number.`); return; }
    next.cost = cost; next.price = calcSellPrice(cost); next.step = 'supplier';
    await setSession('admin_new_service', next);
    await tgSend(MILTON_ID,
      `Cost: $${cost} → Auto sell: $${next.price} (your $${MIN_PROFIT} profit included)\n\n` +
      `Step 4 of 4: Enter the <b>supplier name</b> (e.g. XpertUnlock)`
    );
    return;
  }
  if (state.step === 'supplier') {
    next.supplier = text.trim(); next.step = 'review';
    await setSession('admin_new_service', next);
    await tgSend(MILTON_ID,
      `📋 <b>Review new service</b>\n\n` +
      `Name: ${next.name}\nCarrier: ${next.carrier}\n` +
      `Cost: $${next.cost} | Sell: $${next.price}\nSupplier: ${next.supplier}\n\n` +
      `Reply <b>confirm</b> to add, or <b>cancel</b> to discard.`
    );
    return;
  }
  if (state.step === 'review' && text.trim().toLowerCase() === 'confirm') {
    await supaPost('services', {
      id: 'svc-' + Date.now(), name: next.name, carrier: next.carrier,
      cost: next.cost, price: next.price, supplier: next.supplier,
      active: true, created_at: new Date().toISOString()
    });
    await clearSession('admin_new_service');
    await tgSend(MILTON_ID,
      `✅ <b>Service added!</b>\n${next.name}\nCarrier: ${next.carrier}\n` +
      `Cost: $${next.cost} | Sell: $${next.price}\nSupplier: ${next.supplier}`
    );
    await tgBroadcast(
      `🆕 <b>New Service Available</b>\n${next.name}\n` +
      `Carrier: ${next.carrier}\nPrice: $${next.price}\n\nOrder at rottenapplegsm.com`
    );
    return;
  }
}

async function handleAdmin(msg, text) {
  const lower = text.toLowerCase().trim();
  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();

  if (cmd === '/help' || cmd === '/start') {
    await tgSend(MILTON_ID,
      `🍎 <b>Rotten Apple GSM — Admin Bot</b>\n\n` +
      `<b>Orders</b>\n` +
      `/order add — create a new order manually\n` +
      `/done [IMEI] — mark order Completed (Unlocked)\n` +
      `/reject [IMEI] — mark order Rejected\n\n` +
      `<b>Services</b>\n` +
      `/service add — add a new service\n\n` +
      `<b>Forwarded messages</b>\n` +
      `Forward a supplier price update → confirm/cancel to apply\n` +
      `Forward a supplier result with IMEI → auto-updates order\n\n` +
      `confirm / cancel — apply or skip pending update`
    );
    return;
  }

  if (lower === 'confirm') {
    const pending = await getSession('pending_price_update');
    if (!pending) { await tgSend(MILTON_ID, `⚠️ No pending price update found.`); return; }
    if (Date.now() - pending.ts > 3600000) {
      await clearSession('pending_price_update');
      await tgSend(MILTON_ID, `⚠️ Pending update expired. Forward the price message again.`);
      return;
    }
    const ids = pending.ids.split(',').filter(Boolean);
    for (const id of ids) {
      await supaPatch('services', `id=eq.${id}`, { cost: pending.newCost, price: calcSellPrice(pending.newCost) });
    }
    await clearSession('pending_price_update');
    const direction = pending.oldCost
      ? (pending.newCost < pending.oldCost ? 'decreased' : 'increased')
      : 'updated';
    await tgSend(MILTON_ID,
      `✅ <b>Price updated — ${ids.length} service${ids.length > 1 ? 's' : ''}</b>\n` +
      `Supplier: "${pending.supplierName || 'Unknown'}"\n` +
      `Service: "${pending.serviceName}"\n` +
      (pending.oldCost ? `$${pending.oldCost} → ` : '') +
      `$${pending.newCost} cost | Sell: $${calcSellPrice(pending.newCost)}`
    );
    await tgBroadcast(
      `💰 <b>Price Update</b>\n${pending.serviceName}\n` +
      `Price ${direction}: ` +
      (pending.oldCost ? `$${calcSellPrice(pending.oldCost)} → ` : '') +
      `$${calcSellPrice(pending.newCost)}\n\nOrder at rottenapplegsm.com`
    );
    return;
  }

  if (lower === 'cancel') {
    const pp = await getSession('pending_price_update');
    const po = await getSession('admin_new_order');
    const ps = await getSession('admin_new_service');
    if (pp) { await clearSession('pending_price_update'); await tgSend(MILTON_ID, `❌ Price update cancelled.`); return; }
    if (po) { await clearSession('admin_new_order'); await tgSend(MILTON_ID, `❌ New order cancelled.`); return; }
    if (ps) { await clearSession('admin_new_service'); await tgSend(MILTON_ID, `❌ New service cancelled.`); return; }
    await tgSend(MILTON_ID, `Nothing pending to cancel.`);
    return;
  }

  if (cmd === '/done') {
    const imei = parts[1];
    if (!imei || !/^\d{15}$/.test(imei)) { await tgSend(MILTON_ID, `Usage: /done 123456789012345`); return; }
    const orders = await supaGet('orders', `imei=eq.${imei}&limit=1`);
    if (!orders.length) { await tgSend(MILTON_ID, `⚠️ No order found for IMEI <code>${imei}</code>`); return; }
    const order = orders[0];
    await supaPatch('orders', `id=eq.${order.id}`, { status: 'Completed', completed: new Date().toISOString().split('T')[0] });
    await tgSend(MILTON_ID,
      `✅ <b>Order Completed (Unlocked)</b>\n` +
      `Order: #${order.order_number || order.id.slice(0,8)}\n` +
      `Customer: ${order.customer_name || 'Guest'}\nIMEI: <code>${imei}</code>`
    );
    return;
  }

  if (cmd === '/reject') {
    const imei = parts[1];
    if (!imei || !/^\d{15}$/.test(imei)) { await tgSend(MILTON_ID, `Usage: /reject 123456789012345`); return; }
    const orders = await supaGet('orders', `imei=eq.${imei}&limit=1`);
    if (!orders.length) { await tgSend(MILTON_ID, `⚠️ No order found for IMEI <code>${imei}</code>`); return; }
    const order = orders[0];
    await supaPatch('orders', `id=eq.${order.id}`, { status: 'Failed' });
    await tgSend(MILTON_ID,
      `❌ <b>Order Rejected</b>\nOrder: #${order.order_number || order.id.slice(0,8)}\n` +
      `Customer: ${order.customer_name || 'Guest'}\nIMEI: <code>${imei}</code>`
    );
    return;
  }

  if (cmd === '/order' && parts[1]?.toLowerCase() === 'add') {
    await setSession('admin_new_order', { step: 'email', ts: Date.now() });
    await tgSend(MILTON_ID, `📦 <b>New Order — Step 1 of 5</b>\n\nEnter customer <b>email</b>\n(or type cancel to stop)`);
    return;
  }

  if (cmd === '/service' && parts[1]?.toLowerCase() === 'add') {
    await setSession('admin_new_service', { step: 'name', ts: Date.now() });
    await tgSend(MILTON_ID, `🔧 <b>New Service — Step 1 of 4</b>\n\nEnter the service <b>name/description</b>\nExample: T-Mobile iPhone 14-16 Unlock\n(or type cancel to stop)`);
    return;
  }

  // Continue active wizard if one is running
  const pendingOrder = await getSession('admin_new_order');
  if (pendingOrder && !cmd.startsWith('/') && lower !== 'confirm' && lower !== 'cancel') {
    await continueOrderWizard(pendingOrder, text);
    return;
  }
  const pendingService = await getSession('admin_new_service');
  if (pendingService && !cmd.startsWith('/') && lower !== 'confirm' && lower !== 'cancel') {
    await continueServiceWizard(pendingService, text);
    return;
  }

  // Forwarded order result
  const orderUpdate = parseOrderStatus(text);
  if (orderUpdate) {
    const { imei, status, detail } = orderUpdate;
    const orders = await supaGet('orders', `imei=eq.${imei}&limit=1`);
    if (!orders.length) {
      await tgSend(MILTON_ID, `⚠️ <b>Order not found</b>\nIMEI: <code>${imei}</code>`);
      return;
    }
    const order = orders[0];
    await supaPatch('orders', `id=eq.${order.id}`, { status, supplier_note: detail || null, updated_at: new Date().toISOString() });
    const emoji = status === 'Completed' ? '✅' : '❌';
    await tgSend(MILTON_ID,
      `${emoji} <b>Order ${status === 'Completed' ? 'UNLOCKED' : 'FAILED'}</b>\n` +
      `Order: #${order.order_number || order.id.slice(0,8)}\nIMEI: <code>${imei}</code>\n` +
      `Customer: ${order.customer_name || 'Guest'}\nService: ${order.description || '—'}\n` +
      (detail ? `Note: ${detail}` : '')
    );
    return;
  }

  // Forwarded supplier price update
  const priceUpdate = parsePriceUpdate(text);
  if (priceUpdate) {
    const { newCost, oldCost, serviceName } = priceUpdate;
    const supplierName = msg.forward_from_chat?.title || msg.forward_from?.first_name || msg.forward_sender_name || null;

    if (!serviceName) {
      await tgSend(MILTON_ID, `⚠️ Price detected ($${newCost}) but couldn't read the service name. Forward the full supplier message.`);
      return;
    }

    const allServices = await supaGet('services', 'select=id,carrier,stype,brand,series,cost,price,supplier&limit=500');
    const matches = matchServices(allServices, serviceName, supplierName);

    if (!matches.length) {
      await tgSend(MILTON_ID,
        `⚠️ <b>No match found</b>\nSupplier: ${supplierName || 'Unknown'}\nService: "${serviceName}"\nNew cost: $${newCost}\n\n` +
        `Check the supplier field on your services in Admin.`
      );
      return;
    }

    const previewLines = matches.map(s =>
      `• ${s.carrier} | ${s.stype} — was $${s.cost} → $${newCost} (sell $${calcSellPrice(newCost)})`
    ).join('\n');

    await setSession('pending_price_update', {
      ids: matches.map(s => s.id).join(','), newCost, oldCost, serviceName, supplierName, ts: Date.now()
    });

    await tgSend(MILTON_ID,
      `💰 <b>Price update ready</b>\n` +
      `Supplier: <b>${supplierName || 'Unknown'}</b>\nService: "${serviceName}"\n` +
      (oldCost ? `$${oldCost} → ` : '') + `$${newCost} cost | Sell: $${calcSellPrice(newCost)}\n` +
      `${matches.length} service${matches.length > 1 ? 's' : ''} matched:\n\n${previewLines}\n\n` +
      `Reply <b>confirm</b> to apply, or <b>cancel</b> to skip.`
    );
    return;
  }

  await tgSend(MILTON_ID, `I didn't recognize that. Type /help to see all commands.`);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 200, body: 'Rotten Apple GSM Telegram Webhook' };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: 'Bad JSON' }; }

  const msg = body.message || body.channel_post;
  if (!msg) return { statusCode: 200, body: 'ok' };

  const fromId = msg.from?.id || msg.chat?.id;
  const text   = msg.text || msg.caption || '';
  if (!text) return { statusCode: 200, body: 'ok' };

  try {
    if (fromId === MILTON_ID) {
      await handleAdmin(msg, text);
    } else {
      await handleCustomer(fromId, text, msg.from?.first_name || 'there');
    }
  } catch (err) {
    console.error('Telegram webhook error:', err);
    if (fromId === MILTON_ID) {
      await tgSend(MILTON_ID, `⚠️ Bot error: ${err.message}`).catch(() => {});
    }
  }

  return { statusCode: 200, body: 'ok' };
};
