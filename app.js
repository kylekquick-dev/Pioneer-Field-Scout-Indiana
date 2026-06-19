/* =====================================================================
   Field Scout — Cloud application logic
   Backend: Supabase (auth, Postgres + RLS, Storage, Realtime)
   ===================================================================== */

const CFG = window.FIELD_SCOUT_CONFIG;
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

const CATEGORIES = [
  {id:"disease",      label:"Disease",             color:"#c0392b", cls:"cat-disease"},
  {id:"insect",       label:"Insect",              color:"#e0a82e", cls:"cat-insect"},
  {id:"nutrient",     label:"Nutrient Deficiency", color:"#16a085", cls:"cat-nutrient"},
  {id:"herbicide",    label:"Herbicide",           color:"#8e44ad", cls:"cat-herbicide"},
  {id:"environmental",label:"Environmental",       color:"#2980b9", cls:"cat-environmental"},
];
const catById = id => CATEGORIES.find(c=>c.id===id);

/* ---------------- state ---------------- */
let session   = null;     // supabase auth session
let isAdmin   = false;    // role === 'admin' from profiles
let activeCat = "disease";
let observations = [];     // joined with photos[] (each photo => {path,url})
let editingId = null;
let pendingPhotos = [];     // {file?:File, url:string, existingPath?:string}
let loginMode = "viewer";

/* =====================================================================
   AUTH
   ===================================================================== */
async function initAuth(){
  // Process magic-link / OAuth redirect tokens if present in URL hash
  const { data:{ session: s } } = await sb.auth.getSession();
  session = s;
  await afterAuthChange();

  sb.auth.onAuthStateChange(async (_event, s2)=>{
    session = s2;
    await afterAuthChange();
  });
}

async function afterAuthChange(){
  if(session){
    // fetch role from profiles
    const { data, error } = await sb.from('profiles').select('role,full_name').eq('id', session.user.id).single();
    isAdmin = !error && data && data.role === 'admin';
    const name = (data && data.full_name) || session.user.email;
    document.getElementById('adminBadge').innerHTML = isAdmin
      ? '🔑 Admin: '+esc(name) : '👁️ Viewer: '+esc(name);
    document.getElementById('adminBadge').classList.toggle('active', isAdmin);
    document.getElementById('authBtn').textContent = 'Sign Out';
    document.getElementById('addBtn').style.display = isAdmin ? 'inline-block':'none';
    document.getElementById('roNote').classList.toggle('show', !isAdmin);
    await loadObservations();
    subscribeRealtime();
    if(isAdmin){ await refreshPendingBadge(); syncPending(); }
  }else{
    isAdmin = false;
    document.getElementById('adminBadge').textContent = 'Not signed in';
    document.getElementById('adminBadge').classList.remove('active');
    document.getElementById('authBtn').textContent = 'Sign In';
    document.getElementById('addBtn').style.display = 'none';
    document.getElementById('roNote').classList.remove('show');
    observations = [];
    render();
    openLogin();
  }
  hideLoading();
}

function onAuthBtn(){
  if(session){
    sb.auth.signOut(); toast('Signed out.');
  }else openLogin();
}

function openLogin(){
  setMode('viewer');
  document.getElementById('v_email').value='';
  document.getElementById('a_email').value=CFG.ADMIN_EMAIL||'';
  document.getElementById('a_pass').value='';
  document.getElementById('loginOverlay').classList.add('show');
}
function closeLogin(){ document.getElementById('loginOverlay').classList.remove('show'); }
function setMode(m){
  loginMode = m;
  document.getElementById('seg_viewer').classList.toggle('active', m==='viewer');
  document.getElementById('seg_admin').classList.toggle('active', m==='admin');
  document.getElementById('viewerPane').style.display = m==='viewer'?'block':'none';
  document.getElementById('adminPane').style.display  = m==='admin'?'block':'none';
  const btn=document.getElementById('loginActionBtn');
  if(m==='viewer'){ btn.textContent='Send Magic Link'; btn.onclick=doViewerMagic; }
  else{ btn.textContent='Log In'; btn.onclick=doAdminLogin; }
}

