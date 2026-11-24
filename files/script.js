const $=id=>document.getElementById(id),mem={},LIMIT=500,
EXT={'image/webp':'webp','image/jpeg':'jpg','image/png':'png','image/avif':'avif','image/gif':'gif'};

const Store={
  get(k,d){try{const v=localStorage.getItem(k);if(v!==null)return JSON.parse(v)}catch{}return k in mem?mem[k]:d},
  set(k,v){mem[k]=v;try{localStorage.setItem(k,JSON.stringify(v))}catch{}}
};

// Clear any old lockout state so TinyPNG and API are always ready
Store.set('mc_killed', {});

const fmt=b=>b<1024?b+' B':b<1048576?(b/1024).toFixed(1)+' KB':(b/1048576).toFixed(2)+' MB';
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* Authentication & Client API Key: uses the configured live key */
const DEFAULT_KEY = 'micky_compressor_live_secret123';
const Auth={
  init(){
    let k=Store.get('mc_api_key');
    if(!k || k.startsWith('micky_live_')){
      k=DEFAULT_KEY;
      Store.set('mc_api_key', k);
    }
    return k;
  },
  regen(){
    const k='micky_live_'+[...crypto.getRandomValues(new Uint8Array(16))].map(x=>x.toString(16).padStart(2,'0')).join('');
    Store.set('mc_api_key',k);
    return k;
  },
  check(k){if(!k)throw Object.assign(new Error('Missing API key'),{code:401})}
};

/* Monthly usage counters */
const Usage={
  get(){
    const m=new Date().toISOString().slice(0,7);
    let u=Store.get('mc_usage');
    if(!u||u.m!==m){
      u={m,tinypng:0,imagekit:0,serverless:0,local:0};
      Store.set('mc_usage',u);
    }
    return u;
  },
  inc(p){const u=this.get();u[p]=(u[p]||0)+1;Store.set('mc_usage',u)},
  set(p,n){const u=this.get();u[p]=n;Store.set('mc_usage',u)}
};

const req=async(u,o={})=>{
  const ac=new AbortController(),t=setTimeout(()=>ac.abort(),30000);
  try{
    const r=await fetch(u,{...o,signal:ac.signal});
    if(r.status===429)throw Object.assign(new Error('Rate limited (HTTP 429)'),{code:429});
    if(!r.ok){
      let errDetail='';
      try{const j=await r.json();errDetail=j.error||'';}catch{}
      throw Object.assign(new Error(`HTTP ${r.status}${errDetail?' - '+errDetail:''}`),{code:r.status});
    }
    return r;
  }catch(e){if(e.name==='AbortError')throw Object.assign(new Error('No response after 30 seconds'),{code:'timeout'});throw e}
  finally{clearTimeout(t)}
};
const blobOf=async(u,h)=>(await req(u,h&&{headers:h})).blob();

/* Providers in failover order */
const providers=[
 {id:'serverless',name:'Cloudflare API (TinyPNG + ImageKit)',limit:LIMIT,
  skip:(c,f,u)=>u.tinypng>=LIMIT?'TinyPNG 500 limit reached':'',
  async run(f,o,c){
    const ep=(c.apiEndpoint||'/api/compress').trim();
    const fd=new FormData();
    fd.append('file',f);
    fd.append('quality',o.quality);
    const key=Store.get('mc_api_key')||DEFAULT_KEY;
    const r=await req(ep,{
      method:'POST',
      headers:{'x-api-key':key},
      body:fd
    });
    const prov=r.headers.get('X-Provider')||'Cloudflare API';
    const tinyCount=r.headers.get('X-Monthly-Tinify-Count');
    if(tinyCount){
      Usage.set('tinypng',parseInt(tinyCount,10));
    }
    const blob=await r.blob();
    return {blob,provider:prov};
  }},
 {id:'local',name:'Browser Canvas (Offline)',
  skip:()=>'',
  async run(f,o){
    const bmp=await createImageBitmap(f);let w=bmp.width,h=bmp.height;
    if(o.maxW&&w>o.maxW){h=Math.round(h*o.maxW/w);w=o.maxW}
    const cv=document.createElement('canvas');cv.width=w;cv.height=h;
    const x=cv.getContext('2d'),type=o.format==='keep'?f.type:o.format;
    if(type==='image/jpeg'){x.fillStyle='#fff';x.fillRect(0,0,w,h)}
    x.drawImage(bmp,0,0,w,h);
    const blob=await new Promise((ok,no)=>cv.toBlob(b=>b?ok(b):no(new Error('Canvas export failed')),type,o.quality/100));
    return {blob,provider:'Browser canvas'};
  }}
];

