/**
 * Micky Compressor — Cloudflare Worker
 *
 * Routes:
 *   GET  /api/health   — Public liveness check (no secrets or usage data)
 *   GET  /api/status   — Authenticated pool status (requires x-api-key)
 *   POST /api/compress — Authenticated cloud compression (TinyPNG pool -> ImageKit fallback)
 *   *                  — Static frontend assets from ./files (env.ASSETS)
 *
 * Security:
 *   - All secrets live in Cloudflare Worker encrypted Secrets (never in repo/browser):
 *     CLIENT_API_KEYS, TINIFY_API_KEYS (or TINIFY_API_KEY), IMAGEKIT_PRIVATE_KEY, IMAGEKIT_URL_ENDPOINT
 *   - Optional env vars: CLOUD_MONTHLY_LIMIT, TINIFY_KEY_LIMIT, MAX_UPLOAD_BYTES
 *   - Optional KV binding: USAGE_KV (for persistent monthly counters across isolates)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Authorization',
  'Access-Control-Expose-Headers': [
    'X-Provider',
    'X-Monthly-Tinify-Count',
    'X-Remaining-Tinify',
    'X-Tinify-Key-Index',
    'X-Total-Tinify-Keys',
    'X-Failover-Logs',
    'X-Output-Width',
    'X-Output-Height',
    'X-Output-Format',
    'X-Temp-File-Deleted',
    'X-Privacy'
  ].join(', ')
};

const DEFAULT_KEY_LIMIT = 475;
const DEFAULT_MAX_UPLOAD_BYTES = 32 * 1024 * 1024; // 32 MB
const MAX_IMAGEKIT_BYTES = 25 * 1024 * 1024;       // 25 MB ImageKit upload cap

let memoryState = { month: '', keys: {}, totalCloudRequests: 0 };

function getCurrentMonth() {
  return new Date().toISOString().slice(0, 7);
}

async function loadUsageState(env) {
  const month = getCurrentMonth();
  if (env.USAGE_KV) {
    try {
      const raw = await env.USAGE_KV.get(`usage:${month}`, 'json');
      if (raw && raw.month === month) return raw;
    } catch { /* fall back to memory */ }
    return { month, keys: {}, totalCloudRequests: 0 };
  }
  if (memoryState.month !== month) {
    memoryState = { month, keys: {}, totalCloudRequests: 0 };
  }
  return memoryState;
}

async function saveUsageState(env, state) {
  if (env.USAGE_KV) {
    try {
      await env.USAGE_KV.put(`usage:${state.month}`, JSON.stringify(state), {
        expirationTtl: 60 * 60 * 24 * 45 // 45 days
      });
    } catch { /* ignore KV write failure */ }
  } else {
    memoryState = state;
  }
}

function jsonResp(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extraHeaders }
  });
}

/**
 * Constant-time UTF-8 string comparison to prevent timing side-channels.
 */
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ba.length, bb.length);
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ba[i] || 0) ^ (bb[i] || 0);
  }
  return diff === 0;
}

function getClientKey(request) {
  const headerKey = request.headers.get('x-api-key');
  if (headerKey) return headerKey.trim();
  const auth = request.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function isAuthorized(request, env) {
  const provided = getClientKey(request);
  if (!provided) return false;
  const allowed = (env.CLIENT_API_KEYS || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);
  if (allowed.length === 0) return false;

  let matched = false;
  for (const candidate of allowed) {
    if (timingSafeEqual(provided, candidate)) matched = true;
  }
  return matched;
}

function getTinyKeys(env) {
  const raw = env.TINIFY_API_KEYS || env.TINIFY_API_KEY || '';
  return raw.split(',').map(k => k.trim()).filter(Boolean);
}

/**
 * Inspect magic bytes of an image buffer.
 * Returns canonical MIME type or null if unrecognized/corrupt.
 */
function detectImageMime(buffer) {
  if (!buffer || buffer.byteLength < 12) return null;
  const h = new Uint8Array(buffer.slice(0, 16));

  // JPEG: FF D8 FF
  if (h[0] === 0xFF && h[1] === 0xD8 && h[2] === 0xFF) return 'image/jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4E && h[3] === 0x47 &&
    h[4] === 0x0D && h[5] === 0x0A && h[6] === 0x1A && h[7] === 0x0A
  ) return 'image/png';

  // GIF: GIF87a / GIF89a
  if (h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x38) return 'image/gif';

  // WebP: RIFF....WEBP
  if (
    h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 &&
    h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50
  ) return 'image/webp';

  // AVIF: ....ftyp(avif|avis|mif1)
  if (h[4] === 0x66 && h[5] === 0x74 && h[6] === 0x79 && h[7] === 0x70) {
    const brand = String.fromCharCode(h[8], h[9], h[10], h[11]);
    if (brand === 'avif' || brand === 'avis' || brand === 'mif1') return 'image/avif';
  }

  return null;
}

