const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  try {
    const { imei, serviceId } = JSON.parse(event.body);
    const key = process.env.SICKW_API_KEY;
    
    if (!key) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'API key not configured' }) };
    if (!imei || !serviceId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing imei or serviceId' }) };

    const url = `https://sickw.com/api.php?format=JSON&key=${key}&imei=${imei}&service=${serviceId}`;
    
    const data = await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch(e) { resolve({ result: body, status: 'unknown' }); }
        });
        res.on('error', reject);
      }).on('error', reject);
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify(data)
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
