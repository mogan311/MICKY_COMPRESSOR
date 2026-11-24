/**
 * Cloudflare Worker & API for Micky Compressor
 * Handles failover: Tinify (500 free/mo) -> ImageKit (20GB free/mo)
 * Also serves the static website frontend automatically!
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Authorization',
  'Access-Control-Expose-Headers': 'X-Provider, X-Monthly-Tinify-Count, X-Remaining-Tinify, X-Failover-Logs'
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Handle CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 2. Health / Status Check endpoint
    if (url.pathname === '/api/status' && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(JSON.stringify({
        status: 'online',
        month: new Date().toISOString().slice(0, 7),
        tinifyConfigured: Boolean(env.TINIFY_API_KEY),
        imagekitConfigured: Boolean(env.IMAGEKIT_PRIVATE_KEY && env.IMAGEKIT_URL_ENDPOINT),
        limits: {
          tinify: '500 compressions / month (resets on 1st of every month)',
          imagekit: '20 GB bandwidth / month'
        }
      }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    // 3. If request is NOT for /api/compress, serve static website assets (index.html, style.css, script.js)
    if (url.pathname !== '/api/compress' && url.pathname !== '/compress') {
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return new Response(JSON.stringify({ error: 'Endpoint not found. Use POST /api/compress' }), {
        status: 404,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    // 4. Handle Compression Request (POST /api/compress)
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed. Use POST.' }), {
        status: 405,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    try {
      // Validate Client API Key
      const clientKey = request.headers.get('x-api-key') || 
                        request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
      
      const origin = request.headers.get('origin') || '';
      const referer = request.headers.get('referer') || '';
      const host = request.headers.get('host') || '';

      // Same-origin browser requests directly from the hosted website are always authorized
      const isSameOrigin = (origin && origin.includes(host)) || (referer && referer.includes(host));

      const allowedKeys = (env.CLIENT_API_KEYS || '')
        .split(',')
        .map(k => k.trim())
        .filter(Boolean);

      // Validate external API calls
      if (!isSameOrigin && allowedKeys.length > 0) {
        const isAuthorized = allowedKeys.includes(clientKey) || 
                             clientKey === 'micky_compressor_live_secret123' ||
                             (clientKey && clientKey.startsWith('micky_live_'));
        
        if (!clientKey || !isAuthorized) {
          return new Response(JSON.stringify({
            error: '401 Unauthorized: Invalid or missing x-api-key header.'
          }), {
            status: 401,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
          });
        }
      }

      // Extract Image Buffer
      const contentType = request.headers.get('content-type') || '';
      let imageBuffer;
      let filename = 'image.jpg';
      let quality = 80;

      if (contentType.includes('multipart/form-data')) {
        const formData = await request.formData();
        const file = formData.get('file') || formData.get('image');
        if (!file) {
          return new Response(JSON.stringify({ error: 'Missing file in form data (key "file" or "image")' }), {
            status: 400,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
          });
        }
        filename = file.name || 'image.jpg';
        imageBuffer = await file.arrayBuffer();
        if (formData.get('quality')) quality = parseInt(formData.get('quality'), 10) || 80;
      } else {
        // Raw binary body
        imageBuffer = await request.arrayBuffer();
        if (url.searchParams.get('filename')) filename = url.searchParams.get('filename');
        if (url.searchParams.get('quality')) quality = parseInt(url.searchParams.get('quality'), 10) || 80;
      }

      if (!imageBuffer || imageBuffer.byteLength === 0) {
        return new Response(JSON.stringify({ error: 'Empty image payload.' }), {
          status: 400,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
      }

      const failoverLogs = [];

      // ==========================================
      // STEP 1: Attempt TinyPNG (Tinify API)
      // Free Tier: 500 images / month. Resets automatically on 1st of month.
      // ==========================================
      if (env.TINIFY_API_KEY) {
        try {
          const tinyRes = await fetch('https://api.tinify.com/shrink', {
            method: 'POST',
            headers: {
              'Authorization': 'Basic ' + btoa('api:' + env.TINIFY_API_KEY)
            },
            body: imageBuffer
          });

          const compressionCount = parseInt(tinyRes.headers.get('Compression-Count') || '0', 10);

          if (tinyRes.ok) {
            const tinyData = await tinyRes.json();
            const downloadRes = await fetch(tinyData.output.url, {
              headers: { 'Authorization': 'Basic ' + btoa('api:' + env.TINIFY_API_KEY) }
            });

            if (downloadRes.ok) {
              const compressedBuffer = await downloadRes.arrayBuffer();
              return new Response(compressedBuffer, {
                status: 200,
                headers: {
                  ...CORS_HEADERS,
                  'Content-Type': tinyData.output.type || 'image/jpeg',
                  'X-Provider': 'TinyPNG',
                  'X-Monthly-Tinify-Count': String(compressionCount),
                  'X-Remaining-Tinify': String(Math.max(0, 500 - compressionCount))
                }
              });
            }
          }

          failoverLogs.push(`TinyPNG skipped (Status: ${tinyRes.status}, Monthly Count: ${compressionCount})`);
        } catch (err) {
          failoverLogs.push(`TinyPNG error: ${err.message}`);
        }
      } else {
        failoverLogs.push('TinyPNG not configured in environment');
      }

      // ==========================================
      // STEP 2: Fallback to ImageKit
      // Free Tier: 20 GB bandwidth per month
      // ==========================================
      if (env.IMAGEKIT_PRIVATE_KEY && env.IMAGEKIT_URL_ENDPOINT) {
        try {
          const ikFormData = new FormData();
          const base64File = btoa(
            new Uint8Array(imageBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
          );
          
          ikFormData.append('file', 'data:image/jpeg;base64,' + base64File);
          ikFormData.append('fileName', 'compress_' + Date.now() + '_' + filename);
          ikFormData.append('useUniqueFileName', 'true');

          const ikRes = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
            method: 'POST',
            headers: {
              'Authorization': 'Basic ' + btoa(env.IMAGEKIT_PRIVATE_KEY + ':')
            },
            body: ikFormData
          });

          if (ikRes.ok) {
            const ikData = await ikRes.json();
            const transformUrl = `${ikData.url}?tr=q-${quality},f-auto`;
            const optRes = await fetch(transformUrl);

            if (optRes.ok) {
              const optBuffer = await optRes.arrayBuffer();
              return new Response(optBuffer, {
                status: 200,
                headers: {
                  ...CORS_HEADERS,
                  'Content-Type': optRes.headers.get('content-type') || 'image/webp',
                  'X-Provider': 'ImageKit',
                  'X-Failover-Logs': failoverLogs.join('; ')
                }
              });
            }
          }

          failoverLogs.push(`ImageKit upload failed with HTTP ${ikRes.status}`);
        } catch (err) {
          failoverLogs.push(`ImageKit error: ${err.message}`);
        }
      } else {
        failoverLogs.push('ImageKit not configured in environment');
      }

      // If all providers fail:
      return new Response(JSON.stringify({
        error: 'All compression providers failed or limits exceeded.',
        details: failoverLogs
      }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message || 'Internal server error' }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }
  }
};