/* Passwordless viewer sign-in via emailed magic link */
async function doViewerMagic(){
  const email=document.getElementById('v_email').value.trim();
  if(!email){ toast('Enter your email.'); return; }
  const { error } = await sb.auth.signInWithOtp({
    email,
    options:{ emailRedirectTo: window.location.href.split('#')[0] }
  });
  if(error){ toast('Error: '+error.message); return; }
  toast('Magic link sent — check '+email);
  closeLogin();
}

/* Administrator password sign-in */
async function doAdminLogin(){
  const email=document.getElementById('a_email').value.trim();
  const pass =document.getElementById('a_pass').value;
  if(!email||!pass){ toast('Enter email and password.'); return; }
  const { error } = await sb.auth.signInWithPassword({ email, password:pass });
  if(error){ toast('Login failed: '+error.message); return; }
  closeLogin(); toast('Welcome back.');
}

/* =====================================================================
   DATA — load, realtime, photos
   ===================================================================== */
async function loadObservations(){
  const { data, error } = await sb
    .from('observations')
    .select('*, photos(id,storage_path,thumb_path,sort_order)')
    .order('created_at',{ascending:false});
  if(error){ toast('Load error: '+error.message); return; }
  // resolve signed URLs for all photos
  for(const o of data){
    o.photos = (o.photos||[]).sort((a,b)=>a.sort_order-b.sort_order);
    for(const p of o.photos){
      const full = await sb.storage.from(CFG.PHOTO_BUCKET).createSignedUrl(p.storage_path, 3600);
      p.url = full.data ? full.data.signedUrl : '';
      if(p.thumb_path){
        const th = await sb.storage.from(CFG.PHOTO_BUCKET).createSignedUrl(p.thumb_path, 3600);
        p.thumbUrl = th.data ? th.data.signedUrl : p.url;
      }else{
        p.thumbUrl = p.url;
      }
    }
    }
  }
  observations = data;
  render();
}

let realtimeChan=null;
function subscribeRealtime(){
  if(realtimeChan) return;
  realtimeChan = sb.channel('obs-sync')
    .on('postgres_changes',{event:'*',schema:'public',table:'observations'},()=>loadObservations())
    .on('postgres_changes',{event:'*',schema:'public',table:'photos'},()=>loadObservations())
    .subscribe(status=>{
      const live = status==='SUBSCRIBED';
      document.getElementById('syncDot').classList.toggle('live', live);
      document.getElementById('syncBadge').lastChild.textContent = live?' Live sync':' Offline';
    });
}

/* =====================================================================
   RENDER
   ===================================================================== */
function buildTabs(){
  document.getElementById('tabs').innerHTML = CATEGORIES.map(c=>{
    const n=observations.filter(o=>o.category===c.id).length;
    return `<button class="tab ${c.cls} ${c.id===activeCat?'active':''}" onclick="switchCat('${c.id}')">
      <span class="dot"></span>${c.label}<span class="count">${n}</span></button>`;
  }).join('');
}
function switchCat(id){ activeCat=id; render(); }

function render(){
  buildTabs();
  const cat=catById(activeCat);
  document.getElementById('catTitle').textContent=cat.label;
  const q=(document.getElementById('search').value||'').toLowerCase();
  let list=observations.filter(o=>o.category===activeCat);
  if(q) list=list.filter(o=>((o.title||'')+(o.notes||'')+(o.field||'')+(o.crop||'')+(o.product||'')+(o.growth_stage||'')+(o.scout||'')).toLowerCase().includes(q));
  document.getElementById('catSub').textContent=`${list.length} observation${list.length!==1?'s':''} · ${cat.label} training library`;
  const grid=document.getElementById('grid');
  if(list.length===0){
    grid.innerHTML=`<div class="empty-state" style="grid-column:1/-1"><div class="ic">🌱</div>
      <p>No ${cat.label.toLowerCase()} observations yet.</p>
      ${isAdmin?'<p style="margin-top:8px">Click <b>New Observation</b> to add one.</p>':''}</div>`;
    return;
  }
  grid.innerHTML=list.map(o=>cardHTML(o,cat)).join('');
}

