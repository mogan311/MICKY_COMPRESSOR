/**
 * compress-example.js
 * Standalone example showing how any website can import compress.js,
 * compress a user-selected image with the "Ready for upload" preset,
 * and append the compressed Blob to FormData without loading Micky Compressor UI.
 */

import { compressImage, getExtensionForMimeType } from './compress.js';

/**
 * Compress a selected File using the "Ready for upload" preset
 * (1,600px longest edge, WebP, 80% quality) and append it to FormData.
 *
 * @param {File} file
 * @param {string} uploadUrl
 */
export async function compressAndUpload(file, uploadUrl) {
  const result = await compressImage(file, {
    preset: 'upload-ready',
    // Optional hard size cap in bytes (uncomment if needed):
    // maxOutputBytes: 500 * 1024
  });

  const ext = getExtensionForMimeType(result.mimeType);
  const uploadName = file.name.replace(/\.[^.]+$/, '') + '.' + ext;

  const formData = new FormData();
  formData.append('file', result.blob, uploadName);
  formData.append('width', String(result.width));
  formData.append('height', String(result.height));
  formData.append('mimeType', result.mimeType);

  const response = await fetch(uploadUrl, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    throw new Error(`Upload failed with HTTP ${response.status}`);
  }
  return result;
}
