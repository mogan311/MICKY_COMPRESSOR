const $ = id => document.getElementById(id);
const ADMIN_SESSION_KEY = 'micky_admin_session';
const DEFAULT_CLIENT_KEY = 'micky_compressor_live_secret123';
const EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/avif': 'avif', 'image/gif': 'gif' };

// Utility formatting
const fmt = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(2) + ' MB';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* -------------------------------------------------------------
   1. Authentication & Admin Drawer
   ------------------------------------------------------------- */
function isAdmin() {
  return localStorage.getItem(ADMIN_SESSION_KEY) === 'micky_auth_kpp_verified';
}

function updateAuthUI() {
  const adminLoggedIn = isAdmin();
  if (adminLoggedIn) {
    $('adminBtnLabel').textContent = 'Admin Panel';
    $('adminBtn').style.borderColor = 'var(--primary)';
    $('adminBtn').style.color = 'var(--primary)';
    fetchAdminStatus();
  } else {
    $('adminBtnLabel').textContent = 'Admin Login';
    $('adminBtn').style.borderColor = '';
    $('adminBtn').style.color = '';
  }
}

function openAdmin() {
  if (isAdmin()) {
    $('adminDrawer').classList.add('open');
    $('drawerBackdrop').classList.add('open');
    fetchAdminStatus();
  } else {
    $('loginModal').showModal();
    $('loginErr').style.display = 'none';
  }
}

function closeAdminDrawer() {
  $('adminDrawer').classList.remove('open');
  $('drawerBackdrop').classList.remove('open');
}

// Admin Button and Hamburger Triggers
$('adminBtn').onclick = openAdmin;
$('menuBtn').onclick = openAdmin;
$('drawerCloseBtn').onclick = closeAdminDrawer;
$('drawerBackdrop').onclick = closeAdminDrawer;
$('loginCancelBtn').onclick = () => $('loginModal').close();

// Login Form Submit (kpp / Kpp@2001.)
$('loginForm').onsubmit = (e) => {
  e.preventDefault();
  const u = $('uname').value.trim();
  const p = $('pword').value;

  if (u === 'kpp' && p === 'Kpp@2001.') {
    localStorage.setItem(ADMIN_SESSION_KEY, 'micky_auth_kpp_verified');
    $('loginModal').close();
    updateAuthUI();
    openAdmin();
  } else {
    $('loginErr').textContent = 'Invalid username or password';
    $('loginErr').style.display = 'block';
  }
};

// Logout Handler
$('logoutBtn').onclick = () => {
  localStorage.removeItem(ADMIN_SESSION_KEY);
  closeAdminDrawer();
  updateAuthUI();
};

// 1-Click Copy Client API Key
$('copyKeyBtn').onclick = async () => {
  const k = $('clientApiKey').textContent;
  try {
    await navigator.clipboard.writeText(k);
    $('copyKeyBtn').textContent = 'Copied!';
    setTimeout(() => $('copyKeyBtn').textContent = 'Copy', 1800);
  } catch {
    $('copyKeyBtn').textContent = 'Error';
  }
};

/* Fetch protected status from Cloudflare worker for Admin Drawer */
async function fetchAdminStatus() {
  if (!isAdmin()) return;
  try {
    const res = await fetch('/api/status', {
      headers: { 'x-admin-token': 'micky_auth_kpp_verified' }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.tinify) {
        const t = data.tinify;
        $('tinypngUsageCount').textContent = `${t.totalUsedThisMonth} of ${t.totalCapacity} used (${data.month})`;
        const pct = t.totalCapacity ? Math.min(100, (t.totalUsedThisMonth / t.totalCapacity) * 100) : 0;
        $('tinypngMeterFill').style.width = pct + '%';
        $('tinypngStatusBadge').textContent = pct >= 100 ? 'Quota Full (Switched to ImageKit)' : 'Active';
      }
    }
  } catch {}
}

/* -------------------------------------------------------------
   2. Compression Engines
   - Public Visitors: 100% Browser Canvas (Instant, Private, Free)
   - Admin Users: Option to test TinyPNG Pool API directly
   - Client Websites: TinyPNG Pool via API key
   ------------------------------------------------------------- */

// In-Browser Canvas (Default for public users)
async function compressInBrowser(file, opts) {
  const bmp = await createImageBitmap(file);
  let w = bmp.width;
  let h = bmp.height;
  if (opts.maxW && w > opts.maxW) {
    h = Math.round(h * opts.maxW / w);
    w = opts.maxW;
  }
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  const type = opts.format === 'keep' ? file.type : opts.format;
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise((ok, no) => cv.toBlob(b => b ? ok(b) : no(new Error('Canvas export failed')), type, opts.quality / 100));
  return { blob, provider: 'Browser Canvas (Offline)' };
}

// Cloudflare API (TinyPNG Pool -> ImageKit failover for Admin & Client API)
async function compressViaCloudflareAPI(file, opts) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('quality', opts.quality);

  const res = await fetch('/api/compress', {
    method: 'POST',
    headers: {
      'x-admin-token': 'micky_auth_kpp_verified',
      'x-api-key': DEFAULT_CLIENT_KEY
    },
    body: fd
  });

  if (!res.ok) {
    let err = 'Compression failed';
    try { const j = await res.json(); err = j.error || err; } catch {}
    throw new Error(err);
  }

  const prov = res.headers.get('X-Provider') || 'Cloudflare API';
  const blob = await res.blob();
  fetchAdminStatus(); // Refresh admin usage numbers live
  return { blob, provider: prov };
}