/**
 * Delete temporary file from ImageKit and confirm HTTP status.
 * Never claims deletion unless ImageKit explicitly confirms 200/204.
 */
async function deleteImageKitFile(fileId, privateKey) {
  if (!fileId || !privateKey) return { confirmed: false, error: 'Missing fileId or key' };
  try {
    const res = await fetch(`https://api.imagekit.io/v1/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      headers: { 'Authorization': 'Basic ' + btoa(privateKey + ':') },
      signal: AbortSignal.timeout(15000)
    });
    if (res.ok || res.status === 404) {
      return { confirmed: true, status: res.status };
    }
    return { confirmed: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { confirmed: false, error: err.message || 'Delete request failed' };
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // 1. Public liveness endpoint (zero secrets / counts)
    if (url.pathname === '/api/health' && (request.method === 'GET' || request.method === 'HEAD')) {
      return jsonResp({ status: 'online', service: 'Micky Compressor' });
    }

    // 2. Authenticated status endpoint
    if (url.pathname === '/api/status' && (request.method === 'GET' || request.method === 'HEAD')) {
      if (!isAuthorized(request, env)) {
        return jsonResp({ error: '401 Unauthorized: Valid x-api-key header required.' }, 401);
      }

      const usage = await loadUsageState(env);
      const tinyKeys = getTinyKeys(env);
      const keyLimit = parseInt(env.TINIFY_KEY_LIMIT || '', 10) || DEFAULT_KEY_LIMIT;
      const monthlyLimit = parseInt(env.CLOUD_MONTHLY_LIMIT || '', 10) || 0;
      const totalUsed = Object.values(usage.keys).reduce((a, b) => a + b, 0);

      return jsonResp({
        status: 'online',
        month: usage.month,
        totalCloudRequests: usage.totalCloudRequests,
        cloudMonthlyLimit: monthlyLimit || null,
        tinify: {
          configured: tinyKeys.length > 0,
          totalKeys: tinyKeys.length,
          perKeyLimit: keyLimit,
          totalCapacity: tinyKeys.length * keyLimit,
          totalUsedThisMonth: totalUsed,
          keys: tinyKeys.map((k, idx) => {
            const used = usage.keys[`k_${idx}`] || 0;
            return {
              index: idx + 1,
              keyPreview: k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : 'active',
              used,
              limit: keyLimit,
              isFull: used >= keyLimit
            };
          })
        },
        imagekitConfigured: Boolean(env.IMAGEKIT_PRIVATE_KEY && env.IMAGEKIT_URL_ENDPOINT)
      });
    }

    // 3. Static asset serving
    if (url.pathname !== '/api/compress' && url.pathname !== '/compress') {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return jsonResp({ error: 'Endpoint not found.' }, 404);
    }

    // 4. Compression endpoint (POST /api/compress)
    if (request.method !== 'POST') {
      return jsonResp({ error: 'Method not allowed. Use POST.' }, 405);
    }

    // 4a. Validate authorization FIRST
    if (!isAuthorized(request, env)) {
      return jsonResp({
        error: '401 Unauthorized: Valid x-api-key header required.'
      }, 401);
    }

    const usage = await loadUsageState(env);
    const tinyKeys = getTinyKeys(env);
    const keyLimit = parseInt(env.TINIFY_KEY_LIMIT || '', 10) || DEFAULT_KEY_LIMIT;
    const monthlyLimit = parseInt(env.CLOUD_MONTHLY_LIMIT || '', 10) || 0;
    const hasImageKit = Boolean(env.IMAGEKIT_PRIVATE_KEY && env.IMAGEKIT_URL_ENDPOINT);

    // 4b. Validate usage limits BEFORE reading heavy buffers or contacting providers
    if (monthlyLimit > 0 && usage.totalCloudRequests >= monthlyLimit) {
      return jsonResp({
        error: `Monthly cloud compression limit reached (${usage.totalCloudRequests}/${monthlyLimit}).`
      }, 429);
    }

    const allTinyFull = tinyKeys.every((_, idx) => (usage.keys[`k_${idx}`] || 0) >= keyLimit);
    if ((tinyKeys.length === 0 || allTinyFull) && !hasImageKit) {
      return jsonResp({
        error: 'Cloud usage limit reached: all TinyPNG keys are at capacity and no ImageKit fallback is configured.'
      }, 429);
    }

    // 4c. Check Content-Length header upfront if present
    const maxBytes = parseInt(env.MAX_UPLOAD_BYTES || '', 10) || DEFAULT_MAX_UPLOAD_BYTES;
    const declaredLen = parseInt(request.headers.get('content-length') || '0', 10);
    if (declaredLen > maxBytes + 65536) {
      return jsonResp({ error: `Payload too large. Max ${Math.round(maxBytes / 1048576)} MB.` }, 413);
    }

    try {
      const contentType = request.headers.get('content-type') || '';
      let imageBuffer;
      let filename = 'image.jpg';
      let quality = 80;

      if (contentType.includes('multipart/form-data')) {
        const fd = await request.formData();
        const file = fd.get('file') || fd.get('image');
        if (!file || typeof file === 'string') {
          return jsonResp({ error: 'Missing binary file in form data (field "file" or "image").' }, 400);
        }
        filename = file.name || 'image.jpg';
        imageBuffer = await file.arrayBuffer();
        if (fd.get('quality')) quality = parseInt(fd.get('quality'), 10) || 80;
      } else {
        imageBuffer = await request.arrayBuffer();
        if (url.searchParams.get('filename')) filename = url.searchParams.get('filename');
        if (url.searchParams.get('quality')) quality = parseInt(url.searchParams.get('quality'), 10) || 80;
      }

      quality = Math.min(100, Math.max(10, quality));

      // 4d. Validate payload size & magic bytes BEFORE contacting any provider
      if (!imageBuffer || imageBuffer.byteLength === 0) {
        return jsonResp({ error: 'Empty image payload.' }, 400);
      }
      if (imageBuffer.byteLength > maxBytes) {
        return jsonResp({
          error: `File too large (${imageBuffer.byteLength} bytes). Maximum allowed is ${maxBytes} bytes.`
        }, 413);
      }

      const detectedMime = detectImageMime(imageBuffer);
      if (!detectedMime) {
        return jsonResp({
          error: 'Invalid or unsupported file contents. Expected JPEG, PNG, WebP, GIF, or AVIF image.'
        }, 415);
      }

      const failoverLogs = [];

      // ── STEP 1: TinyPNG key pool (supports JPEG, PNG, WebP, AVIF — skip GIF) ─
      if (detectedMime !== 'image/gif') {
        for (let i = 0; i < tinyKeys.length; i++) {
          const key = tinyKeys[i];
          const slot = `k_${i}`;
          const knownCount = usage.keys[slot] || 0;

          if (knownCount >= keyLimit) {
            failoverLogs.push(`TinyPNG Key #${i + 1}: limit reached (${knownCount}/${keyLimit})`);
            continue;
          }

          try {
            const shrinkRes = await fetch('https://api.tinify.com/shrink', {
              method: 'POST',
              headers: { 'Authorization': 'Basic ' + btoa('api:' + key) },
              body: imageBuffer,
              signal: AbortSignal.timeout(60000)
            });

            const countHeader = shrinkRes.headers.get('Compression-Count');
            const count = countHeader ? parseInt(countHeader, 10) : (knownCount + 1);
            usage.keys[slot] = count;

            if (shrinkRes.status === 429 || shrinkRes.status === 402) {
              usage.keys[slot] = keyLimit;
              await saveUsageState(env, usage);
              failoverLogs.push(`TinyPNG Key #${i + 1}: quota reached (${shrinkRes.status})`);
              continue;
            }

            if (!shrinkRes.ok) {
              failoverLogs.push(`TinyPNG Key #${i + 1}: HTTP ${shrinkRes.status}`);
              continue;
            }

            const tinyData = await shrinkRes.json();
            if (!tinyData?.output?.url) {
              failoverLogs.push(`TinyPNG Key #${i + 1}: missing output URL`);
              continue;
            }

            const dlRes = await fetch(tinyData.output.url, {
              headers: { 'Authorization': 'Basic ' + btoa('api:' + key) },
              signal: AbortSignal.timeout(60000)
            });

            if (!dlRes.ok) {
              failoverLogs.push(`TinyPNG Key #${i + 1}: download failed (HTTP ${dlRes.status})`);
              continue;
            }

            usage.totalCloudRequests++;
            await saveUsageState(env, usage);

            const outType = tinyData.output.type || detectedMime;
            const remaining = Math.max(0, keyLimit - count);
            return new Response(dlRes.body, {
              status: 200,
              headers: {
                ...CORS_HEADERS,
                'Content-Type': outType,
                'X-Provider': `TinyPNG (Key ${i + 1} of ${tinyKeys.length})`,
                'X-Monthly-Tinify-Count': String(count),
                'X-Remaining-Tinify': String(remaining),
                'X-Tinify-Key-Index': String(i + 1),
                'X-Total-Tinify-Keys': String(tinyKeys.length),
                'X-Output-Width': String(tinyData.output.width || 0),
                'X-Output-Height': String(tinyData.output.height || 0),
                'X-Output-Format': outType
              }
            });
          } catch (err) {
            failoverLogs.push(`TinyPNG Key #${i + 1}: ${err.message}`);
          }
        }
      } else {
        failoverLogs.push('TinyPNG skipped for GIF input');
      }

      if (tinyKeys.length === 0) {
        failoverLogs.push('No TinyPNG keys configured');
      }

      // ── STEP 2: ImageKit fallback with confirmed cleanup on success & failure ─
      if (hasImageKit) {
        if (imageBuffer.byteLength > MAX_IMAGEKIT_BYTES) {
          failoverLogs.push(`ImageKit skipped: file exceeds ${MAX_IMAGEKIT_BYTES} byte upload cap`);
        } else {
          let ikFileId = null;
          let cleanupResult = null;
          try {
            const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'image';
            const ikForm = new FormData();
            ikForm.append('file', new Blob([imageBuffer], { type: detectedMime }), safeName);
            ikForm.append('fileName', `mc_${Date.now()}_${safeName}`);
            ikForm.append('useUniqueFileName', 'true');

            const ikUpload = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
              method: 'POST',
              headers: { 'Authorization': 'Basic ' + btoa(env.IMAGEKIT_PRIVATE_KEY + ':') },
              body: ikForm,
              signal: AbortSignal.timeout(90000)
            });

            if (!ikUpload.ok) {
              failoverLogs.push(`ImageKit upload failed: HTTP ${ikUpload.status}`);
            } else {
              const ikData = await ikUpload.json();
              ikFileId = ikData.fileId || null;

              const transformUrl = `${ikData.url}?tr=q-${quality},f-auto`;
              const optRes = await fetch(transformUrl, { signal: AbortSignal.timeout(60000) });

              if (!optRes.ok) {
                failoverLogs.push(`ImageKit transform failed: HTTP ${optRes.status}`);
              } else {
                const optBuffer = await optRes.arrayBuffer();
                const outType = optRes.headers.get('content-type') || 'image/webp';

                if (ikFileId) {
                  cleanupResult = await deleteImageKitFile(ikFileId, env.IMAGEKIT_PRIVATE_KEY);
                  ikFileId = null; // cleanup already attempted and captured
                }

                usage.totalCloudRequests++;
                await saveUsageState(env, usage);

                const deletedConfirmed = Boolean(cleanupResult?.confirmed);
                if (!deletedConfirmed) {
                  failoverLogs.push(`ImageKit cleanup failed: ${cleanupResult?.error || 'unconfirmed'}`);
                }

                return new Response(optBuffer, {
                  status: 200,
                  headers: {
                    ...CORS_HEADERS,
                    'Content-Type': outType,
                    'X-Provider': 'ImageKit (Fallback)',
                    'X-Output-Format': outType,
                    'X-Temp-File-Deleted': deletedConfirmed ? 'true' : 'false',
                    'X-Privacy': deletedConfirmed
                      ? 'Confirmed: temporary ImageKit file deleted'
                      : 'Warning: temporary ImageKit file deletion could not be confirmed',
                    'X-Failover-Logs': failoverLogs.join('; ')
                  }
                });
              }
            }
          } catch (err) {
            failoverLogs.push(`ImageKit error: ${err.message}`);
          } finally {
            // Ensure cleanup also runs and is awaited on failure after upload
            if (ikFileId) {
              cleanupResult = await deleteImageKitFile(ikFileId, env.IMAGEKIT_PRIVATE_KEY);
              failoverLogs.push(
                cleanupResult.confirmed
                  ? 'ImageKit temporary file deleted after failure'
                  : `ImageKit cleanup after failure failed: ${cleanupResult.error}`
              );
            }
          }
        }
      } else {
        failoverLogs.push('ImageKit not configured');
      }

      return jsonResp({
        error: 'Cloud compression failed across all configured providers.',
        details: failoverLogs
      }, 502);
    } catch (e) {
      return jsonResp({ error: e.message || 'Internal server error' }, 500);
    }
  }
};
