const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { imei, serviceId, apiUrl } = JSON.parse(event.body);
    const key = process.env.SICKW_API_KEY;
    
    if (!key) return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
    if (!imei || !serviceId) return { statusCode: 400, body: JSON.stringify({ error: 'Missing imei or serviceId' }) };

    const url = `${apiUrl || 'https://sickw.com/api.php'}?format=JSON&key=${key}&imei=${imei}&service=${serviceId}`;
    
    const data = await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(JSON.parse(body)));
        res.on('error', reject);
      }).on('error', reject);
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
