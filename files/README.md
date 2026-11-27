# Micky Compressor

Private on-device browser image compression studio with an optional Cloudflare Worker Cloud API (`TinyPNG` key pool -> `ImageKit` zero-retention fallback).

---

## 1. Reusable Browser Module (`files/compress.js`)

Any website can import `compress.js` directly without loading Micky Compressor UI, login, or provider credentials.

```javascript
import { compressImage, getExtensionForMimeType } from './compress.js';

const result = await compressImage(file, {
  preset: 'upload-ready', // 1600px longest edge, WebP, 80% quality
  // maxOutputBytes: 400 * 1024 // optional hard byte ceiling
});
// Returns: { blob, mimeType, width, height, inputBytes, outputBytes, elapsedMs }
```

See [compress-example.js](./compress-example.js) for a complete `FormData` upload integration example.

### Documented Limits (`LIMITS`)
- `MAX_INPUT_EDGE`: `16384` px
- `MAX_INPUT_PIXELS`: `120,000,000` (120 MP)
- `MIN_QUALITY`: `25` (minimum quality floor during `maxOutputBytes` reduction)
- `MIN_DIMENSION_SCALE`: `0.35` (35% scale floor of initial target dimensions during `maxOutputBytes` reduction)
- `MIN_DIMENSION_PX`: `64` px

---

## 2. Cloudflare Worker Setup

Active deployment uses `wrangler.jsonc` (`main: "worker.js"`, `assets.directory: "./files"`).

### Required Secrets (Cloudflare Dashboard or Wrangler CLI)
Never place secrets in `wrangler.jsonc` or frontend files. Set them as encrypted Cloudflare Worker Secrets:

```bash
# Client API keys (comma-separated) required in x-api-key header
npx wrangler secret put CLIENT_API_KEYS

# TinyPNG API keys (comma-separated, auto-rotates at 475/key/month)
npx wrangler secret put TINIFY_API_KEYS

# ImageKit fallback credentials (zero-retention: deleted immediately after compression)
npx wrangler secret put IMAGEKIT_PRIVATE_KEY
npx wrangler secret put IMAGEKIT_URL_ENDPOINT
```

Optional non-secret environment variables (`wrangler.jsonc` `vars` or Dashboard):
- `TINIFY_KEY_LIMIT`: default `475`
- `CLOUD_MONTHLY_LIMIT`: optional monthly total cloud request cap
- `MAX_UPLOAD_BYTES`: default `33554432` (32 MB)

Deploy:
```bash
npx wrangler deploy
```
(Or push to `master` if connected to Cloudflare Workers Git integration.)
