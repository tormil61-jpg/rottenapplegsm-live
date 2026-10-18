// ============================================================
// Rotten Apple GSM — Telegram Webhook
// File: netlify/functions/telegram-webhook.js
// ============================================================

const SUPA_URL   = 'https://fkiajefrdcgiobrzftjx.supabase.co';
const SUPA_KEY   = process.env.SUPABASE_ANON_KEY;
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const MILTON_ID  = 689316020;

const FEE_RATE   = (0.029 + 0.0349) / 2;
const FEE_FLAT   = (0.30  + 0.49)   / 2;
const MIN_PROFIT = 25;

// ── Supabase helpers ─────────────────────────────────────────

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
    headers: supaHeaders,
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${table} ${res.status}`);
  return res.ok;
}

// ── Telegram helper ──────────────────────────────────────────

async function tgSend(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

// ── Auto-price calculator ────────────────────────────────────

function calcSellPrice(cost) {
  const rawPrice = (cost + MIN_PROFIT + FEE_FLAT) / (1 - FEE_RATE);
  let rounded = Math.ceil(rawPrice) - 0.01;
  if (rounded < rawPrice) rounded += 1;
  return parseFloat(rounded.toFixed(2));
}

// ── Parse price update message ───────────────────────────────

function parsePriceUpdate(text) {
  const upper = text.toUpperCase();
  const isPrice = upper.includes('PRICE INCREASED') ||
                  upper.includes('PRICE DECREASED') ||
                  upper.includes('PRICE INCREASE') ||
                  upper.includes('PRICE DECREASE');
  if (!isPrice) return null;

  const priceMatches = [...text.matchAll(/(\d+\.\d{2})\s*USD/g)];
  if (!priceMatches.length) return null;
  const newCost = parseFloat(priceMatches[priceMatches.length - 1][1]);

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let serviceName = '';
  for (const line of lines) {
    if (/PRICE (IN|DE)CREASE/i.test(line)) continue;
    if (/^\d+\.\d{2}/.test(line)) continue;
    if (/→|↑|↓/.test(line) && !/[a-z]{3}/i.test(line.replace(/USD|\d|\.|→|↑|↓/g, ''))) continue;
    if (line.length > 5) { serviceName = line; break; }
  }

  return { newCost, serviceName };
}

// ── Parse order status message ───────────────────────────────

function parseOrderStatus(text) {
  const imeiMatch = text.match(/\b(\d{15})\b/);
  if (!imeiMatch) return null;

  const imei   = imeiMatch[1];
  const isWin  = text.includes('✅') || text.toLowerCase().includes('unlocked');
  const isFail = text.includes('❌') || text.toLowerCase().includes('disabled') ||
                 text.toLowerCase().includes('failed') || text.toLowerCase().includes('rejected');

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

// ── Match services by supplier + carrier + model ─────────────
//
// Rules:
//   1. If we know which supplier sent the message, only look at services
//      where s.supplier matches (case-insensitive contains).
//   2. Extract carrier keywords from the service name (e.g. "t-mobile", "sprint").
//   3. Extract model range. If range span > 8 (e.g. "4-14" = 10 models),
//      treat it as "all models" — skip the model filter entirely.
//   4. If range span <= 8, require at least one model in the service to overlap.

function matchServices(allServices, serviceName, supplierName) {
  const svcLower = serviceName.toLowerCase();

  // 1. Supplier filter
  let pool = allServices;
  if (supplierName) {
    const supLower = supplierName.toLowerCase();
    const filtered = allServices.filter(s => (s.supplier || '').toLowerCase().includes(supLower) ||
                                              supLower.includes((s.supplier || '').toLowerCase().trim()));
    // Only apply supplier filter if it actually narrows things down
    if (filtered.length > 0) pool = filtered;
  }

  // 2. Carrier keywords (exclude generic words)
  const GENERIC = new Set(['iphone','ipad','samsung','galaxy','series','premium','standard','pro',
                            'max','plus','ultra','mini','usa','the','and','for','unlock','service',
                            'support','all','carrier','clean','unbarring','cleaning','check','eligibility']);
  const carrierWords = svcLower
    .replace(/[^a-z0-9 &/]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !GENERIC.has(w));

  // 3. Model range
  const modelRangeMatch = serviceName.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})/);
  const singleModelMatch = serviceName.match(/\b(X|XS|XR|SE|6S?|7|8|9|10|11|12|13|14|15|16)\b/gi);

  let coveredModels = new Set();
  let skipModelFilter = false;

  if (modelRangeMatch) {
    const start = parseInt(modelRangeMatch[1]);
    const end   = parseInt(modelRangeMatch[2]);
    const span  = end - start;
    if (span > 8) {
      // Range too wide (e.g. 4-14) — treat as "all models", skip model filter
      skipModelFilter = true;
    } else {
      for (let m = start; m <= end; m++) coveredModels.add(String(m));
    }
  } else if (singleModelMatch) {
    singleModelMatch.forEach(m => coveredModels.add(m.toUpperCase()));
  }

  // 4. Brand
  const hasiPhone  = /iphone/i.test(serviceName);
  const hasSamsung = /samsung/i.test(serviceName);

  return pool.filter(s => {
    const hCarrier = (s.carrier || '').toLowerCase();
    const hSeries  = (s.series  || '').toLowerCase();
    const hBrand   = (s.brand   || '').toLowerCase();
    const hStype   = (s.stype   || '').toLowerCase();

    // Brand check
    if (hasiPhone  && !hBrand.includes('apple') && !hStype.includes('iphone') && !hSeries.includes('iphone')) return false;
    if (hasSamsung && !hBrand.includes('samsung')) return false;

    // Carrier check
    if (carrierWords.length > 0) {
      const carrierHit = carrierWords.some(w => hCarrier.includes(w));
      if (!carrierHit) return false;
    }

    // Model check (skip if range was too wide = "all models")
    if (!skipModelFilter && coveredModels.size > 0) {
      const svcModels = (hSeries + ' ' + hStype).match(/\b(X|XS|XR|SE|\d{1,2})\b/gi) || [];
      const svcModelSet = new Set(svcModels.map(m => m.toUpperCase()));
      const overlap = [...coveredModels].some(m => svcModelSet.has(m.toUpperCase()));
      if (!overlap) return false;
    }

    return true;
  });
}

// ── Main handler ─────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'Rotten Apple GSM Telegram Webhook' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: 'Bad JSON' }; }

  const msg = body.message || body.channel_post;
  if (!msg) return { statusCode: 200, body: 'ok' };

  const fromId = msg.from?.id || msg.chat?.id;
  if (fromId !== MILTON_ID) return { statusCode: 200, body: 'ok' };

  const text = msg.text || msg.caption || '';
  if (!text) return { statusCode: 200, body: 'ok' };

  try {
    const lower = text.toLowerCase().trim();

    // ── Confirm pending price update ─────────────────────────
    if (lower === 'confirm') {
      const settings = await supaGet('settings', `key=eq.pending_price_update&limit=1`);
      if (!settings.length || !settings[0].value) {
        await tgSend(MILTON_ID, `⚠️ No pending price update found.`);
        return { statusCode: 200, body: 'ok' };
      }

      const pending = JSON.parse(settings[0].value);
      if (Date.now() - pending.ts > 3600000) {
        await tgSend(MILTON_ID, `⚠️ Pending update expired (over 1 hour old). Forward the price message again.`);
        return { statusCode: 200, body: 'ok' };
      }

      const ids = pending.ids.split(',').filter(Boolean);
      for (const id of ids) {
        await supaPatch('services', `id=eq.${id}`, {
          cost: pending.newCost,
          price: calcSellPrice(pending.newCost)
        });
      }

      // Clear pending
      await fetch(`${SUPA_URL}/rest/v1/settings?key=eq.pending_price_update`, {
        method: 'PATCH',
        headers: supaHeaders,
        body: JSON.stringify({ value: null })
      });

      await tgSend(MILTON_ID,
        `✅ <b>Price updated — ${ids.length} service${ids.length > 1 ? 's' : ''}</b>\n` +
        `Supplier: "${pending.supplierName || 'Unknown'}"\n` +
        `Service: "${pending.serviceName}"\n` +
        `New cost: $${pending.newCost} | Sell: $${calcSellPrice(pending.newCost)}\n` +
        `Your $${MIN_PROFIT} profit margin applied.`
      );
      return { statusCode: 200, body: 'ok' };
    }

    // ── Cancel pending price update ──────────────────────────
    if (lower === 'cancel') {
      await fetch(`${SUPA_URL}/rest/v1/settings?key=eq.pending_price_update`, {
        method: 'PATCH',
        headers: supaHeaders,
        body: JSON.stringify({ value: null })
      });
      await tgSend(MILTON_ID, `❌ Price update cancelled. No changes made.`);
      return { statusCode: 200, body: 'ok' };
    }

    // ── Order status (IMEI) ──────────────────────────────────
    const orderUpdate = parseOrderStatus(text);
    if (orderUpdate) {
      const { imei, status, detail } = orderUpdate;
      const orders = await supaGet('orders', `imei=eq.${imei}&limit=1`);

      if (!orders.length) {
        await tgSend(MILTON_ID,
          `⚠️ <b>Order not found</b>\nIMEI: <code>${imei}</code>\nNo matching order in your database.`
        );
        return { statusCode: 200, body: 'ok' };
      }

      const order = orders[0];
      await supaPatch('orders', `id=eq.${order.id}`, {
        status,
        supplier_note: detail || null,
        updated_at: new Date().toISOString()
      });

      const emoji = status === 'Completed' ? '✅' : '❌';
      const label = status === 'Completed' ? 'UNLOCKED' : 'FAILED';

      await tgSend(MILTON_ID,
        `${emoji} <b>Order ${label}</b>\n` +
        `Order: <b>#${order.order_number || order.id.slice(0,8)}</b>\n` +
        `IMEI: <code>${imei}</code>\n` +
        `Customer: ${order.name || 'Guest'} (${order.email || 'no email'})\n` +
        `Service: ${order.service_desc || order.description || '—'}\n` +
        (detail ? `Note: ${detail}` : '')
      );
      return { statusCode: 200, body: 'ok' };
    }

    // ── Price update ─────────────────────────────────────────
    const priceUpdate = parsePriceUpdate(text);
    if (priceUpdate) {
      const { newCost, serviceName } = priceUpdate;

      // Detect supplier from forwarded message header
      // Telegram sets forward_from_chat.title for channel forwards
      const supplierName = msg.forward_from_chat?.title ||
                           msg.forward_from?.first_name ||
                           msg.forward_sender_name ||
                           null;

      if (!serviceName) {
        await tgSend(MILTON_ID,
          `⚠️ Price update detected but couldn't read the service name.\n` +
          `Supplier: ${supplierName || 'Unknown'}\n` +
          `New cost: $${newCost}\n\nForward the full message from the supplier channel.`
        );
        return { statusCode: 200, body: 'ok' };
      }

      const allServices = await supaGet('services', 'select=id,carrier,stype,brand,series,cost,price,supplier&limit=500');
      const matches = matchServices(allServices, serviceName, supplierName);

      if (!matches.length) {
        await tgSend(MILTON_ID,
          `⚠️ <b>Price update — no match found</b>\n` +
          `Supplier: ${supplierName || 'Unknown'}\n` +
          `Service: "${serviceName}"\n` +
          `New cost: $${newCost}\n\n` +
          `No services matched. Check the supplier field on your services in admin.`
        );
        return { statusCode: 200, body: 'ok' };
      }

      const previewLines = matches.map(s =>
        `• ${s.carrier} | ${s.stype} — was $${s.cost} → $${newCost} (sell $${calcSellPrice(newCost)})`
      ).join('\n');

      const pendingIds = matches.map(s => s.id).join(',');

      await fetch(`${SUPA_URL}/rest/v1/settings`, {
        method: 'POST',
        headers: { ...supaHeaders, 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({
          key: 'pending_price_update',
          value: JSON.stringify({ ids: pendingIds, newCost, serviceName, supplierName, ts: Date.now() })
        })
      });

      await tgSend(MILTON_ID,
        `💰 <b>Price update ready</b>\n` +
        `Supplier: <b>${supplierName || 'Unknown'}</b>\n` +
        `Service: "${serviceName}"\n` +
        `New cost: $${newCost} → sell $${calcSellPrice(newCost)}\n` +
        `${matches.length} service${matches.length > 1 ? 's' : ''} matched:\n\n` +
        `${previewLines}\n\n` +
        `Reply <b>confirm</b> to apply, or <b>cancel</b> to skip.`
      );
      return { statusCode: 200, body: 'ok' };
    }

    // ── Greeting ─────────────────────────────────────────────
    if (lower === '/start' || lower === 'hi' || lower === 'hello') {
      await tgSend(MILTON_ID,
        `👋 <b>Rotten Apple GSM Bot active!</b>\n\n` +
        `Forward me:\n` +
        `✅/❌ supplier bot messages → auto-updates order status\n` +
        `📊 Price update messages from any supplier → shows you what changes and asks for confirmation\n\n` +
        `Commands: <b>confirm</b> | <b>cancel</b>`
      );
    }

  } catch (err) {
    console.error('Telegram webhook error:', err);
    await tgSend(MILTON_ID, `⚠️ Bot error: ${err.message}`).catch(() => {});
  }

  return { statusCode: 200, body: 'ok' };
};
