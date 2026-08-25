const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_BASE = process.env.PAYPAL_ENV === "sandbox"
  ? "https://api-m.sandbox.paypal.com"
  : "https://api-m.paypal.com";

async function getAccessToken() {
  const creds = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Authorization": `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  });
  const data = await res.json();
  return data.access_token;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  try {
    const body = JSON.parse(event.body);
    const { orderID, orderId, orderNumber, customerName, email, description, imei, cost, accountId } = body;
    if (!orderID) return { statusCode: 400, body: JSON.stringify({ error: "Missing orderID" }) };

    const accessToken = await getAccessToken();
    const res = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderID}/capture`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" }
    });
    const captureData = await res.json();
    if (!res.ok) return { statusCode: res.status, body: JSON.stringify({ error: "Capture failed", details: captureData }) };

    const capture = captureData.purchase_units?.[0]?.payments?.captures?.[0];
    const amount = parseFloat(capture?.amount?.value || 0);

    // Save order to Supabase
    const SURL = 'https://fkiajefrdcgiobrzftjx.supabase.co';
    const SKEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZraWFqZWZyZGNnaW9icnpmdGp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1NzcwNTgsImV4cCI6MjA5ODE1MzA1OH0.3f7jYWdqzLJjWpxb4_zZrS3Uo2VeHVx81TuXouYNwuk';

    const order = {
      id: orderId || ('RA-PP-' + Date.now()),
      order_number: parseInt(orderNumber) || 0,
      customer_name: customerName || 'Guest',
      email: email || captureData.payer?.email_address || '',
      description: description || '',
      imei: imei || '',
      amount: amount,
      cost: parseFloat(cost) || 0,
      payment_method: 'PayPal',
      status: 'Processing',
      placed: new Date().toISOString().split('T')[0],
      completed: null,
      account_id: accountId || null,
      notes: 'PayPal capture: ' + orderID
    };

    await fetch(SURL + '/rest/v1/orders', {
      method: 'POST',
      headers: { 'apikey': SKEY, 'Authorization': 'Bearer ' + SKEY, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify([order])
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ success: true, captureId: capture?.id, amount })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
