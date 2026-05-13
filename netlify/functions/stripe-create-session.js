exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const KEY = process.env.STRIPE_SECRET_KEY;
  if (!KEY) return { statusCode: 500, body: JSON.stringify({ error: 'Stripe not configured' }) };
  try {
    const { amount, currency = 'USD', description, orderId, customerEmail } = JSON.parse(event.body);
    if (!amount || isNaN(parseFloat(amount))) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid amount' }) };
    const p = new URLSearchParams({ 'payment_method_types[]': 'card', 'line_items[0][price_data][currency]': currency.toLowerCase(), 'line_items[0][price_data][product_data][name]': description || 'Rotten Apple GSM Unlock Service', 'line_items[0][price_data][unit_amount]': Math.round(parseFloat(amount)*100).toString(), 'line_items[0][quantity]': '1', 'mode': 'payment', 'success_url': 'https://www.rottenapplegsm.com/?stripe=success&order='+(orderId||''), 'cancel_url': 'https://www.rottenapplegsm.com/?stripe=cancel', 'metadata[orderId]': orderId||'' });
    if (customerEmail) p.append('customer_email', customerEmail);
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { 'Authorization': 'Bearer '+KEY, 'Content-Type': 'application/x-www-form-urlencoded' }, body: p.toString() });
    const s = await res.json();
    if (!res.ok) return { statusCode: res.status, body: JSON.stringify({ error: s.error?.message || 'Stripe error' }) };
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ sessionId: s.id, url: s.url }) };
  } catch (err) { return { statusCode: 500, body: JSON.stringify({ error: err.message }) }; }
};