function cardHTML(o,cat){
  const first=o.photos&&o.photos[0];
  const img=first?`<img loading="lazy" src="${first.thumbUrl||first.url}">`:`<div class="ph-empty">📷</div>`;
  const cnt=o.photos&&o.photos.length>1?`<span class="imgcount">📷 ${o.photos.length}</span>`:'';
  const acts=isAdmin?`<button class="btn small secondary" onclick="event.stopPropagation();editObs('${o.id}')">Edit</button>
    <button class="btn small danger" onclick="event.stopPropagation();delObs('${o.id}')">Delete</button>`:'';
  return `<div class="card" onclick="viewObs('${o.id}')">
    <div class="photo">${img}<span class="pill" style="background:${cat.color}">${esc(o.severity||'')}</span>${cnt}</div>
    <div class="body"><h3>${esc(o.title)}</h3>
      <div class="notes">${esc((o.notes||'').slice(0,110))}${(o.notes||'').length>110?'…':''}</div>
      <div class="attrs">
        <div class="a"><span class="k">Field</span><span class="v">${esc(o.field||'—')}</span></div>
        <div class="a"><span class="k">Crop</span><span class="v">${esc(o.crop||'—')}</span></div>
        <div class="a"><span class="k">Product</span><span class="v">${esc(o.product||'—')}</span></div>
        <div class="a"><span class="k">Growth Stage</span><span class="v">${esc(o.growth_stage||'—')}</span></div>
      </div></div>
    <div class="foot"><span>📅 ${o.scouting_date||'—'} · 👤 ${esc(o.scout||'—')}</span><span class="acts">${acts}</span></div>
  </div>`;
}

/* ---------------- detail view ---------------- */
function viewObs(id){
  const o=observations.find(x=>x.id===id); if(!o) return;
  const cat=catById(o.category);
  document.getElementById('v_title').textContent=o.title;
  const gallery=o.photos&&o.photos.length
    ? `<div class="gallery">${o.photos.map(p=>`<img loading="lazy" src="${p.thumbUrl||p.url}" onclick="zoom('${p.url}')">`).join('')}</div>`
    : `<div class="dropzone" style="cursor:default">No photos attached</div>`;
  document.getElementById('v_body').innerHTML=`${gallery}
    <div class="det-attrs">
      <div class="a"><div class="k">Category</div><div class="v" style="color:${cat.color}">${cat.label}</div></div>
      <div class="a"><div class="k">Severity</div><div class="v">${esc(o.severity||'—')}</div></div>
      <div class="a"><div class="k">Field / Location</div><div class="v">${esc(o.field||'—')}</div></div>
      <div class="a"><div class="k">Crop</div><div class="v">${esc(o.crop||'—')}</div></div>
      <div class="a"><div class="k">Product / Hybrid</div><div class="v">${esc(o.product||'—')}</div></div>
      <div class="a"><div class="k">Planting Date</div><div class="v">${esc(o.planting_date||'—')}</div></div>
      <div class="a"><div class="k">Growth Stage</div><div class="v">${esc(o.growth_stage||'—')}</div></div>
      <div class="a"><div class="k">Scouting Date</div><div class="v">${esc(o.scouting_date||'—')}</div></div>
      <div class="a"><div class="k">Scout</div><div class="v">${esc(o.scout||'—')}</div></div>
      <div class="a"><div class="k">GPS</div><div class="v">${gpsStr(o)||'—'}</div></div>
      <div class="a"><div class="k">Weather</div><div class="v">${esc(o.weather||'—')}</div></div>
      <div class="a"><div class="k">Accumulated GDU/GDD</div><div class="v">${o.gdd!=null?esc(String(o.gdd)):'—'}</div></div>
      <div class="a"><div class="k">Rainfall (7d, in)</div><div class="v">${esc(o.rain_7d||'—')}</div></div>
    </div>
    <div><label style="margin-bottom:8px">Agronomic Notes &amp; Training Points</label>
      <div class="det-notes">${esc(o.notes||'No notes.')}</div></div>`;
  document.getElementById('v_foot').innerHTML=isAdmin
    ?`<button class="btn secondary" onclick="closeView();editObs('${o.id}')">Edit</button>
      <button class="btn danger" onclick="closeView();delObs('${o.id}')">Delete</button>
      <button class="btn" onclick="closeView()">Close</button>`
    :`<button class="btn" onclick="closeView()">Close</button>`;
  document.getElementById('viewOverlay').classList.add('show');
}
function closeView(){ document.getElementById('viewOverlay').classList.remove('show'); }
function zoom(src){ document.getElementById('imgModalImg').src=src; document.getElementById('imgModal').classList.add('show'); }
function gpsStr(o){ return (o.gps_lat!=null&&o.gps_lng!=null)?`${o.gps_lat}, ${o.gps_lng}`:''; }