class CompressionManager{
  constructor(onChange){this.onChange=onChange}
  async compress(file,opts,apiKey){
    Auth.check(apiKey);
    const c=Store.get('mc_cfg',{apiEndpoint:'/api/compress'}),log=[];
    for(const p of providers){
      const why=p.skip(c,file,Usage.get());
      if(why){log.push(p.name+': '+why);continue}
      try{
        const res=await p.run(file,opts,c);
        const blob=res.blob||res;
        const providerName=res.provider||p.name;
        Usage.inc(p.id);this.onChange();
        const keep=blob.size>=file.size;
        return{blob:keep?file:blob,provider:providerName,log,note:keep?'Original was already optimal.':''};
      }catch(e){
        log.push(`${p.name} failed (${e.message})`);
        this.onChange();
      }
    }
    throw new Error('All providers failed: '+log.join(' | '));
  }
}
const mgr=new CompressionManager(renderStatus);
window.ImageCompressor={compress:(file,opts,apiKey)=>mgr.compress(file,opts,apiKey)};

/* Live status bar */
function renderStatus(){
  const c=Store.get('mc_cfg',{apiEndpoint:'/api/compress'}),u=Usage.get();let act=false;
  $('status').innerHTML=providers.map((p,i)=>{
    const w0=p.skip(c,{type:'image/png'},u),on=!w0&&!act;if(on)act=true;
    const count=p.id==='serverless'?(u.tinypng||0):(u[p.id]||0);
    const pct=p.limit?Math.min(100,count/p.limit*100):0;
    return `<div class="prov ${on?'on':w0?'off':''}"><div><b>${i+1}. ${p.name}</b></div>
      <div class="tag">${on?'Active':w0||'Ready'}</div>
      <div class="meter"><i style="width:${p.limit?pct:count?100:0}%"></i></div>
      <small>${p.limit?`${count} of ${p.limit} used (${u.m})`:`${count} processed (${u.m})`}</small></div>`;
  }).join('');
}

// Fetch live status from Cloudflare worker on start
async function checkBackendStatus(){
  try{
    const r=await fetch('/api/status');
    if(r.ok){
      const d=await r.json();
      $('live').textContent=`Connected to Cloudflare Worker. TinyPNG: ${d.tinifyConfigured?'Ready (500 free/mo)':'Not set'}, ImageKit: ${d.imagekitConfigured?'Ready (20GB/mo)':'Not set'}.`;
    }
  }catch{}
}
checkBackendStatus();

