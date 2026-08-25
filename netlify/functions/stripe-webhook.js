exports.handler = async (event) => {
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
      await fetch(SURL + '/rest/v1/orders', {
        method: 'POST',
        headers: {
          'apikey': SKEY,
          'Authorization': 'Bearer ' + SKEY,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify([order])
      });
      console.log('Order saved:', order.id);
    } catch (e) {
      console.error('Failed to save order:', e);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
