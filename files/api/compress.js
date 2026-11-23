/**
 * Vercel Serverless Function: /api/compress
 * Compatible with Vercel Free Tier
 */

export const config = {
  api: {
    bodyParser: false, // Disabling body parser to handle raw binary / multipart streams
  },
};

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'online',
      month: new Date().toISOString().slice(0, 7),
      tinifyLimit: '500/month (auto-resets 1st of month)',
      imagekitLimit: '20 GB/month'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 1. Validate API Key
    const clientKey = req.headers['x-api-key'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    const allowedKeys = (process.env.CLIENT_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);

    if (allowedKeys.length > 0 && (!clientKey || !allowedKeys.includes(clientKey))) {
      return res.status(401).json({ error: '401 Unauthorized: Invalid or missing x-api-key' });
    }

    // 2. Read incoming buffer
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ error: 'Empty image payload' });
    }

    // STEP 1: Tinify
    if (process.env.TINIFY_API_KEY) {
      try {
        const tinyRes = await fetch('https://api.tinify.com/shrink', {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + Buffer.from('api:' + process.env.TINIFY_API_KEY).toString('base64')
          },
          body: buffer
        });

        const count = tinyRes.headers.get('Compression-Count');
        if (tinyRes.ok) {
          const data = await tinyRes.json();
          const imgRes = await fetch(data.output.url, {
            headers: { 'Authorization': 'Basic ' + Buffer.from('api:' + process.env.TINIFY_API_KEY).toString('base64') }
          });
          const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

          res.setHeader('Content-Type', data.output.type || 'image/jpeg');
          res.setHeader('X-Provider', 'TinyPNG');
          if (count) res.setHeader('X-Monthly-Tinify-Count', count);
          return res.status(200).send(imgBuffer);
        }
      } catch (err) {
        console.error('TinyPNG failed, falling back to ImageKit', err);
      }
    }

    // STEP 2: ImageKit
    if (process.env.IMAGEKIT_PRIVATE_KEY && process.env.IMAGEKIT_URL_ENDPOINT) {
      try {
        const formData = new FormData();
        const b64 = buffer.toString('base64');
        formData.append('file', 'data:image/jpeg;base64,' + b64);
        formData.append('fileName', 'compress_' + Date.now() + '.jpg');
        formData.append('useUniqueFileName', 'true');

        const ikRes = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + Buffer.from(process.env.IMAGEKIT_PRIVATE_KEY + ':').toString('base64')
          },
          body: formData
        });

        if (ikRes.ok) {
          const ikData = await ikRes.json();
          const optRes = await fetch(`${ikData.url}?tr=q-80,f-auto`);
          const optBuffer = Buffer.from(await optRes.arrayBuffer());

          res.setHeader('Content-Type', optRes.headers.get('content-type') || 'image/webp');
          res.setHeader('X-Provider', 'ImageKit');
          return res.status(200).send(optBuffer);
        }
      } catch (err) {
        console.error('ImageKit failed', err);
      }
    }

    return res.status(502).json({ error: 'All compression providers failed or exhausted.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
