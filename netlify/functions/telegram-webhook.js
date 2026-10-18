// ============================================================
// Rotten Apple GSM — Telegram Webhook
// File: netlify/functions/telegram-webhook.js
//
// Handles two types of messages forwarded to @RottenAppleGSM_bot:
//
// 1. PRICE UPDATE (forwarded from XpertUnlock or any supplier channel)
//    Detects "Price increased" / "Price decreased" + service name + new price
//    Matches service by supplier name + keyword, updates cost + recalcs sell price
//
// 2. ORDER STATUS (forwarded from supplier unlock bot)
//    Detects ✅ or ❌ + IMEI number
//    Finds order in Supabase by IMEI, updates status, notifies customer
// ============================================================

const SUPA_URL   = 'https://fkiajefrdcgiobrzftjx.supabase.co';
const SUPA_KEY   = process.env.SUPABASE_ANON_KEY;
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const MILTON_ID  = 689316020;   // Milton's Telegram chat ID

// Average payment processing fee (Stripe + PayPal average)
const FEE_RATE   = (0.029 + 0.0349) / 2;   // 3.195%
const FEE_FLAT   = (0.30  + 0.49)   / 2;   // $0.395
const MIN_PROFIT = 25;

// ── Supabase helpers ────────────────────────────────────────

const supaHeaders = {
  'apikey': SUPA_KEY,
  'Authorization': `Bearer ${SUPA_KEY}`,
  'Content-Type': 'application/json'
};

async function supaGet(table, query) {
  const url = `${SUPA_URL}/rest/v1/${table}?${query}`;
  const res  = await fetch(url, { headers: supaHeaders });
  if (!res.ok) throw new Error(`Supabase GET ${table} ${res.status}`);
  return res.json();
}

