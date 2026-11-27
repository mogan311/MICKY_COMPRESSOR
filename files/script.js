import { compressImage, getExtensionForMimeType, PRESETS } from './compress.js';

const $ = id => document.getElementById(id);
const CLOUD_KEY_STORAGE = 'micky_cloud_api_key_session';

const fmt = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(2) + ' MB';
const fmtTime = ms => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* -------------------------------------------------------------
   1. Optional Cloud API Drawer (Zero hardcoded secrets)
   ------------------------------------------------------------- */
let activeApiKey = sessionStorage.getItem(CLOUD_KEY_STORAGE) || '';
let keyVerified = false;

function openCloudDrawer() {
  $('cloudDrawer').classList.add('open');
  $('drawerBackdrop').classList.add('open');
  if (activeApiKey) {
    $('apiKeyInput').value = activeApiKey;
  }
}

function closeCloudDrawer() {
  $('cloudDrawer').classList.remove('open');
  $('drawerBackdrop').classList.remove('open');
}

$('cloudBtn').onclick = openCloudDrawer;
$('menuBtn').onclick = openCloudDrawer;
$('drawerCloseBtn').onclick = closeCloudDrawer;
$('drawerBackdrop').onclick = closeCloudDrawer;

function updateEngineIndicator() {
  const cloudEnabled = keyVerified && $('useCloudCheckbox').checked;
  const pill = $('enginePill');
  const pillText = $('enginePillText');
  if (cloudEnabled) {
    pill.classList.add('cloud-active');
    pillText.textContent = 'Cloud API Mode';
    $('cloudBtnLabel').textContent = 'Cloud Active';
  } else {
    pill.classList.remove('cloud-active');
    pillText.textContent = 'On-Device Engine';
    $('cloudBtnLabel').textContent = keyVerified ? 'Cloud Ready' : 'Cloud API';
  }
}

function showKeyMessage(text, isOk) {
  const el = $('apiKeyMsg');
  el.hidden = false;
  el.textContent = text;
  el.className = 'status-msg ' + (isOk ? 'ok' : 'err');
}

async function verifyAndLoadStatus(key) {
  if (!key) return false;
  try {
    const res = await fetch('/api/status', {
      headers: { 'x-api-key': key }
    });
    if (!res.ok) {
      keyVerified = false;
      $('useCloudCheckbox').checked = false;
      $('useCloudCheckbox').disabled = true;
      $('poolStatusBox').hidden = true;
      sessionStorage.removeItem(CLOUD_KEY_STORAGE);
      showKeyMessage(`Authorization failed (HTTP ${res.status}). Local mode active.`, false);
      updateEngineIndicator();
      return false;
    }
    const data = await res.json();
    keyVerified = true;
    activeApiKey = key;
    sessionStorage.setItem(CLOUD_KEY_STORAGE, key);
    $('useCloudCheckbox').disabled = false;
    $('poolStatusBox').hidden = false;

    if (data.tinify) {
      const t = data.tinify;
      $('tinypngUsageCount').textContent = `${t.totalUsedThisMonth} of ${t.totalCapacity} used (${data.month})`;
      const pct = t.totalCapacity ? Math.min(100, (t.totalUsedThisMonth / t.totalCapacity) * 100) : 0;
      $('tinypngMeterFill').style.width = pct + '%';
      $('tinypngStatusBadge').textContent = pct >= 100 ? 'Quota Full (ImageKit Fallback)' : `${t.totalKeys} Key(s) Active`;
      $('poolDetailsText').textContent =
        `TinyPNG rotates at ${t.perKeyLimit}/key. ImageKit fallback: ${data.imagekitConfigured ? 'Ready' : 'Not configured'}.`;
    }

    showKeyMessage('API key verified by Worker.', true);
    updateEngineIndicator();
    return true;
  } catch (err) {
    showKeyMessage(`Status check error: ${err.message}`, false);
    return false;
  }
}

$('apiKeyForm').onsubmit = async (e) => {
  e.preventDefault();
  const key = $('apiKeyInput').value.trim();
  if (!key) {
    showKeyMessage('Enter an API key first.', false);
    return;
  }
  await verifyAndLoadStatus(key);
};

