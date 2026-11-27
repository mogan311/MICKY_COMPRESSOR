/**
 * compress.js — Standalone browser image compression module.
 * Zero DOM-UI dependencies, zero login/provider coupling, zero external network requests.
 *
 * Exports:
 *   compressImage(file, options) -> Promise<{
 *     blob, mimeType, width, height, inputBytes, outputBytes, elapsedMs
 *   }>
 *   getExtensionForMimeType(mimeType) -> string
 *   PRESETS, LIMITS
 */

export const PRESETS = Object.freeze({
  'upload-ready': Object.freeze({ maxEdge: 1600, format: 'image/webp', quality: 80 }),
  'original':     Object.freeze({ maxEdge: 0, maxWidth: 0, maxHeight: 0, format: 'keep', quality: 85 })
});

export const LIMITS = Object.freeze({
  MAX_INPUT_EDGE: 16384,
  MAX_INPUT_PIXELS: 120_000_000,
  MIN_QUALITY: 25,
  MIN_DIMENSION_SCALE: 0.35,
  MIN_DIMENSION_PX: 64
});

const MIME_TO_EXT = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/avif': 'avif',
  'image/gif':  'gif'
};

/**
 * Derive a clean file extension from an actual MIME type.
 * @param {string} mimeType
 * @returns {string}
 */
export function getExtensionForMimeType(mimeType) {
  const clean = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return MIME_TO_EXT[clean] || 'bin';
}

/**
 * Decode an image File/Blob off-main-thread when possible (createImageBitmap),
 * falling back to HTMLImageElement. Respects EXIF orientation.
 */
async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      if (bmp.width > 0 && bmp.height > 0) {
        return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close?.() };
      }
      bmp.close?.();
    } catch {
      // Fall through to HTMLImageElement fallback (handles edge formats like some SVGs/GIFs)
    }
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (!w || !h) {
        reject(new Error('Image decoded with zero dimensions.'));
        return;
      }
      resolve({ source: img, width: w, height: h, release: () => { img.src = ''; } });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Unsupported or corrupt image file.'));
    };
    img.src = url;
  });
}

function createCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(w, h);
  }
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return cv;
}

function freeCanvas(cv) {
  if (!cv) return;
  cv.width = 0;
  cv.height = 0;
}

async function canvasToBlob(cv, mimeType, quality01) {
  if (typeof cv.convertToBlob === 'function') {
    return cv.convertToBlob({ type: mimeType, quality: quality01 });
  }
  return new Promise((resolve, reject) => {
    cv.toBlob(
      b => (b ? resolve(b) : reject(new Error(`Canvas failed to encode ${mimeType}.`))),
      mimeType,
      quality01
    );
  });
}

/**
 * Draw source into a fresh canvas at (targetW, targetH) using appropriate smoothing.
 */
function drawScaled(source, srcW, srcH, targetW, targetH, mimeType) {
  const cv = createCanvas(targetW, targetH);
  const ctx = cv.getContext('2d');
  if (!ctx) {
    freeCanvas(cv);
    throw new Error('Could not acquire 2D canvas context.');
  }
  if (mimeType === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetW, targetH);
  }
  if (targetW !== srcW || targetH !== srcH) {
    ctx.imageSmoothingEnabled = true;
    const ratio = Math.max(srcW / targetW, srcH / targetH);
    ctx.imageSmoothingQuality = ratio > 3 ? 'medium' : 'high';
  }
  ctx.drawImage(source, 0, 0, targetW, targetH);
  return cv;
}

/**
 * Compute target dimensions while preserving aspect ratio and never enlarging.
 * Supports maxEdge (longest side), maxWidth, and maxHeight.
 */
function computeTargetDims(srcW, srcH, { maxEdge = 0, maxWidth = 0, maxHeight = 0 }) {
  let scale = 1;
  const longest = Math.max(srcW, srcH);
  if (maxEdge > 0 && longest > maxEdge) {
    scale = Math.min(scale, maxEdge / longest);
  }
  if (maxWidth > 0 && srcW > maxWidth) {
    scale = Math.min(scale, maxWidth / srcW);
  }
  if (maxHeight > 0 && srcH > maxHeight) {
    scale = Math.min(scale, maxHeight / srcH);
  }
  if (scale >= 1) return { w: srcW, h: srcH };
  return {
    w: Math.max(1, Math.round(srcW * scale)),
    h: Math.max(1, Math.round(srcH * scale))
  };
}

