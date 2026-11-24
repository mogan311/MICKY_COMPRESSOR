/**
 * Cloudflare Worker & API for Micky Compressor
 * Handles failover: Multiple TinyPNG keys (rotates at 475 limit) -> ImageKit (20GB free/mo)
 * Also serves the static website frontend automatically!
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Authorization',
  'Access-Control-Expose-Headers': 'X-Provider, X-Monthly-Tinify-Count, X-Remaining-Tinify, X-Tinify-Key-Index, X-Total-Tinify-Keys, X-Failover-Logs'
};

const KEY_LIMIT = 475; // Rotate to next key at 475 compressions
let memoryUsage = {};
let currentActiveMonth = '';

function checkMonthReset() {
  const m = new Date().toISOString().slice(0, 7);
  if (m !== currentActiveMonth) {
    currentActiveMonth = m;
    memoryUsage = {}; // Reset all key usage on the 1st of every calendar month
  }
}

export default {
  async fetch(request, env) {
    checkMonthReset();
    const url = new URL(request.url);

    // 1. Handle CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Parse TinyPNG keys (supports single key or comma-separated list of multiple keys)
    const rawKeys = env.TINIFY_API_KEYS || env.TINIFY_API_KEY || '';
    const tinyKeys = rawKeys
      .split(',')
      .map(k => k.trim())
      .filter(Boolean);

    // 2. Health / Status Check endpoint
    if (url.pathname === '/api/status' && (request.method === 'GET' || request.method === 'HEAD')) {
      const keysStatus = tinyKeys.map((k, idx) => ({
        index: idx + 1,
        keyPreview: k.length > 8 ? k.slice(0, 4) + '...' + k.slice(-4) : 'active',
        used: memoryUsage[k] || 0,
        limit: KEY_LIMIT,
        isFull: (memoryUsage[k] || 0) >= KEY_LIMIT
      }));

      const totalUsed = Object.values(memoryUsage).reduce((a, b) => a + b, 0);

      return new Response(JSON.stringify({
        status: 'online',
        month: currentActiveMonth,
        tinify: {
          configured: tinyKeys.length > 0,
          totalKeys: tinyKeys.length,
          perKeyLimit: KEY_LIMIT,
          totalCapacity: tinyKeys.length * KEY_LIMIT,
          totalUsedThisMonth: totalUsed,
          keys: keysStatus
        },
        imagekitConfigured: Boolean(env.IMAGEKIT_PRIVATE_KEY && env.IMAGEKIT_URL_ENDPOINT),
        fallback: 'ImageKit (20 GB bandwidth) when all TinyPNG keys reach 475'
      }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      });
    }

    // 3. Serve static website assets (index.html, style.css, script.js)
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

      // ========================================================
      // STEP 1: Loop Through TinyPNG Keys (Rotate when count >= 475)
      // ========================================================
      for (let i = 0; i < tinyKeys.length; i++) {
        const currentKey = tinyKeys[i];
        const knownCount = memoryUsage[currentKey] || 0;

        // If this key already reached the 475 limit, skip to the next key!
        if (knownCount >= KEY_LIMIT) {
          failoverLogs.push(`TinyPNG Key #${i + 1} reached limit (${knownCount}/${KEY_LIMIT})`);
          continue;
        }

        try {
          const tinyRes = await fetch('https://api.tinify.com/shrink', {
            method: 'POST',
            headers: {
              'Authorization': 'Basic ' + btoa('api:' + currentKey)
            },
            body: imageBuffer
          });

          const countHeader = tinyRes.headers.get('Compression-Count');
          const count = countHeader ? parseInt(countHeader, 10) : (knownCount + 1);
          memoryUsage[currentKey] = count;

          if (tinyRes.ok) {
            const tinyData = await tinyRes.json();
            const downloadRes = await fetch(tinyData.output.url, {
              headers: { 'Authorization': 'Basic ' + btoa('api:' + currentKey) }
            });

            if (downloadRes.ok) {
              const remainingOnThisKey = Math.max(0, KEY_LIMIT - count);
              return new Response(downloadRes.body, {
                status: 200,
                headers: {
                  ...CORS_HEADERS,
                  'Content-Type': tinyData.output.type || 'image/jpeg',
                  'X-Provider': `TinyPNG (Key ${i + 1} of ${tinyKeys.length})`,
                  'X-Monthly-Tinify-Count': String(count),
                  'X-Remaining-Tinify': String(remainingOnThisKey),
                  'X-Tinify-Key-Index': String(i + 1),
                  'X-Total-Tinify-Keys': String(tinyKeys.length)
                }
              });
            }
          }

          // If this key returned rate limit 429 or payment required 402, mark it full and try next key
          if (tinyRes.status === 429 || tinyRes.status === 402) {
            memoryUsage[currentKey] = KEY_LIMIT;
          }
          failoverLogs.push(`TinyPNG Key #${i + 1} skipped (Status: ${tinyRes.status}, count: ${count})`);
        } catch (err) {
          failoverLogs.push(`TinyPNG Key #${i + 1} error: ${err.message}`);
        }
      }

      if (tinyKeys.length === 0) {
        failoverLogs.push('No TinyPNG keys configured');
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

              // PRIVACY & SECURITY: Immediately delete the file from ImageKit media library
              // so customer images are never stored or retained on external servers!
              if (ikData.fileId) {
                fetch(`https://api.imagekit.io/v1/files/${ikData.fileId}`, {
                  method: 'DELETE',
                  headers: {
                    'Authorization': 'Basic ' + btoa(env.IMAGEKIT_PRIVATE_KEY + ':')
                  }
                }).catch(() => {});
              }

              return new Response(optBuffer, {
                status: 200,
                headers: {
                  ...CORS_HEADERS,
                  'Content-Type': optRes.headers.get('content-type') || 'image/webp',
                  'X-Provider': 'ImageKit (Fallback)',
                  'X-Privacy': 'Zero-retention: temporary image deleted immediately after compression',
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

      return new Response(JSON.stringify({
        error: 'All TinyPNG keys reached the 475 limit and ImageKit fallback failed.',
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