$('clearKeyBtn').onclick = () => {
  activeApiKey = '';
  keyVerified = false;
  $('apiKeyInput').value = '';
  $('useCloudCheckbox').checked = false;
  $('useCloudCheckbox').disabled = true;
  $('poolStatusBox').hidden = true;
  $('apiKeyMsg').hidden = true;
  sessionStorage.removeItem(CLOUD_KEY_STORAGE);
  updateEngineIndicator();
};

$('useCloudCheckbox').onchange = updateEngineIndicator;

function incrementLocalUsage() {
  const m = new Date().toISOString().slice(0, 7);
  let lu = {};
  try { lu = JSON.parse(localStorage.getItem('micky_local_usage') || '{}'); } catch {}
  if (lu.m !== m) lu = { m, count: 0 };
  lu.count++;
  try { localStorage.setItem('micky_local_usage', JSON.stringify(lu)); } catch {}
  if ($('localCountLabel')) $('localCountLabel').textContent = `${lu.count} (${m})`;
}

function renderLocalUsage() {
  const m = new Date().toISOString().slice(0, 7);
  let lu = {};
  try { lu = JSON.parse(localStorage.getItem('micky_local_usage') || '{}'); } catch {}
  const count = lu.m === m ? (lu.count || 0) : 0;
  if ($('localCountLabel')) $('localCountLabel').textContent = `${count} (${m})`;
}

/* -------------------------------------------------------------
   2. Presets & Compression Controls
   ------------------------------------------------------------- */
let activePreset = 'upload-ready';

function setActivePresetButton(name) {
  activePreset = name;
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === name);
  });
}

$('presetUploadReady').onclick = () => {
  const p = PRESETS['upload-ready'];
  $('qRange').value = p.quality;
  $('qVal').textContent = p.quality + '%';
  $('maxEdge').value = p.maxEdge;
  $('fmtSel').value = p.format;
  $('maxKb').value = 0;
  setActivePresetButton('upload-ready');
};

$('presetOriginal').onclick = () => {
  $('maxEdge').value = 0;
  setActivePresetButton('original');
};

$('presetCustom').onclick = () => setActivePresetButton('custom');

['qRange', 'maxEdge', 'fmtSel', 'maxKb'].forEach(id => {
  $(id).addEventListener('input', () => {
    if (id === 'qRange') $('qVal').textContent = $('qRange').value + '%';
    setActivePresetButton('custom');
  });
});

function getOptions() {
  const maxKb = parseInt($('maxKb').value, 10) || 0;
  const opts = {
    quality: parseInt($('qRange').value, 10) || 80,
    maxEdge: Math.max(0, parseInt($('maxEdge').value, 10) || 0),
    format: $('fmtSel').value,
    maxOutputBytes: maxKb > 0 ? maxKb * 1024 : 0
  };
  if (activePreset === 'upload-ready' && maxKb === 0) {
    opts.preset = 'upload-ready';
  }
  return opts;
}

/* -------------------------------------------------------------
   3. Compression Execution (On-Device default, Explicit Cloud)
   ------------------------------------------------------------- */
async function readBlobDims(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const b = await createImageBitmap(blob);
      const dims = { width: b.width, height: b.height };
      b.close?.();
      return dims;
    } catch {}
  }
  return new Promise(resolve => {
    const img = new Image();
    const u = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(u);
      resolve({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
    };
    img.onerror = () => {
      URL.revokeObjectURL(u);
      resolve({ width: 0, height: 0 });
    };
    img.src = u;
  });
}