/* =====================================================================
   FORM  (admin only)
   ===================================================================== */
function openForm(){
  if(!isAdmin){ toast('Administrator access required.'); openLogin(); return; }
  editingId=null; pendingPhotos=[];
  document.getElementById('formTitle').textContent='New Observation';
  ['f_title','f_field','f_crop','f_product','f_planting','f_stage','f_gps','f_weather','f_gdd','f_rain','f_notes'].forEach(i=>document.getElementById(i).value='');
  document.getElementById('f_category').value=activeCat;
  document.getElementById('f_severity').value='Low';
  document.getElementById('f_scout').value=CFG.ADMIN_DISPLAY_NAME||'';
  document.getElementById('f_date').value=new Date().toISOString().slice(0,10);
  renderThumbs(); document.getElementById('formOverlay').classList.add('show');
}
function editObs(id){
  if(!isAdmin){ toast('Administrator access required.'); return; }
  const o=observations.find(x=>x.id===id); if(!o) return;
  editingId=id;
  pendingPhotos=(o.photos||[]).map(p=>({url:p.url, existingPath:p.storage_path}));
  document.getElementById('formTitle').textContent='Edit Observation';
  document.getElementById('f_title').value=o.title||'';
  document.getElementById('f_category').value=o.category;
  document.getElementById('f_severity').value=o.severity||'Low';
  document.getElementById('f_field').value=o.field||'';
  document.getElementById('f_crop').value=o.crop||'';
  document.getElementById('f_product').value=o.product||'';
  document.getElementById('f_planting').value=o.planting_date||'';
  document.getElementById('f_stage').value=o.growth_stage||'';
  document.getElementById('f_date').value=o.scouting_date||'';
  document.getElementById('f_scout').value=o.scout||'';
  document.getElementById('f_gps').value=gpsStr(o);
  document.getElementById('f_weather').value=o.weather||'';
  document.getElementById('f_gdd').value=(o.gdd!=null)?o.gdd:'';
  document.getElementById('f_rain').value=o.rain_7d||'';
  document.getElementById('f_notes').value=o.notes||'';
  renderThumbs(); document.getElementById('formOverlay').classList.add('show');
}
function closeForm(){ document.getElementById('formOverlay').classList.remove('show'); }

