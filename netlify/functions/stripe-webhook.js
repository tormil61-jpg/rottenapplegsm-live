const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    console.log('Payment completed:', {
      sessionId: session.id,
      orderId: session.metadata?.orderId,
      amount: session.amount_total / 100,
      currency: session.currency,
      customerEmail: session.customer_email,
    });
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