/**
 * Resolve target canvas MIME type.
 * 'keep' keeps JPEG/PNG/WebP when supported; falls back to image/webp for AVIF/GIF/unknown.
 */
function resolveOutputMime(requestedFormat, inputMime) {
  if (!requestedFormat || requestedFormat === 'keep') {
    if (/^image\/(webp|jpeg|png)$/i.test(inputMime || '')) {
      return inputMime.toLowerCase();
    }
    return 'image/webp';
  }
  const clean = String(requestedFormat).toLowerCase();
  if (/^image\/(webp|jpeg|png)$/.test(clean)) return clean;
  return 'image/webp';
}

/**
 * Compress a File or Blob in the browser.
 *
 * @param {File|Blob} file
 * @param {object} [options]
 * @param {'upload-ready'|'original'} [options.preset]
 * @param {number} [options.quality=80]            1..100
 * @param {'image/webp'|'image/jpeg'|'image/png'|'keep'} [options.format='image/webp']
 * @param {number} [options.maxEdge=0]             Longest-edge limit in px (0 = original)
 * @param {number} [options.maxWidth=0]            Optional max width in px (0 = unlimited)
 * @param {number} [options.maxHeight=0]           Optional max height in px (0 = unlimited)
 * @param {number} [options.maxOutputBytes=0]      Hard output ceiling in bytes (0 = disabled)
 * @param {number} [options.minQuality=25]         Minimum quality floor for maxOutputBytes reduction
 * @param {number} [options.minDimensionScale=0.35] Minimum scale floor relative to initial target dims
 * @returns {Promise<{
 *   blob: Blob, mimeType: string, width: number, height: number,
 *   inputBytes: number, outputBytes: number, elapsedMs: number
 * }>}
 */