function handleFiles(e){
  [...e.target.files].forEach(file=>{
    pendingPhotos.push({file, url:URL.createObjectURL(file)});
  });
  renderThumbs(); e.target.value='';
}
function renderThumbs(){
  document.getElementById('thumbs').innerHTML=pendingPhotos.map((p,i)=>
    `<div class="thumb"><img src="${p.url}"><div class="rm" onclick="removePhoto(${i})">×</div></div>`).join('');
}
function removePhoto(i){ pendingPhotos.splice(i,1); renderThumbs(); }

function parseGps(s){
  if(!s) return {lat:null,lng:null};
  const m=s.split(',').map(x=>parseFloat(x.trim()));
  return (m.length===2&&!isNaN(m[0])&&!isNaN(m[1]))?{lat:m[0],lng:m[1]}:{lat:null,lng:null};
}

function buildRecordFromForm(){
  const gps=parseGps(document.getElementById('f_gps').value.trim());
  const gddVal=document.getElementById('f_gdd').value.trim();
  return {
    category:document.getElementById('f_category').value,
    title:document.getElementById('f_title').value.trim(),
    severity:document.getElementById('f_severity').value,
    field:val('f_field'), crop:val('f_crop'), product:val('f_product'),
    planting_date:val('f_planting')||null,
    growth_stage:val('f_stage'),
    scouting_date:val('f_date')||null,
    scout:val('f_scout'),
    gps_lat:gps.lat, gps_lng:gps.lng,
    weather:val('f_weather'),
    gdd:gddVal===''?null:Number(gddVal),
    rain_7d:val('f_rain'),
    notes:val('f_notes'),
  };
}