async function compressViaCloudAPI(file, opts) {
  const t0 = performance.now();
  const fd = new FormData();
  fd.append('file', file);
  fd.append('quality', String(opts.quality || 80));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 90000);

  try {
    const res = await fetch('/api/compress', {
      method: 'POST',
      headers: { 'x-api-key': activeApiKey },
      body: fd,
      signal: ac.signal
    });

    if (!res.ok) {
      let err = `Cloud error (HTTP ${res.status})`;
      try { const j = await res.json(); err = j.error || err; } catch {}
      throw new Error(err);
    }

    const provider = res.headers.get('X-Provider') || 'Cloud API';
    const blob = await res.blob();
    const mimeType = blob.type || res.headers.get('Content-Type') || 'image/jpeg';

    let width = parseInt(res.headers.get('X-Output-Width') || '0', 10);
    let height = parseInt(res.headers.get('X-Output-Height') || '0', 10);
    if (!width || !height) {
      const measured = await readBlobDims(blob);
      width = measured.width;
      height = measured.height;
    }

    const elapsedMs = Math.max(1, Math.round(performance.now() - t0));
    verifyAndLoadStatus(activeApiKey);
    return {
      blob,
      mimeType,
      width,
      height,
      inputBytes: file.size,
      outputBytes: blob.size,
      elapsedMs,
      provider
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runCompression(file, opts) {
  if (keyVerified && activeApiKey && $('useCloudCheckbox')?.checked) {
    return await compressViaCloudAPI(file, opts);
  }
  const res = await compressImage(file, opts);
  incrementLocalUsage();
  return { ...res, provider: 'On-Device Browser' };
}

/* -------------------------------------------------------------
   4. Sequential Queue, Cards, Memory Cleanup & Results UI
   ------------------------------------------------------------- */
const Q = [];
const activeObjectUrls = new Set();
const totals = { count: 0, failed: 0, origSize: 0, compSize: 0, batchElapsedMs: 0 };
let isProcessing = false;
let clearEpoch = 0;

function trackUrl(url) {
  activeObjectUrls.add(url);
  return url;
}

function releaseAllUrls() {
  for (const u of activeObjectUrls) {
    try { URL.revokeObjectURL(u); } catch {}
  }
  activeObjectUrls.clear();
}

function updateSummary(batchTotalMs = totals.batchElapsedMs) {
  const pct = totals.origSize ? Math.round((1 - totals.compSize / totals.origSize) * 100) : 0;
  const failNote = totals.failed > 0 ? ` (${totals.failed} failed)` : '';
  const timeNote = batchTotalMs > 0 ? ` • Batch time: ${fmtTime(batchTotalMs)}` : '';
  $('summaryText').textContent =
    `${totals.count} compressed${failNote}: ${fmt(totals.origSize)} → ${fmt(totals.compSize)}, saved ${pct}%${timeNote}`;
}

function createCardElement(file) {
  const beforeUrl = trackUrl(URL.createObjectURL(file));
  const card = document.createElement('div');
  card.className = 'image-card';
  card.innerHTML = `
    <div class="card-header">
      <div class="card-title" title="${esc(file.name)}">${esc(file.name)}</div>
      <span class="card-badge processing">Queued</span>
    </div>
    <div class="cmp">
      <img src="${beforeUrl}" alt="Before">
      <img class="aft" alt="After" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <span class="cmp-label" style="left:8px">Before</span>
      <span class="cmp-label" style="right:8px">After</span>
      <i class="hd"></i>
      <input type="range" min="0" max="100" value="50" aria-label="Compare before and after">
    </div>
    <div class="card-stats">
      <span>Before: <b>${fmt(file.size)}</b></span>
      <span class="after-size">After: <b>…</b></span>
    </div>
    <div class="card-metrics">
      <span class="card-dims">Dimensions: —</span>
      <span class="card-time">Time: —</span>
    </div>
    <div class="card-footer">
      <span class="saving-tag">…</span>
      <a class="btn-primary dl-btn" style="padding:6px 14px;font-size:13px" hidden>Download</a>
    </div>
    <div class="card-provider-note"></div>
  `;
  $('cardsGrid').prepend(card);
  return card;
}

// Yield briefly to keep UI responsive between heavy items
const nextTick = () => new Promise(r => setTimeout(r, 0));

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;
  const runEpoch = clearEpoch;
  const runStart = performance.now();

  try {
    while (Q.length > 0) {
      if (runEpoch !== clearEpoch) break;

      const { file, el, opts } = Q.shift();
      const badge = el.querySelector('.card-badge');
      const aftImg = el.querySelector('.aft');
      const aftSize = el.querySelector('.after-size b');
      const dimsEl = el.querySelector('.card-dims');
      const timeEl = el.querySelector('.card-time');
      const savingTag = el.querySelector('.saving-tag');
      const dlBtn = el.querySelector('.dl-btn');
      const note = el.querySelector('.card-provider-note');

      badge.textContent = 'Compressing…';
      await nextTick();
      if (runEpoch !== clearEpoch) break;

      try {
        const res = await runCompression(file, opts);
        if (runEpoch !== clearEpoch) break;

        const outUrl = trackUrl(URL.createObjectURL(res.blob));
        aftImg.src = outUrl;
        aftSize.textContent = fmt(res.outputBytes);

        const ext = getExtensionForMimeType(res.mimeType);
        dimsEl.textContent = `${res.width} × ${res.height} px • ${ext.toUpperCase()}`;
        timeEl.textContent = `Time: ${fmtTime(res.elapsedMs)}`;

        const diff = res.inputBytes - res.outputBytes;
        const savedPercent = res.inputBytes > 0 ? Math.round((diff / res.inputBytes) * 100) : 0;
        savingTag.textContent = savedPercent >= 0 ? `−${savedPercent}%` : `+${Math.abs(savedPercent)}%`;

        badge.className = 'card-badge done';
        badge.textContent = 'Ready';

        dlBtn.hidden = false;
        dlBtn.href = outUrl;
        dlBtn.download = file.name.replace(/\.[^.]+$/, '') + '-compressed.' + ext;

        note.textContent = `Engine: ${res.provider}`;

        totals.count++;
        totals.origSize += res.inputBytes;
        totals.compSize += res.outputBytes;
      } catch (err) {
        if (runEpoch !== clearEpoch) break;
        el.classList.add('card-error');
        badge.className = 'card-badge error';
        badge.textContent = 'Failed';
        aftSize.textContent = '—';
        dimsEl.textContent = 'Error';
        timeEl.textContent = '—';
        savingTag.textContent = '—';
        note.classList.add('error-text');
        note.textContent = err?.message || 'Failed to compress image.';
        totals.failed++;
      }

      if (runEpoch === clearEpoch) {
        updateSummary(totals.batchElapsedMs + (performance.now() - runStart));
      }
    }
  } finally {
    if (runEpoch === clearEpoch) {
      totals.batchElapsedMs += performance.now() - runStart;
      updateSummary(totals.batchElapsedMs);
    }
    isProcessing = false;
  }
}

function handleFiles(files) {
  const candidates = [...files].filter(
    f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|avif|gif|bmp)$/i.test(f.name)
  );
  if (!candidates.length) return;

  const optsSnapshot = getOptions();
  candidates.forEach(f => {
    const el = createCardElement(f);
    Q.push({ file: f, el, opts: optsSnapshot });
  });
  $('resultsSection').hidden = false;
  processQueue();
}