/* Results dashboard */
const Q=[],tot={n:0,i:0,o:0};let busy=false;
const opts=()=>({quality:+$('q').value,maxW:+$('mw').value||0,format:$('fm').value});
function mk(f){
  const d=document.createElement('article');d.className='panel item';
  d.innerHTML=`<div class="row"><b>${esc(f.name)}</b><span class="tag st">Queued</span></div>
  <div class="cmp"><img src="${URL.createObjectURL(f)}" alt="Before"><img class="aft" alt="After" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><span class="lb" style="left:8px">Before</span><span class="lb" style="right:8px">After</span><i class="hd"></i><input type="range" min="0" max="100" value="50" aria-label="Drag to compare before and after"></div>
  <div class="row"><small>Before <b>${fmt(f.size)}</b></small><small class="af">After <b>…</b></small></div>
  <div class="row"><span class="save">…</span><a class="btn p dl" hidden>Download</a></div><small class="mute inf"></small>`;
  $('res').prepend(d);return d;
}
function sum(){
  const pc=tot.i?Math.round((1-tot.o/tot.i)*100):0;
  $('sum').textContent=`${tot.n} compressed: ${fmt(tot.i)} down to ${fmt(tot.o)}, saved ${pc}%`;
}
async function work({f,d}){
  const s=x=>d.querySelector(x);s('.st').textContent='Compressing…';
  try{
    const r=await ImageCompressor.compress(f,opts(),Store.get('mc_api_key')),url=URL.createObjectURL(r.blob);
    s('.aft').src=url;
    s('.af b').textContent=fmt(r.blob.size);
    s('.save').textContent='−'+Math.max(0,Math.round((1-r.blob.size/f.size)*100))+'%';
    s('.st').textContent='via '+r.provider;
    const a=s('.dl');a.hidden=false;a.href=url;a.download=f.name.replace(/\.[^.]+$/,'')+'-min.'+(EXT[r.blob.type]||'img');
    s('.inf').textContent=[r.note,r.log.length?'Fallback info: '+r.log.join('; '):''].filter(Boolean).join(' ');
    tot.n++;tot.i+=f.size;tot.o+=r.blob.size;
  }catch(e){s('.st').textContent='Failed';s('.save').textContent='—';s('.inf').textContent=e.message}
  sum();
}
async function go(){
  if(busy)return;busy=true;
  while(Q.length){const j=Q.shift();$('live').textContent=`Compressing ${j.f.name} (${Q.length} waiting)`;await work(j)}
  busy=false;$('live').textContent='Done. Add more images any time.';
}
function add(fs){
  [...fs].filter(f=>f.type.startsWith('image/')).forEach(f=>Q.push({f,d:mk(f)}));
  $('sumrow').hidden=false;go();
}

/* Uploader */
const dz=$('dz');
['dragenter','dragover'].forEach(e=>dz.addEventListener(e,ev=>{ev.preventDefault();dz.classList.add('over')}));
['dragleave','drop'].forEach(e=>dz.addEventListener(e,ev=>{ev.preventDefault();dz.classList.remove('over')}));
dz.addEventListener('drop',e=>add(e.dataTransfer.files));
dz.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('file').click()}};
$('file').onchange=e=>{add(e.target.files);e.target.value=''};
$('q').oninput=()=>$('qv').textContent=$('q').value;
$('all').onclick=()=>[...document.querySelectorAll('.dl:not([hidden])')].forEach((a,i)=>setTimeout(()=>a.click(),i*300));
$('clr').onclick=()=>{$('res').innerHTML='';tot.n=tot.i=tot.o=0;$('sumrow').hidden=true};

/* API key panel */
$('key').textContent=Auth.init();
$('kc').onclick=async()=>{try{await navigator.clipboard.writeText($('key').textContent);$('kc').textContent='Copied'}catch{$('kc').textContent='Copy failed'}setTimeout(()=>$('kc').textContent='Copy Key',1500)};
$('kr').onclick=()=>{$('key').textContent=Auth.regen()};

/* Docs Dialog */
$('docsBtn').onclick=()=>$('docsDlg').showModal();
$('docsClose').onclick=()=>$('docsDlg').close();

/* Settings modal */
const F=[
 ['Cloudflare Worker Endpoint','apiEndpoint','Backend Endpoint URL','url','Default is /api/compress. Only change if using an external URL.']
];
$('flds').innerHTML=F.map(([h,k,l,t,i])=>`${h?`<h3>${h}</h3>`:''}<label>${l}<input data-k="${k}" type="${t}" autocomplete="off"><small>${i}</small></label>`).join('');
$('cfg').onclick=()=>{const c=Store.get('mc_cfg',{apiEndpoint:'/api/compress'});document.querySelectorAll('[data-k]').forEach(i=>i.value=c[i.dataset.k]||'');$('dlg').showModal()};
$('cls').onclick=()=>$('dlg').close();
$('save').onclick=()=>{const c={};document.querySelectorAll('[data-k]').forEach(i=>c[i.dataset.k]=i.value.trim()||'/api/compress');Store.set('mc_cfg',c);$('dlg').close();renderStatus()};
$('rst').onclick=()=>{Store.set('mc_usage',null);renderStatus()};

function warn(m){$('alert').hidden=false;const p=document.createElement('p');p.textContent=m;$('amsg').append(p)}
$('adm').onclick=()=>{$('alert').hidden=true;$('amsg').innerHTML=''};
renderStatus();
$('res').addEventListener('input',e=>{if(e.target.matches('.cmp input'))e.target.parentNode.style.setProperty('--p',e.target.value+'%')});