// Upload one File: generates a 320px thumbnail + a 1600px-capped main image,
// stores both in Storage and inserts the photos row with thumb_path.
async function uploadPhoto(obsId, file, order){
  const base=`${obsId}/${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const mainBlob=await FS_OFFLINE.downscaleMain(file);
  const thumbBlob=await FS_OFFLINE.makeThumbnail(file);
  const mainPath=`${base}.jpg`;
  const thumbPath=`${base}_thumb.jpg`;
  let upd=await sb.storage.from(CFG.PHOTO_BUCKET).upload(mainPath,mainBlob,{cacheControl:'3600',contentType:'image/jpeg',upsert:false});
  if(upd.error) throw upd.error;
  let upt=await sb.storage.from(CFG.PHOTO_BUCKET).upload(thumbPath,thumbBlob,{cacheControl:'3600',contentType:'image/jpeg',upsert:false});
  if(upt.error) throw upt.error;
  const { error:metaErr }=await sb.from('photos')
    .insert({observation_id:obsId, storage_path:mainPath, thumb_path:thumbPath, sort_order:order});
  if(metaErr) throw metaErr;
}

async function saveObservation(){
  if(!isAdmin){ toast('Administrator access required.'); return; }
  const title=document.getElementById('f_title').value.trim();
  if(!title){ toast('Please enter a title.'); return; }
  const btn=document.getElementById('saveBtn'); btn.disabled=true; btn.textContent='Saving…';
  const rec=buildRecordFromForm();
  const newFiles=pendingPhotos.filter(p=>p.file).map(p=>p.file);

  // ---- OFFLINE PATH: queue a NEW observation in IndexedDB ----
  // (Edits require the existing cloud row, so they are blocked while offline.)
  if(!navigator.onLine){
    if(editingId){ toast('Editing requires a connection. Try again when online.'); btn.disabled=false; btn.textContent='Save Observation'; return; }
    try{
      await FS_OFFLINE.queueAdd({ rec, photos:newFiles, createdBy: session.user.id });
      toast('Saved offline — will sync when back online.');
      activeCat=rec.category; closeForm(); await refreshPendingBadge();
    }catch(err){ toast('Offline save failed: '+(err.message||err)); }
    finally{ btn.disabled=false; btn.textContent='Save Observation'; }
    return;
  }

  // ---- ONLINE PATH ----
  try{
    let obsId=editingId;
    if(editingId){
      const { error }=await sb.from('observations').update(rec).eq('id',editingId);
      if(error) throw error;
    }else{
      rec.created_by=session.user.id;
      const { data, error }=await sb.from('observations').insert(rec).select('id').single();
      if(error) throw error;
      obsId=data.id;
    }
    // delete removed existing photos (and their thumbnails)
    if(editingId){
      const kept=pendingPhotos.filter(p=>p.existingPath).map(p=>p.existingPath);
      const origPhotos=(observations.find(o=>o.id===editingId)?.photos||[]);
      const removed=origPhotos.filter(p=>!kept.includes(p.storage_path));
      const paths=[]; removed.forEach(p=>{ paths.push(p.storage_path); if(p.thumb_path) paths.push(p.thumb_path); });
      if(paths.length){
        await sb.storage.from(CFG.PHOTO_BUCKET).remove(paths);
        await sb.from('photos').delete().in('storage_path',removed.map(p=>p.storage_path));
      }
    }
    // upload new files (thumbnail + main)
    let order=0;
    for(const p of pendingPhotos){ if(p.file){ await uploadPhoto(obsId,p.file,order); } order++; }
    toast(editingId?'Observation updated.':'Observation added.');
    activeCat=rec.category; closeForm();
    await loadObservations();
  }catch(err){
    toast('Save failed: '+(err.message||err));
  }finally{
    btn.disabled=false; btn.textContent='Save Observation';
  }
}
}
function val(id){ return document.getElementById(id).value.trim(); }

async function delObs(id){
  if(!isAdmin){ toast('Administrator access required.'); return; }
  if(!confirm('Delete this observation? This cannot be undone.')) return;
  const o=observations.find(x=>x.id===id);
  const o=observations.find(x=>x.id===id);
  const paths=[]; (o?.photos||[]).forEach(p=>{ paths.push(p.storage_path); if(p.thumb_path) paths.push(p.thumb_path); });
  const { error }=await sb.from('observations').delete().eq('id',id); // photos cascade
  if(error){ toast('Delete failed: '+error.message); return; }
  toast('Observation deleted.'); await loadObservations();
}

/* =====================================================================
   MAP VIEW
   ===================================================================== */
let mapInstance=null;
function openMap(){
  document.getElementById('mapOverlay').classList.add('show');
  const pts=observations.filter(o=>o.gps_lat!=null&&o.gps_lng!=null);
  document.getElementById('mapLegend').innerHTML=CATEGORIES.map(c=>
    `<span style="display:flex;align-items:center;gap:6px"><span style="width:12px;height:12px;border-radius:50%;background:${c.color};display:inline-block"></span>${c.label}</span>`).join('');
  if(pts.length===0){
    document.getElementById('map').style.display='none';
    document.getElementById('mapEmpty').style.display='block'; return;
  }
  document.getElementById('map').style.display='block';
  document.getElementById('mapEmpty').style.display='none';
  setTimeout(()=>{
    if(!mapInstance){
      mapInstance=L.map('map');
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(mapInstance);
    }else{
      mapInstance.eachLayer(l=>{ if(l instanceof L.CircleMarker) mapInstance.removeLayer(l); });
    }
    const group=[];
    pts.forEach(o=>{
      const c=catById(o.category), ll=[o.gps_lat,o.gps_lng];
      L.circleMarker(ll,{radius:9,color:'#fff',weight:2,fillColor:c.color,fillOpacity:.95}).addTo(mapInstance)
        .bindPopup(`<b>${esc(o.title)}</b><br>${c.label} · ${esc(o.severity||'')}<br>${esc(o.field||'')} · ${esc(o.growth_stage||'')}<br><a href="#" onclick="closeMap();viewObs('${o.id}');return false;">View details</a>`);
      group.push(ll);
    });
    mapInstance.fitBounds(group,{padding:[40,40],maxZoom:14});
    mapInstance.invalidateSize();
  },150);
}
function closeMap(){ document.getElementById('mapOverlay').classList.remove('show'); }

/* =====================================================================
   PDF HANDOUT EXPORT
   ===================================================================== */
async function fetchAsDataURL(url){
  try{
    const res=await fetch(url); const blob=await res.blob();
    return await new Promise(r=>{ const fr=new FileReader(); fr.onload=()=>r(fr.result); fr.readAsDataURL(blob); });
  }catch(e){ return null; }
}
async function exportPDF(){
  const cat=catById(activeCat);
  const q=(document.getElementById('search').value||'').toLowerCase();
  let list=observations.filter(o=>o.category===activeCat);
  if(q) list=list.filter(o=>((o.title||'')+(o.notes||'')+(o.field||'')+(o.crop||'')+(o.product||'')+(o.growth_stage||'')+(o.scout||'')).toLowerCase().includes(q));
  if(list.length===0){ toast('No observations to export in this tab.'); return; }
  toast('Building handout…');
  const { jsPDF }=window.jspdf;
  const doc=new jsPDF({unit:'pt',format:'letter'});
  const W=doc.internal.pageSize.getWidth(), H=doc.internal.pageSize.getHeight(); const M=48; let y=M;
  const rgb=h=>{h=h.replace('#','');return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];};
  function header(){
    const c=rgb('#005f2f'); doc.setFillColor(...c); doc.rect(0,0,W,70,'F');
    const g=rgb('#f5c400'); doc.setFillColor(...g); doc.rect(0,70,W,4,'F'); // gold accent bar
    doc.setTextColor(255); doc.setFont('helvetica','bold'); doc.setFontSize(18);
    doc.text('Pioneer\u00ae Field Scout: Indiana \u2014 Training Handout',M,32);
    doc.setFont('helvetica','normal'); doc.setFontSize(11);
    doc.text(`${cat.label} observations · Generated ${new Date().toLocaleDateString()} · ${list.length} item(s)`,M,52);
    doc.setTextColor(40); y=92;
  }
  function ensure(h){ if(y+h>H-M){ doc.addPage(); y=M; } }
  header();
  for(let idx=0;idx<list.length;idx++){
    const o=list[idx]; ensure(150); const cc=rgb(cat.color);
    doc.setFillColor(...cc); doc.roundedRect(M,y,6,18,2,2,'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(20);
    doc.text(`${idx+1}. ${o.title||'Untitled'}`,M+14,y+14); y+=26;
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(...cc);
    doc.text(`${cat.label.toUpperCase()} · SEVERITY: ${(o.severity||'—').toUpperCase()}`,M+14,y); y+=16;
    doc.setTextColor(70); doc.setFontSize(10); doc.setFont('helvetica','normal');
    const attrs=[['Field',o.field],['Crop',o.crop],['Product/Hybrid',o.product],['Planting Date',o.planting_date],
      ['Growth Stage',o.growth_stage],['Scouting Date',o.scouting_date],['Scout',o.scout],['GPS',gpsStr(o)],
      ['Weather',o.weather],['GDU/GDD',o.gdd],['Rainfall 7d (in)',o.rain_7d]].filter(a=>a[1]!=null&&a[1]!=='');
    const colW=(W-2*M-14)/2;
    for(let i=0;i<attrs.length;i+=2){
      ensure(16); const l=attrs[i],r=attrs[i+1];
      doc.setFont('helvetica','bold'); doc.text(`${l[0]}: `,M+14,y);
      const lw=doc.getTextWidth(`${l[0]}: `); doc.setFont('helvetica','normal'); doc.text(String(l[1]),M+14+lw,y);
      if(r){ doc.setFont('helvetica','bold'); doc.text(`${r[0]}: `,M+14+colW,y);
        const rw=doc.getTextWidth(`${r[0]}: `); doc.setFont('helvetica','normal'); doc.text(String(r[1]),M+14+colW+rw,y); }
      y+=15;
    }
    if(o.notes){
      y+=4; ensure(30); doc.setFont('helvetica','bold'); doc.setTextColor(40);
      doc.text('Agronomic Notes & Training Points:',M+14,y); y+=14;
      doc.setFont('helvetica','normal'); doc.setTextColor(60);
      doc.splitTextToSize(o.notes,W-2*M-14).forEach(ln=>{ ensure(14); doc.text(ln,M+14,y); y+=13; });
    }
    if(o.photos&&o.photos.length){
      y+=6; let x=M+14; const ph=80,pw=80; ensure(ph+10);
      for(const p of o.photos.slice(0,4)){
        const d=await fetchAsDataURL(p.url);
        if(d){ try{ doc.addImage(d,x,y,pw,ph); }catch(e){} }
        x+=pw+8; if(x+pw>W-M){ x=M+14; }
      }
      y+=ph+6;
    }
    y+=10; ensure(6); doc.setDrawColor(220); doc.line(M,y,W-M,y); y+=14;
  }
  const pages=doc.internal.getNumberOfPages();
    doc.text(`Pioneer\u00ae Field Scout: Indiana training handout \u2014 page ${i} of ${pages}`,M,H-20); }
    doc.text(`Pioneer\u00ae Field Scout training handout \u2014 page ${i} of ${pages}`,M,H-20); }
  doc.save(`FieldScout_${cat.label.replace(/\s+/g,'')}_Handout.pdf`);
  toast('Handout exported.');
}

/* =====================================================================
   UTIL + INIT
   ===================================================================== */
function esc(s){ return (s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
let toastTimer;
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),2800); }
function hideLoading(){ document.getElementById('loading').style.display='none'; }

/* =====================================================================
   OFFLINE: network status, pending badge, and sync of the queue
   ===================================================================== */
function updateNetBadge(){
  const el=document.getElementById('netBadge');
  if(navigator.onLine){ el.textContent='🟢 Online'; el.classList.remove('active'); }
  else{ el.textContent='🔴 Offline'; el.classList.add('active'); }
}
async function refreshPendingBadge(){
  const n=await FS_OFFLINE.queueCount();
  const el=document.getElementById('pendingBadge');
  if(n>0){ el.style.display='flex'; el.textContent=`⏳ ${n} pending`; }
  else{ el.style.display='none'; }
}
let syncing=false;
async function syncPending(){
  if(syncing) return;
  if(!navigator.onLine){ toast('Still offline — will sync automatically when reconnected.'); return; }
  if(!session||!isAdmin){ return; }
  const queue=await FS_OFFLINE.queueAll();
  if(queue.length===0) return;
  syncing=true; toast(`Syncing ${queue.length} offline observation(s)…`);
  let ok=0;
  for(const item of queue){
    try{
      const rec={...item.rec, created_by:item.createdBy};
      const { data, error }=await sb.from('observations').insert(rec).select('id').single();
      if(error) throw error;
      const obsId=data.id;
      let order=0;
      for(const file of (item.photos||[])){ await uploadPhoto(obsId,file,order); order++; }
      await FS_OFFLINE.queueRemove(item.localId); ok++;
    }catch(err){ console.warn('Sync failed for one item:',err); }
  }
  syncing=false;
  await refreshPendingBadge();
  if(ok>0){ toast(`Synced ${ok} observation(s).`); await loadObservations(); }
}

window.addEventListener('online', ()=>{ updateNetBadge(); syncPending(); });
window.addEventListener('offline', updateNetBadge);
(function start(){
  if(!CFG || CFG.SUPABASE_URL.includes('YOUR-PROJECT')){
    document.getElementById('loadingText').innerHTML=
      '⚠️ Not configured.<br><span style="font-size:13px">Edit <b>config.js</b> with your Supabase URL and anon key (see README.md).</span>';
    document.querySelector('#loading .spinner').style.display='none';
    return;
  }
  updateNetBadge();
  refreshPendingBadge();
  initAuth();
})();