const $=id=>document.getElementById(id),mem={},LIMIT=500,
EXT={'image/webp':'webp','image/jpeg':'jpg','image/png':'png','image/avif':'avif','image/gif':'gif'};
const Store={
  get(k,d){try{const v=localStorage.getItem(k);if(v!==null)return JSON.parse(v)}catch{}return k in mem?mem[k]:d},
  set(k,v){mem[k]=v;try{localStorage.setItem(k,JSON.stringify(v))}catch{}}
};
const fmt=b=>b<1024?b+' B':b<1048576?(b/1024).toFixed(1)+' KB':(b/1048576).toFixed(2)+' MB';
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* Mock authentication: key is generated on first load and checked on every compress call */
const Auth={
  init(){return Store.get('mc_api_key')||this.regen()},
  regen(){const k='micky_live_'+[...crypto.getRandomValues(new Uint8Array(16))].map(x=>x.toString(16).padStart(2,'0')).join('');Store.set('mc_api_key',k);return k},
  check(k){if(!k||k!==Store.get('mc_api_key'))throw Object.assign(new Error('401 Unauthorized: missing or invalid API key'),{code:401})}
};

/* Monthly usage counters (reset automatically when the month changes) */
const Usage={
  get(){const m=new Date().toISOString().slice(0,7);let u=Store.get('mc_usage');if(!u||u.m!==m)u={m,tinypng:0,imagekit:0,cloudinary:0,local:0};return u},
  inc(p){const u=this.get();u[p]++;Store.set('mc_usage',u)},
  set(p,n){const u=this.get();u[p]=n;Store.set('mc_usage',u)}
};

const req=async(u,o={})=>{
  const ac=new AbortController(),t=setTimeout(()=>ac.abort(),20000);
  try{
    const r=await fetch(u,{...o,signal:ac.signal});
    if(r.status===429)throw Object.assign(new Error('Rate limited (HTTP 429)'),{code:429});
    if(!r.ok)throw Object.assign(new Error('HTTP '+r.status+' from '+new URL(u,location.href).host),{code:r.status});
    return r;
  }catch(e){if(e.name==='AbortError')throw Object.assign(new Error('No response after 20 seconds'),{code:'timeout'});throw e}
  finally{clearTimeout(t)}
};
const blobOf=async(u,h)=>(await req(u,h&&{headers:h})).blob();

/* Providers, in failover order. skip() returns a reason string, or '' when eligible. */
const providers=[
 {id:'tinypng',name:'TinyPNG',limit:LIMIT,
  skip:(c,f,u)=>!c.tinyKey?'Not configured':u.tinypng>=LIMIT?'Limit reached (500)':/^image\/(png|jpeg|webp|avif)$/.test(f.type)?'':'Unsupported type',
  async run(f,o,c){
    const ep=c.tinyEndpoint||'https://api.tinify.com/shrink',h={Authorization:'Basic '+btoa('api:'+c.tinyKey)};
    const j=await(await req(ep,{method:'POST',headers:h,body:f})).json();
    return blobOf(ep.replace(/\/shrink$/,'')+new URL(j.output.url).pathname,h);
  }},
 {id:'imagekit',name:'ImageKit',
  skip:c=>c.ikPublic&&c.ikAuth?'':'Not configured',
  async run(f,o,c){
    const a=await(await req(c.ikAuth)).json(); // expects {token, expire, signature}
    const fd=new FormData();
    fd.append('file',f);fd.append('fileName',f.name);fd.append('publicKey',c.ikPublic);
    fd.append('signature',a.signature);fd.append('expire',a.expire);fd.append('token',a.token);
    const j=await(await req('https://upload.imagekit.io/api/v1/files/upload',{method:'POST',body:fd})).json();
    return blobOf(`${j.url}?tr=q-${o.quality},f-auto${o.maxW?',w-'+o.maxW:''}`);
  }},
 {id:'cloudinary',name:'Cloudinary',
  skip:c=>c.cldName&&c.cldPreset?'':'Not configured',
  async run(f,o,c){
    const fd=new FormData();fd.append('file',f);fd.append('upload_preset',c.cldPreset);
    const j=await(await req(`https://api.cloudinary.com/v1_1/${encodeURIComponent(c.cldName)}/image/upload`,{method:'POST',body:fd})).json();
    return blobOf(j.secure_url.replace('/upload/',`/upload/q_${o.quality},f_auto${o.maxW?',c_limit,w_'+o.maxW:''}/`));
  }},
 {id:'local',name:'Browser canvas',
  skip:()=>'',
  async run(f,o){
    const bmp=await createImageBitmap(f);let w=bmp.width,h=bmp.height;
    if(o.maxW&&w>o.maxW){h=Math.round(h*o.maxW/w);w=o.maxW}
    const cv=document.createElement('canvas');cv.width=w;cv.height=h;
    const x=cv.getContext('2d'),type=o.format==='keep'?f.type:o.format;
    if(type==='image/jpeg'){x.fillStyle='#fff';x.fillRect(0,0,w,h)}
    x.drawImage(bmp,0,0,w,h);
    return new Promise((ok,no)=>cv.toBlob(b=>b?ok(b):no(new Error('Canvas export failed')),type,o.quality/100));
  }}
];