/* -------------------------------------------------------------
   5. Event Listeners
   ------------------------------------------------------------- */
$('selectBtn').onclick = (e) => { e.stopPropagation(); $('fileInput').click(); };
$('dropArea').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => {
  handleFiles(e.target.files);
  e.target.value = '';
};

const dropArea = $('dropArea');
['dragenter', 'dragover'].forEach(evt => {
  window.addEventListener(evt, (e) => {
    e.preventDefault();
    dropArea.classList.add('dropzone-overlay');
  });
});
['dragleave', 'drop'].forEach(evt => {
  window.addEventListener(evt, (e) => {
    e.preventDefault();
    dropArea.classList.remove('dropzone-overlay');
  });
});
window.addEventListener('drop', (e) => {
  if (e.dataTransfer && e.dataTransfer.files.length) {
    handleFiles(e.dataTransfer.files);
  }
});

$('downloadAllBtn').onclick = () => {
  const btns = document.querySelectorAll('.dl-btn:not([hidden])');
  btns.forEach((btn, idx) => {
    setTimeout(() => btn.click(), idx * 250);
  });
};

$('clearBtn').onclick = () => {
  clearEpoch++;
  Q.length = 0;
  // Clear DOM image sources before revoking URLs to let browser release decoded buffers immediately
  $('cardsGrid').querySelectorAll('img').forEach(img => { img.src = ''; });
  $('cardsGrid').innerHTML = '';
  releaseAllUrls();
  totals.count = 0;
  totals.failed = 0;
  totals.origSize = 0;
  totals.compSize = 0;
  totals.batchElapsedMs = 0;
  $('resultsSection').hidden = true;
};

$('cardsGrid').addEventListener('input', (e) => {
  if (e.target.matches('.cmp input')) {
    e.target.parentNode.style.setProperty('--p', e.target.value + '%');
  }
});

// Initialize UI
renderLocalUsage();
updateEngineIndicator();
if (activeApiKey) {
  verifyAndLoadStatus(activeApiKey);
}
