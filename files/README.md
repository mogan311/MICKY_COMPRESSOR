# Micky Compressor (Free-Tier Image Compressor & API)

A free-tier image compression website and API service featuring intelligent failover & key pooling:
1. **TinyPNG Key Pool (Rotates at 475 compressions per key):** Add as many free keys as you want! When Key 1 hits 475, it automatically switches to Key 2, Key 3, etc.
2. **ImageKit API (Fallback):** 20 GB free bandwidth every month with real-time WebP/AVIF transformations when all TinyPNG keys reach 475.
3. **In-Browser Canvas (Offline):** Unlimited offline compression fallback.

---

## 1. How to Add Multiple TinyPNG Keys (475 Limit Rotation)

You can generate multiple free TinyPNG keys using different emails at [tinify.com/dashboard/api](https://tinify.com/dashboard/api).

In your **Cloudflare Dashboard**:
1. Go to **Workers & Pages** &rarr; **`micky-compressor`** &rarr; **Settings** &rarr; **Variables and Secrets**.
2. Edit **`TINIFY_API_KEY`** (or add **`TINIFY_API_KEYS`**).
3. Paste your keys separated by commas:
   ```text
   key_1_abc123,key_2_def456,key_3_ghi789
   ```
4. Click **Deploy / Save**.

### How It Works:
* **Key 1:** Handles compressions `1` through `475`.
* **Key 2:** Once Key 1 hits 475, all requests immediately rotate to Key 2!
* **Key 3:** When Key 2 hits 475, it rotates to Key 3 (and so on).
* **ImageKit:** If all your TinyPNG keys reach 475, requests seamlessly fall over to ImageKit (20 GB bandwidth).
* **1st of Every Month:** At 00:00 UTC on the 1st of the month, TinyPNG resets all keys back to 0. The worker automatically starts from Key 1 again!

---

## 2. Calling from Client Websites

### Client JavaScript:
```javascript
async function compressImage(file) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('quality', '80');

  const response = await fetch('https://micky-compressor.moganjana711.workers.dev/api/compress', {
    method: 'POST',
    headers: {
      'x-api-key': 'micky_compressor_live_secret123'
    },
    body: formData
  });

  if (!response.ok) throw new Error('Compression failed');
  const compressedBlob = await response.blob();
  return compressedBlob;
}
```

### Response Headers:
* `X-Provider`: e.g. `TinyPNG (Key 1 of 2)` or `ImageKit (Fallback)`
* `X-Monthly-Tinify-Count`: Total compressions used on the active key this month
* `X-Remaining-Tinify`: Remaining images on this key before rotating (e.g. `475 - count`)