export async function compressImage(file, options = {}) {
  const t0 = performance.now();

  if (!file || typeof file.size !== 'number' || typeof file.arrayBuffer !== 'function') {
    throw new TypeError('compressImage: first argument must be a File or Blob.');
  }
  if (file.size === 0) {
    throw new Error('Image file is empty (0 bytes).');
  }

  const presetDefaults = options.preset ? (PRESETS[options.preset] || {}) : {};
  const opts = {
    quality: 80,
    format: 'image/webp',
    maxEdge: 0,
    maxWidth: 0,
    maxHeight: 0,
    maxOutputBytes: 0,
    minQuality: LIMITS.MIN_QUALITY,
    minDimensionScale: LIMITS.MIN_DIMENSION_SCALE,
    ...presetDefaults,
    ...options
  };

  // Backwards-friendly: if caller only set maxWidth expecting longest-edge cap?
  // No, keep explicit semantics: maxEdge caps longest edge, maxWidth caps width, maxHeight caps height.
  const initialQuality = Math.min(100, Math.max(1, Math.round(Number(opts.quality) || 80)));
  const minQuality = Math.min(initialQuality, Math.max(10, Math.round(Number(opts.minQuality) || LIMITS.MIN_QUALITY)));
  const maxOutputBytes = Math.max(0, Number(opts.maxOutputBytes) || 0);
  const minScale = Math.min(1, Math.max(0.1, Number(opts.minDimensionScale) || LIMITS.MIN_DIMENSION_SCALE));

  const decoded = await decodeImage(file);
  let activeCanvas = null;

  try {
    const { width: srcW, height: srcH } = decoded;

    if (
      srcW > LIMITS.MAX_INPUT_EDGE ||
      srcH > LIMITS.MAX_INPUT_EDGE ||
      srcW * srcH > LIMITS.MAX_INPUT_PIXELS
    ) {
      throw new Error(
        `Image dimensions (${srcW}×${srcH}) exceed safe browser limits ` +
        `(${LIMITS.MAX_INPUT_EDGE}px side / ${(LIMITS.MAX_INPUT_PIXELS / 1e6).toFixed(0)}MP).`
      );
    }

    const mimeType = resolveOutputMime(opts.format, file.type);
    const initialDims = computeTargetDims(srcW, srcH, opts);
    let w = initialDims.w;
    let h = initialDims.h;
    let quality = initialQuality;

    // Draw once into target canvas; release decoded source immediately if no further resizing is possible
    activeCanvas = drawScaled(decoded.source, srcW, srcH, w, h, mimeType);
    if (!maxOutputBytes) {
      decoded.release();
    }

    let blob = await canvasToBlob(activeCanvas, mimeType, quality / 100);
    let actualMime = blob.type || mimeType;

    // Enforce maxOutputBytes if requested
    if (maxOutputBytes > 0 && blob.size > maxOutputBytes) {
      // Phase 1: Binary search quality down to minQuality (only for lossy formats; Canvas PNG ignores quality)
      if (actualMime !== 'image/png' && quality > minQuality) {
        let low = minQuality;
        let high = quality - 1;
        let bestFittingBlob = null;
        let bestFittingQuality = low;

        // First test the floor to see if quality reduction alone can meet the target
        const minQBlob = await canvasToBlob(activeCanvas, actualMime, low / 100);
        if (minQBlob.size <= maxOutputBytes) {
          bestFittingBlob = minQBlob;
          bestFittingQuality = low;
          while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            if (mid === bestFittingQuality) {
              low = mid + 1;
              continue;
            }
            const probe = await canvasToBlob(activeCanvas, actualMime, mid / 100);
            if (probe.size <= maxOutputBytes) {
              bestFittingBlob = probe;
              bestFittingQuality = mid;
              low = mid + 1;
            } else {
              high = mid - 1;
            }
          }
          blob = bestFittingBlob;
          quality = bestFittingQuality;
        } else {
          // Even minQuality didn't fit; adopt minQuality before Phase 2 scaling
          blob = minQBlob;
          quality = minQuality;
        }
      }

      // Phase 2: Progressively scale dimensions down within documented limits
      if (blob.size > maxOutputBytes) {
        const minW = Math.min(w, Math.max(LIMITS.MIN_DIMENSION_PX, Math.round(initialDims.w * minScale)));
        const minH = Math.min(h, Math.max(LIMITS.MIN_DIMENSION_PX, Math.round(initialDims.h * minScale)));

        const factors = [0.85, 0.72, 0.6, 0.48, minScale];
        for (const f of factors) {
          if (f < minScale - 0.001) continue;
          const nw = Math.max(minW, Math.round(initialDims.w * f));
          const nh = Math.max(minH, Math.round(initialDims.h * f));
          if (nw >= w && nh >= h) continue;

          freeCanvas(activeCanvas);
          activeCanvas = drawScaled(decoded.source, srcW, srcH, nw, nh, actualMime);
          w = nw;
          h = nh;
          blob = await canvasToBlob(activeCanvas, actualMime, quality / 100);
          actualMime = blob.type || actualMime;

          if (blob.size <= maxOutputBytes) break;
          if (nw <= minW && nh <= minH) break;
        }
      }

      if (blob.size > maxOutputBytes) {
        throw new Error(
          `Cannot compress below ${maxOutputBytes} bytes within quality (${minQuality}%) ` +
          `and dimension (${Math.round(minScale * 100)}%) limits. Best achieved: ${blob.size} bytes (${w}×${h}).`
        );
      }
    }

    // Keep original ONLY if it satisfies EVERY requested constraint
    const inputMime = (file.type || '').toLowerCase();
    const sameFormat = inputMime && actualMime === inputMime;
    const sameDims = w === srcW && h === srcH;
    const fitsMaxBytes = !maxOutputBytes || file.size <= maxOutputBytes;

    let finalBlob = blob;
    let finalMime = actualMime;
    let finalW = w;
    let finalH = h;

    if (blob.size >= file.size && sameFormat && sameDims && fitsMaxBytes) {
      finalBlob = file;
      finalMime = inputMime;
      finalW = srcW;
      finalH = srcH;
    }

    const elapsedMs = Math.max(1, Math.round(performance.now() - t0));
    return {
      blob: finalBlob,
      mimeType: finalMime,
      width: finalW,
      height: finalH,
      inputBytes: file.size,
      outputBytes: finalBlob.size,
      elapsedMs
    };
  } finally {
    decoded.release();
    freeCanvas(activeCanvas);
  }
}