async function supaPatch(table, query, body) {
  const url = `${SUPA_URL}/rest/v1/${table}?${query}`;
  const res  = await fetch(url, {
    method: 'PATCH',
    headers: supaHeaders,
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${table} ${res.status}`);
  return res.ok;
}

// ── Telegram helper ─────────────────────────────────────────

async function tgSend(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

// ── Auto-price calculator (matches frontend logic) ──────────

function calcSellPrice(cost) {
  const rawPrice = (cost + MIN_PROFIT + FEE_FLAT) / (1 - FEE_RATE);
  let rounded = Math.ceil(rawPrice) - 0.01;
  if (rounded < rawPrice) rounded += 1;
  return parseFloat(rounded.toFixed(2));
}

// ── Parse price update message ───────────────────────────────
// XpertUnlock format examples:
//   "Price increased\nCricket USA - iPhone 18 Series...\n171.27 USD → 170.45 USD"
//   "Price decreased\n17 Pro Max Premium\n106.68 USD → 106.16 USD"

function parsePriceUpdate(text) {
  const upper = text.toUpperCase();
  const isPrice = upper.includes('PRICE INCREASED') ||
                  upper.includes('PRICE DECREASED') ||
                  upper.includes('PRICE INCREASE') ||
                  upper.includes('PRICE DECREASE');
  if (!isPrice) return null;

  // Extract new price — look for "X.XX USD" pattern, take the LAST one (after →)
  const priceMatches = [...text.matchAll(/(\d+\.\d{2})\s*USD/g)];
  if (!priceMatches.length) return null;
  const newCost = parseFloat(priceMatches[priceMatches.length - 1][1]);

  // Extract service name — the line that contains a carrier or service keyword
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let serviceName = '';
  for (const line of lines) {
    // Skip lines that are just price arrows or headers
    if (/USD|PRICE (IN|DE)CREASE/i.test(line) && !/[a-z]{4}/i.test(line.replace(/USD|\d|\.|→|↑|↓/g,''))) continue;
    if (/PRICE (IN|DE)CREASE/i.test(line)) continue;
    if (/^\d+\.\d{2}/.test(line)) continue;
    if (line.length > 5) { serviceName = line; break; }
  }

  return { newCost, serviceName };
}

// ── Parse order status message ───────────────────────────────
// Supplier bot format:
//   "✅ 357513545081086\nUnlocked\nT-mobile Usa - App Mobile..."
//   "❌ 351668144426029\nService was disabled! ReferenceID 0\nVerizon..."

function parseOrderStatus(text) {
  // Check for IMEI (15 digits)
  const imeiMatch = text.match(/\b(\d{15})\b/);
  if (!imeiMatch) return null;

  const imei   = imeiMatch[1];
  const isWin  = text.includes('✅') || text.toLowerCase().includes('unlocked');
  const isFail = text.includes('❌') || text.toLowerCase().includes('disabled') ||
                 text.toLowerCase().includes('failed') || text.toLowerCase().includes('rejected');

  if (!isWin && !isFail) return null;

  const status = isWin ? 'Completed' : 'Failed';

  // Try to get status detail (second line after IMEI line)
  const lines   = text.split('\n').map(l => l.trim()).filter(Boolean);
  let detail    = '';
  for (const line of lines) {
    if (line.includes(imei)) continue;
    if (line.includes('✅') || line.includes('❌')) continue;
    detail = line; break;
  }

  return { imei, status, detail };
}

// ── Main handler ─────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'Rotten Apple GSM Telegram Webhook' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Bad JSON' };
  }

  // Only process messages sent/forwarded to the bot by Milton
  const msg = body.message || body.channel_post;
  if (!msg) return { statusCode: 200, body: 'ok' };

  const fromId = msg.from?.id || msg.chat?.id;
  if (fromId !== MILTON_ID) {
    // Ignore messages from anyone else for now
    return { statusCode: 200, body: 'ok' };
  }

  const text = msg.text || msg.caption || '';
  if (!text) return { statusCode: 200, body: 'ok' };

  try {
    // ── Confirm / Cancel pending price update (check FIRST) ───
    const lower = text.toLowerCase().trim();

    if (lower === 'confirm') {
      const settings = await supaGet('settings', `key=eq.pending_price_update&limit=1`);
      if (!settings.length || !settings[0].value) {
        await tgSend(MILTON_ID, `⚠️ No pending price update found.`);
        return { statusCode: 200, body: 'ok' };
      }

      const pending = JSON.parse(settings[0].value);
      // Check it's not stale (older than 1 hour)
      if (Date.now() - pending.ts > 3600000) {
        await tgSend(MILTON_ID, `⚠️ Pending update expired. Forward the price message again.`);
        return { statusCode: 200, body: 'ok' };
      }

      const ids = pending.ids.split(',').filter(Boolean);
      let updated = 0;
      for (const id of ids) {
        await supaPatch('services', `id=eq.${id}`, {
          cost: pending.newCost,
          price: calcSellPrice(pending.newCost)
        });
        updated++;
      }

      // Clear the pending update
      await fetch(`${SUPA_URL}/rest/v1/settings?key=eq.pending_price_update`, {
        method: 'PATCH',
        headers: supaHeaders,
        body: JSON.stringify({ value: null })
      });

      await tgSend(MILTON_ID,
        `✅ <b>Price updated — ${updated} service${updated > 1 ? 's' : ''}</b>\n` +
        `Supplier: "${pending.serviceName}"\n` +
        `New cost: $${pending.newCost} | Sell: $${calcSellPrice(pending.newCost)}\n` +
        `Your $25 profit margin applied.`
      );
      return { statusCode: 200, body: 'ok' };
    }

    if (lower === 'cancel') {
      await fetch(`${SUPA_URL}/rest/v1/settings?key=eq.pending_price_update`, {
        method: 'PATCH',
        headers: supaHeaders,
        body: JSON.stringify({ value: null })
      });
      await tgSend(MILTON_ID, `❌ Price update cancelled. No changes made.`);
      return { statusCode: 200, body: 'ok' };
    }

    // ── Try order status (IMEI detection) ────────────────────
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

    // ── Try price update ──────────────────────────────────────
    const priceUpdate = parsePriceUpdate(text);
    if (priceUpdate) {
      const { newCost, serviceName } = priceUpdate;

      if (!serviceName) {
        await tgSend(MILTON_ID,
          `⚠️ Price update detected but couldn't extract service name.\nNew cost: $${newCost}\n\nForward the full message from the supplier channel.`
        );
        return { statusCode: 200, body: 'ok' };
      }

      const allServices = await supaGet('services', 'select=id,carrier,stype,brand,series,cost,price,supplier&limit=500');

      // ── Smarter matching ──────────────────────────────────────
      // Extract carrier keywords (exclude generic words)
      const svcLower = serviceName.toLowerCase();
      const carrierWords = svcLower
        .replace(/[^a-z0-9 &]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !['iphone','ipad','series','premium','standard','pro','max','plus','ultra','mini','usa','the','and','for','unlock','service'].includes(w));

      // Extract model range (e.g. 11-14 → {11,12,13,14})
      const modelRangeMatch = serviceName.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})/);
      const singleModelMatch = serviceName.match(/\b(X|XS|XR|SE|6S?|7|8|9|10|11|12|13|14|15|16)\b/gi);

      let coveredModels = new Set();
      if (modelRangeMatch) {
        const start = parseInt(modelRangeMatch[1]);
        const end   = parseInt(modelRangeMatch[2]);
        for (let m = start; m <= end; m++) coveredModels.add(String(m));
      } else if (singleModelMatch) {
        singleModelMatch.forEach(m => coveredModels.add(m.toUpperCase()));
      }

      const hasiPhone  = /iphone/i.test(serviceName);
      const hasSamsung = /samsung/i.test(serviceName);

      const matches = allServices.filter(s => {
        const hCarrier = (s.carrier || '').toLowerCase();
        const hSeries  = (s.series  || '').toLowerCase();
        const hBrand   = (s.brand   || '').toLowerCase();
        const hStype   = (s.stype   || '').toLowerCase();

        // Brand check
        if (hasiPhone  && !hBrand.includes('apple') && !hStype.includes('iphone') && !hSeries.includes('iphone')) return false;
        if (hasSamsung && !hBrand.includes('samsung')) return false;

        // Carrier check
        const carrierHit = carrierWords.some(w => hCarrier.includes(w));
        if (!carrierHit) return false;

        // Model overlap check
        if (coveredModels.size > 0) {
          const svcModels = (hSeries + ' ' + hStype).match(/\b(X|XS|XR|SE|\d{1,2})\b/gi) || [];
          const svcModelSet = new Set(svcModels.map(m => m.toUpperCase()));
          const overlap = [...coveredModels].some(m => svcModelSet.has(m.toUpperCase()));
          if (!overlap) return false;
        }

        return true;
      });

      if (!matches.length) {
        await tgSend(MILTON_ID,
          `⚠️ <b>Price update — no match found</b>\n` +
          `Service: "${serviceName}"\n` +
          `New supplier cost: $${newCost}\n\n` +
          `No service matched in your database. Update manually in admin.`
        );
        return { statusCode: 200, body: 'ok' };
      }

      // Preview matched services and ask Milton to confirm
      const previewLines = matches.map(s =>
        `• ${s.carrier} | ${s.stype} | ${s.series || s.brand} — cost $${s.cost} → $${newCost} (sell $${calcSellPrice(newCost)})`
      ).join('\n');

      const pendingIds = matches.map(s => s.id).join(',');

      await fetch(`${SUPA_URL}/rest/v1/settings`, {
        method: 'POST',
        headers: { ...supaHeaders, 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify({
          key: 'pending_price_update',
          value: JSON.stringify({ ids: pendingIds, newCost, serviceName, ts: Date.now() })
        })
      });

      await tgSend(MILTON_ID,
        `💰 <b>Price update ready — ${matches.length} service${matches.length > 1 ? 's' : ''} matched</b>\n` +
        `Supplier: "${serviceName}"\n` +
        `New cost: $${newCost} → sell $${calcSellPrice(newCost)}\n\n` +
        `${previewLines}\n\n` +
        `Reply <b>confirm</b> to apply these changes, or <b>cancel</b> to skip.`
      );

      return { statusCode: 200, body: 'ok' };
    }

    // ── Greeting / help ───────────────────────────────────────
    if (lower === '/start' || lower === 'hi' || lower === 'hello') {
      await tgSend(MILTON_ID,
        `👋 <b>Rotten Apple GSM Bot active!</b>\n\n` +
        `Forward me:\n` +
        `✅/❌ messages from your supplier bot to auto-update order status\n` +
        `📊 Price update messages from XpertUnlock or other suppliers to auto-update your prices\n\n` +
        `I'll handle the rest automatically.`
      );
    }

  } catch (err) {
    console.error('Telegram webhook error:', err);
    await tgSend(MILTON_ID, `⚠️ Bot error: ${err.message}`).catch(() => {});
  }

  return { statusCode: 200, body: 'ok' };
};