const KEYS={tinypng:['tinyKey'],imagekit:['ikPublic'],cloudinary:['cldPreset']};
class CompressionManager{
  constructor(onChange){this.onChange=onChange}
  kill(p,e){ // delete the dead key and alert immediately
    const c=Store.get('mc_cfg',{}),k=Store.get('mc_killed',{});
    KEYS[p.id].forEach(f=>c[f]='');k[p.id]=e.message;
    Store.set('mc_cfg',c);Store.set('mc_killed',k);
    warn(`${p.name} key killed and removed: ${e.message}. This image moved to the next provider. Add a new key in Provider settings to use ${p.name} again.`);
  }
  async compress(file,opts,apiKey){
    Auth.check(apiKey);
    const c=Store.get('mc_cfg',{}),log=[];
    for(const p of providers){
      const why=p.skip(c,file,Usage.get());
      if(why){if(why!=='Not configured')log.push(p.name+': '+why);continue}
      try{
        const blob=await p.run(file,opts,c);
        Usage.inc(p.id);this.onChange();
        const keep=blob.size>=file.size;
        return{blob:keep?file:blob,provider:p.name,log,note:keep?'Already optimal, so the original was kept.':''};
      }catch(e){
        if(e.code===429){if(p.id==='tinypng')Usage.set('tinypng',LIMIT);log.push(p.name+': '+e.message)}
        else if(p.id!=='local'&&(!e.code||[401,403,'timeout'].includes(e.code)||e.code>=500)){this.kill(p,e);log.push(p.name+': key killed ('+e.message+')')}
        else log.push(p.name+': '+e.message);
        this.onChange();
      }
    }
    throw new Error('Every provider failed. '+log.join(' '));
  }
}
const mgr=new CompressionManager(renderStatus);
window.ImageCompressor={compress:(file,opts,apiKey)=>mgr.compress(file,opts,apiKey)};

/* Live status bar */
function renderStatus(){
  const c=Store.get('mc_cfg',{}),u=Usage.get();let act=false;
  $('status').innerHTML=providers.map((p,i)=>{
    const kd=Store.get('mc_killed',{}),w0=p.skip(c,{type:'image/png'},u),why=w0==='Not configured'&&kd[p.id]?'Key killed, add a new one':w0,on=!why&&!act;if(on)act=true;
    const pct=p.limit?Math.min(100,u[p.id]/p.limit*100):0;
    return `<div class="prov ${on?'on':why?'off':''}"><div><b>${i+1}. ${p.name}</b></div>
      <div class="tag">${on?'Handling requests':why||'Standing by'}</div>
      <div class="meter"><i style="width:${p.limit?pct:u[p.id]?100:0}%"></i></div>
      <small>${p.limit?`${u[p.id]} of ${p.limit} used this month`:`${u[p.id]} images this month`}</small></div>`;
  }).join('');
}

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
    s('.inf').textContent=[r.note,r.log.length?'Fell through: '+r.log.join(' '):''].filter(Boolean).join(' ');
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
$('kc').onclick=async()=>{try{await navigator.clipboard.writeText($('key').textContent);$('kc').textContent='Copied'}catch{$('kc').textContent='Copy failed'}setTimeout(()=>$('kc').textContent='Copy',1500)};
$('kr').onclick=()=>$('key').textContent=Auth.regen();

/* Settings modal */
const F=[
 ['TinyPNG (500 free images a month)','tinyKey','API key','password','Get it free at tinypng.com/developers and paste the key here.'],
 [0,'tinyEndpoint','Endpoint or CORS proxy (optional)','url','Browsers block TinyPNG, so enter your own proxy URL ending in /shrink.'],
 ['ImageKit','ikPublic','Public key','text','ImageKit dashboard, Developer options, API keys. Use the public key only.'],
 [0,'ikAuth','Authentication endpoint URL','url','A URL on your own server that signs with your private key and returns token, expire and signature.'],
 ['Cloudinary (unsigned uploads)','cldName','Cloud name','text','Shown at the top of your Cloudinary dashboard.'],
 [0,'cldPreset','Upload preset','text','Settings, Upload, Upload presets. Create one with signing mode set to Unsigned.']];
$('flds').innerHTML=F.map(([h,k,l,t,i])=>`${h?`<h3>${h}</h3>`:''}<label>${l}<input data-k="${k}" type="${t}" autocomplete="off"><small>${i}</small></label>`).join('');
$('cfg').onclick=()=>{const c=Store.get('mc_cfg',{});document.querySelectorAll('[data-k]').forEach(i=>i.value=c[i.dataset.k]||'');$('dlg').showModal()};
$('cls').onclick=()=>$('dlg').close();
$('save').onclick=()=>{const c={};document.querySelectorAll('[data-k]').forEach(i=>c[i.dataset.k]=i.value.trim());Store.set('mc_cfg',c);Store.set('mc_killed',{});$('dlg').close();renderStatus()};
$('rst').onclick=()=>{Store.set('mc_usage',null);renderStatus()};

function warn(m){$('alert').hidden=false;const p=document.createElement('p');p.textContent=m;$('amsg').append(p)}
$('adm').onclick=()=>{$('alert').hidden=true;$('amsg').innerHTML=''};
renderStatus();
$('res').addEventListener('input',e=>{if(e.target.matches('.cmp input'))e.target.parentNode.style.setProperty('--p',e.target.value+'%')});
