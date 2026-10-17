// ============================================================
// Rotten Apple GSM — Telegram Webhook
// netlify/functions/telegram-webhook.js
//
// Handles:
// 1. Milton forwarding supplier price updates → auto-updates cost + sell price
// 2. Milton forwarding supplier bot ✅/❌ + IMEI → auto-updates order status
// 3. Customers messaging bot with IMEI + email → order status lookup
// ============================================================

const SUPA_URL  = 'https://fkiajefrdcgiobrzftjx.supabase.co';
const SUPA_KEY  = process.env.SUPABASE_ANON_KEY;
const TG_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const MILTON_ID = 689316020;

const FEE_RATE  = (0.029 + 0.0349) / 2;
const FEE_FLAT  = (0.30  + 0.49)   / 2;
const MIN_PROFIT = 25;

// In-memory session store for customer verification flow
// { chatId: { step: 'await_email', imei: '123...' } }
const sessions = {};

// ── Supabase helpers ────────────────────────────────────────

const supaHeaders = () => ({
  'apikey': SUPA_KEY,
  'Authorization': `Bearer ${SUPA_KEY}`,
  'Content-Type': 'application/json'
});

async function supaGet(table, query) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}?${query}`, { headers: supaHeaders() });
  if (!res.ok) throw new Error(`Supabase GET ${table} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function supaPatch(table, query, body) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: supaHeaders(),
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${table} ${res.status}: ${await res.text()}`);
  return true;
}

// ── Telegram helper ─────────────────────────────────────────

async function tgSend(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

// ── Auto-price calculator ───────────────────────────────────

function calcSellPrice(cost) {
  const rawPrice = (cost + MIN_PROFIT + FEE_FLAT) / (1 - FEE_RATE);
  let rounded = Math.ceil(rawPrice) - 0.01;
  if (rounded < rawPrice) rounded += 1;
  return parseFloat(rounded.toFixed(2));
}

// ── Status label helper ─────────────────────────────────────

function statusMessage(status, description) {
  const svc = description || 'your service';
  switch ((status || '').toLowerCase()) {
    case 'completed':
      return `✅ <b>Your phone is unlocked!</b>\n\nService: ${svc}\n\nYour device is now permanently unlocked. Insert any carrier SIM and you're good to go!\n\nThank you for choosing Rotten Apple GSM 🙏`;
    case 'failed':
      return `❌ <b>Unlock could not be completed</b>\n\nService: ${svc}\n\nUnfortunately this unlock was unsuccessful. Please contact us at rottenapplegsm@gmail.com or reply here and we'll look into it right away.`;
    case 'processing':
    case 'in progress':
      return `⏳ <b>Your order is in progress</b>\n\nService: ${svc}\n\nWe're working on it. You'll receive a message here as soon as it's done. Average time: 24-72 hours.`;
    default:
      return `📦 <b>Order received</b>\n\nService: ${svc}\n\nYour order is pending verification. We'll notify you right here once we confirm your payment and start processing.`;
  }
}

// ── Parse price update (forwarded from supplier channel) ────

function parsePriceUpdate(text) {
  const upper = text.toUpperCase();
  const isPrice = upper.includes('PRICE INCREASED') || upper.includes('PRICE DECREASED') ||
                  upper.includes('PRICE INCREASE')  || upper.includes('PRICE DECREASE');
  if (!isPrice) return null;

  const priceMatches = [...text.matchAll(/(\d+\.\d{2})\s*USD/g)];
  if (!priceMatches.length) return null;
  const newCost = parseFloat(priceMatches[priceMatches.length - 1][1]);

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let serviceName = '';
  for (const line of lines) {
    if (/PRICE (IN|DE)CREASE/i.test(line)) continue;
    if (/^\d+\.\d{2}/.test(line)) continue;
    if (/USD/.test(line) && line.length < 30) continue;
    if (line.length > 5) { serviceName = line; break; }
  }

  return { newCost, serviceName };
}