// Master Compressor Router
async function compressImage(file, opts) {
  // If user is Admin and explicitly checked "Use TinyPNG Pool API"
  if (isAdmin() && $('adminUseTinyPngCheckbox')?.checked) {
    try {
      return await compressViaCloudflareAPI(file, opts);
    } catch (e) {
      console.warn('TinyPNG failed, falling back to local canvas:', e);
      return await compressInBrowser(file, opts);
    }
  }
  // Public visitors always use browser canvas (0 quota consumed!)
  return await compressInBrowser(file, opts);
}

/* -------------------------------------------------------------
   3. File Upload, UI Controls & Cards Rendering
   ------------------------------------------------------------- */
const Q = [];
const totals = { count: 0, origSize: 0, compSize: 0 };
let isProcessing = false;

const getOptions = () => ({
  quality: parseInt($('qRange').value, 10),
  maxW: parseInt($('maxW').value, 10) || 0,
  format: $('fmtSel').value
});

$('qRange').oninput = () => $('qVal').textContent = $('qRange').value + '%';

// Select images button triggers hidden input
$('selectBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => {
  handleFiles(e.target.files);
  e.target.value = '';
};

// Drag and drop handlers
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

function handleFiles(files) {
  const imgFiles = [...files].filter(f => f.type.startsWith('image/'));
  if (!imgFiles.length) return;
  imgFiles.forEach(f => {
    const cardEl = createCardElement(f);
    Q.push({ file: f, el: cardEl });
  });
  $('resultsSection').hidden = false;
  processQueue();
}

function createCardElement(file) {
  const card = document.createElement('div');
  card.className = 'image-card';
  card.innerHTML = `
    <div class="card-header">
      <div class="card-title" title="${esc(file.name)}">${esc(file.name)}</div>
      <span class="card-badge processing">Processing…</span>
    </div>
    <div class="cmp">
      <img src="${URL.createObjectURL(file)}" alt="Before">
      <img class="aft" alt="After" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <span class="cmp-label" style="left:8px">Before</span>
      <span class="cmp-label" style="right:8px">After</span>
      <i class="hd"></i>
      <input type="range" min="0" max="100" value="50" aria-label="Compare">
    </div>
    <div class="card-stats">
      <span>Before: <b>${fmt(file.size)}</b></span>
      <span class="after-size">After: <b>…</b></span>
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

function updateSummary() {
  const pct = totals.origSize ? Math.round((1 - totals.compSize / totals.origSize) * 100) : 0;
  $('summaryText').textContent = `${totals.count} image${totals.count > 1 ? 's' : ''} compressed: ${fmt(totals.origSize)} down to ${fmt(totals.compSize)}, saved ${pct}%`;
}

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  while (Q.length > 0) {
    const item = Q.shift();
    const { file, el } = item;
    const badge = el.querySelector('.card-badge');
    const aftImg = el.querySelector('.aft');
    const aftSize = el.querySelector('.after-size b');
    const savingTag = el.querySelector('.saving-tag');
    const dlBtn = el.querySelector('.dl-btn');
    const note = el.querySelector('.card-provider-note');

    try {
      const res = await compressImage(file, getOptions());
      const url = URL.createObjectURL(res.blob);

      aftImg.src = url;
      aftSize.textContent = fmt(res.blob.size);
      
      const savedPercent = Math.max(0, Math.round((1 - res.blob.size / file.size) * 100));
      savingTag.textContent = `−${savedPercent}%`;
      
      badge.className = 'card-badge done';
      badge.textContent = 'Ready';
      
      dlBtn.hidden = false;
      dlBtn.href = url;
      dlBtn.download = file.name.replace(/\.[^.]+$/, '') + '-compressed.' + (EXT[res.blob.type] || 'jpg');
      
      if (isAdmin()) {
        note.textContent = `Processed via ${res.provider}`;
      }

      totals.count++;
      totals.origSize += file.size;
      totals.compSize += res.blob.size;
      updateSummary();
    } catch (err) {
      badge.textContent = 'Failed';
      badge.style.color = 'var(--red)';
      savingTag.textContent = '—';
      note.textContent = err.message;
    }
  }

  isProcessing = false;
}

// Download All Button
$('downloadAllBtn').onclick = () => {
  const btns = document.querySelectorAll('.dl-btn:not([hidden])');
  btns.forEach((btn, idx) => {
    setTimeout(() => btn.click(), idx * 250);
  });
};

// Clear Results Button
$('clearBtn').onclick = () => {
  $('cardsGrid').innerHTML = '';
  totals.count = 0;
  totals.origSize = 0;
  totals.compSize = 0;
  $('resultsSection').hidden = true;
};

// Before / After Slider interaction
$('cardsGrid').addEventListener('input', (e) => {
  if (e.target.matches('.cmp input')) {
    e.target.parentNode.style.setProperty('--p', e.target.value + '%');
  }
});

// Initial UI check
updateAuthUI();
