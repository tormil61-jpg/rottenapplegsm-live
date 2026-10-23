const crypto = require('crypto');

function verifyStripeSignature(payload, sigHeader, secret) {
  if (!secret || !sigHeader) return true; // skip if not configured (dev/test)
  try {
    const parts = sigHeader.split(',').reduce((acc, part) => {
      const [k, v] = part.split('=');
      acc[k] = v;
      return acc;
    }, {});
    const timestamp = parts['t'];
    const sig = parts['v1'];
    if (!timestamp || !sig) return false;
    const signed = `${timestamp}.${payload}`;
    const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch (e) {
    return false;
  }
}

exports.handler = async (event) => {
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const sigHeader = event.headers['stripe-signature'];

  if (WEBHOOK_SECRET && !verifyStripeSignature(event.body, sigHeader, WEBHOOK_SECRET)) {
    console.error('Stripe webhook signature verification failed');
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(event.body);
  } catch (err) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const meta = session.metadata || {};
    const SURL = 'https://fkiajefrdcgiobrzftjx.supabase.co';
    const SKEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZraWFqZWZyZGNnaW9icnpmdGp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1NzcwNTgsImV4cCI6MjA5ODE1MzA1OH0.3f7jYWdqzLJjWpxb4_zZrS3Uo2VeHVx81TuXouYNwuk';

    const order = {
      id: meta.orderId || ('RA-STR-' + Date.now()),
      order_number: parseInt(meta.orderNumber) || 0,
      customer_name: meta.customerName || session.customer_details?.name || 'Guest',
      email: session.customer_email || meta.email || '',
      description: meta.description || '',
      imei: meta.imei || '',
      amount: (session.amount_total || 0) / 100,
      cost: parseFloat(meta.cost) || 0,
      payment_method: 'Stripe',
      status: 'Processing',
      placed: new Date().toISOString().split('T')[0],
      completed: null,
      account_id: meta.accountId || null,
      notes: 'Stripe session: ' + session.id
    };

    try {
      const r = await fetch(SURL + '/rest/v1/orders', {
        method: 'POST',
        headers: {
          'apikey': SKEY,
          'Authorization': 'Bearer ' + SKEY,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify([order])
      });
      if (!r.ok) {
        const err = await r.text();
        console.error('Failed to save order:', err);
      } else {
        console.log('Order saved:', order.id);
      }
    } catch (e) {
      console.error('Failed to save order:', e);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