// ── Parse order status (forwarded from supplier bot) ────────

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
    if (line.includes(imei)) continue;
    if (line.includes('✅') || line.includes('❌')) continue;
    detail = line; break;
  }

  return { imei, status, detail };
}

// ── Main handler ────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'Rotten Apple GSM Telegram Webhook OK' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: 'Bad JSON' }; }

  const msg = body.message || body.channel_post;
  if (!msg) return { statusCode: 200, body: 'ok' };

  const chatId = msg.chat?.id;
  const fromId = msg.from?.id || chatId;
  const text   = (msg.text || msg.caption || '').trim();
  if (!text || !chatId) return { statusCode: 200, body: 'ok' };

  try {

    // ════════════════════════════════════════════════════════
    // MILTON MESSAGES — supplier price/status updates
    // ════════════════════════════════════════════════════════
    if (fromId === MILTON_ID) {

      // 1. Order status forwarded from supplier bot
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
        await tgSend(MILTON_ID,
          `${emoji} <b>Order ${status.toUpperCase()}</b>\n` +
          `Order: <b>#${order.order_number || order.id?.slice(0,8) || '—'}</b>\n` +
          `IMEI: <code>${imei}</code>\n` +
          `Customer: ${order.customer_name || 'Guest'} — ${order.email || 'no email'}\n` +
          `Service: ${order.description || '—'}\n` +
          (detail ? `Note: ${detail}` : '')
        );

        // Notify the customer via bot if they have a Telegram session
        // (they would have checked their order via the bot previously)
        const customerSessions = Object.entries(sessions)
          .filter(([, s]) => s.imei === imei && s.email === order.email);
        for (const [cid] of customerSessions) {
          await tgSend(parseInt(cid), statusMessage(status, order.description));
        }

        return { statusCode: 200, body: 'ok' };
      }

      // 2. Price update forwarded from supplier channel
      const priceUpdate = parsePriceUpdate(text);
      if (priceUpdate) {
        const { newCost, serviceName } = priceUpdate;

        if (!serviceName) {
          await tgSend(MILTON_ID,
            `⚠️ Price update detected but service name not found.\nNew cost: $${newCost}\nForward the full message.`
          );
          return { statusCode: 200, body: 'ok' };
        }

        const allServices = await supaGet('services', 'select=id,carrier,stype,brand,series,cost,price&limit=500');
        const keywords = serviceName.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(w => w.length > 2);

        const matches = allServices.filter(s => {
          const hay = `${s.carrier||''} ${s.stype||''} ${s.brand||''} ${s.series||''}`.toLowerCase();
          return keywords.filter(k => hay.includes(k)).length >= 2;
        });

        if (!matches.length) {
          await tgSend(MILTON_ID,
            `⚠️ <b>No match found</b>\nService: "${serviceName}"\nNew cost: $${newCost}\n\nUpdate manually in admin panel.`
          );
          return { statusCode: 200, body: 'ok' };
        }

        const updated = [];
        for (const svc of matches) {
          const newSellPrice = calcSellPrice(newCost);
          await supaPatch('services', `id=eq.${svc.id}`, { cost: newCost, price: newSellPrice });
          updated.push({ svc, newSellPrice });
        }

        const lines = updated.map(({ svc, newSellPrice }) =>
          `• ${svc.carrier} ${svc.stype} — cost $${newCost} → sell $${newSellPrice}`
        ).join('\n');

        await tgSend(MILTON_ID,
          `💰 <b>Price updated (${updated.length} service${updated.length > 1 ? 's' : ''})</b>\n` +
          `"${serviceName}"\nNew cost: $${newCost}\n\n${lines}\n\n$25 profit margin applied automatically.`
        );
        return { statusCode: 200, body: 'ok' };
      }

      // 3. Milton greeting
      const lower = text.toLowerCase();
      if (['/start','hi','hello','hey'].includes(lower)) {
        await tgSend(MILTON_ID,
          `👋 <b>Rotten Apple GSM Bot active!</b>\n\n` +
          `Forward me:\n` +
          `✅/❌ supplier bot messages → auto-updates order status + notifies customer\n` +
          `📊 Price update messages from XpertUnlock or any supplier → auto-updates sell price with $25 profit\n\n` +
          `Customers can also message this bot directly with their IMEI to check order status.`
        );
      }

      return { statusCode: 200, body: 'ok' };
    }

    // ════════════════════════════════════════════════════════
    // CUSTOMER MESSAGES — order status lookup
    // ════════════════════════════════════════════════════════

    const session = sessions[chatId] || {};
    const lower   = text.toLowerCase();

    // /start or greeting
    if (lower === '/start' || lower === 'hi' || lower === 'hello' || lower === 'hey') {
      delete sessions[chatId];
      await tgSend(chatId,
        `👋 Welcome to <b>Rotten Apple GSM</b>!\n\n` +
        `To check your order status, send me your <b>15-digit IMEI number</b>.\n\n` +
        `Dial <code>*#06#</code> on your phone to find your IMEI.`
      );
      return { statusCode: 200, body: 'ok' };
    }

    // Step 1: Customer sends IMEI
    const imeiMatch = text.match(/\b(\d{15})\b/);
    if (imeiMatch && session.step !== 'await_email') {
      const imei = imeiMatch[1];
      sessions[chatId] = { step: 'await_email', imei };
      await tgSend(chatId,
        `🔍 IMEI received: <code>${imei}</code>\n\n` +
        `Now please send the <b>email address</b> you used when placing your order.`
      );
      return { statusCode: 200, body: 'ok' };
    }

    // Step 2: Customer sends email
    if (session.step === 'await_email') {
      const emailMatch = text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
      if (!emailMatch) {
        await tgSend(chatId,
          `That doesn't look like a valid email. Please send the email address you used when placing your order.`
        );
        return { statusCode: 200, body: 'ok' };
      }

      const email = emailMatch[0].toLowerCase();
      const imei  = session.imei;

      // Save verified session for later notifications
      sessions[chatId] = { step: 'verified', imei, email };

      // Look up order
      const orders = await supaGet('orders',
        `imei=eq.${imei}&email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1`
      );

      if (!orders.length) {
        // Try IMEI only — email might be different
        const byImei = await supaGet('orders', `imei=eq.${imei}&order=created_at.desc&limit=1`);
        if (!byImei.length) {
          await tgSend(chatId,
            `❌ No order found for that IMEI.\n\nDouble-check your IMEI (dial <code>*#06#</code>) or contact us at rottenapplegsm@gmail.com`
          );
          delete sessions[chatId];
          return { statusCode: 200, body: 'ok' };
        }
        // IMEI found but email doesn't match
        await tgSend(chatId,
          `❌ Email doesn't match our records for that IMEI.\n\nTry the email you used when ordering, or contact us at rottenapplegsm@gmail.com`
        );
        return { statusCode: 200, body: 'ok' };
      }

      const order = orders[0];
      await tgSend(chatId,
        `📦 <b>Order #${order.order_number || order.id?.slice(0,8)}</b>\n\n` +
        statusMessage(order.status, order.description) +
        `\n\n<i>We'll send you an update here automatically when your order status changes.</i>`
      );

      return { statusCode: 200, body: 'ok' };
    }

    // Fallback for unrecognised customer message
    await tgSend(chatId,
      `To check your order, send me your <b>15-digit IMEI number</b>.\n\nDial <code>*#06#</code> on your phone to find it.`
    );

  } catch (err) {
    console.error('Telegram webhook error:', err);
    if (fromId === MILTON_ID) {
      await tgSend(MILTON_ID, `⚠️ Bot error: ${err.message}`).catch(() => {});
    }
  }

  return { statusCode: 200, body: 'ok' };
};
