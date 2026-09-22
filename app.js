'use strict';
/* Saviano Express • GitHub Pages + Supabase RPC. Tutte le decisioni di permesso e
   tutti i tempi ufficiali sono assegnati e verificati dal backend. */
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = value => { if(value == null || !Number.isFinite(Number(value))) return '—';
  const ms=Number(value), neg=ms<0; let sec=Math.floor(Math.abs(ms)/1000);
  const hours=Math.floor(sec/3600);sec%=3600;
  return (neg?'−':'')+(hours?String(hours).padStart(2,'0')+':':'')+String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');
};
const datefmt=value=>value?new Date(value).toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
const cfg = window.SAVIANO_CONFIG || {};
const configured = !!(cfg.supabaseUrl && /^https:\/\/[\w.-]+\.supabase\.co\/?$/.test(cfg.supabaseUrl)
  && cfg.publishableKey && /^(sb_publishable_|eyJ)/.test(cfg.publishableKey));
const client = configured && window.supabase ? window.supabase.createClient(cfg.supabaseUrl,cfg.publishableKey,{auth:{persistSession:false,autoRefreshToken:false}}) : null;
const TOKEN_KEY='sx-session-v2';
let token=sessionStorage.getItem(TOKEN_KEY)||null, state=null, selected=null, stage=1;
let map=null, mapMarkers=[], polling=false, writing=false, clockDelta=0, timer=null;
let gpsWatch=null, gpsBeat=null, gpsPosition=null, gpsSending=false, lastGpsSent=0, gpsPublic=false;
let displayedCodes=null, rotatedCodes=null, editorDraft=null, lastEditorStage=null, lastErrorTime=0;
function toast(message){const el=$('toast');el.textContent=String(message);el.classList.remove('hide');clearTimeout(timer);timer=setTimeout(()=>el.classList.add('hide'),4200)}
function now(){return Date.now()+clockDelta}
function role(){return state?.role||'public'}
function own(){return state?.teamId||null}
function admin(){return role()==='admin'}
function isRunner(){return role()==='team'||role()==='commissioner'}
function canWriteTeam(t){return admin()||((isRunner())&&t?.id===own())}
function canVerify(t){return admin()||(role()==='commissioner'&&t?.id===own())}
function thisTeam(){return state?.teams.find(t=>t.id===selected)||null}
function step(p,n){return p?.stages?.[n-1]||null}
function stageInfo(n){return state?.stages[n-1]||null}
function completed(t){return t.stages.filter(s=>s.verified).length}
function total(t){return t.stages.reduce((a,s)=>a+(s.verified?Number(s.correctedMs||0):0),0)}
function stateStage(t,n){const p=step(t,n),s=stageInfo(n); if(!p||!s)return 'locked';
  if(p.verified)return 'complete';if(p.startedAt)return 'active';
  if(!s.released)return 'locked';if(n>1&&!step(t,n-1)?.verified)return 'wait';
  if(n===5&&(!p.finalReadyAt||now()<Date.parse(p.finalReadyAt)))return 'wait';
  return 'ready';
}
async function call(name,args){if(!client)throw new Error('Configura prima Supabase come indicato nel README.');
  const {data,error}=await client.rpc(name,args);if(error)throw new Error(error.message||'Errore di comunicazione');return data;
}
function banner(message,kind=''){const b=$('system-banner');b.textContent=message;b.className='notice '+(kind?'banner-'+kind:'')}
async function refresh({quiet=false}={}){
  if(!client){banner('Sito pronto per la pubblicazione: manca il collegamento al database Supabase. Segui README.md per attivare la gara. Puoi continuare a provare la versione demo.','warn');
    $('system-banner').innerHTML += ' <a href="./demo.html">Apri la demo locale →</a>';return;}
  if(polling||writing)return;polling=true;
  try{
    const next=await call('sx_state',{p_token:token});
    if(token&&next.role==='public'){token=null;sessionStorage.removeItem(TOKEN_KEY);toast('Sessione scaduta: effettua nuovamente l’accesso.');stopGpsLocal();}
    clockDelta=Date.parse(next.serverNow)-Date.now();state=next;
    if(isRunner())selected=own();else if(!state.teams.some(t=>t.id===selected))selected=state.teams[0]?.id||null;
    if(!Number.isInteger(stage)||stage<1||stage>5)stage=1;
    render();banner('● Gara sincronizzata · ultimo aggiornamento '+new Date().toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit',second:'2-digit'}),'ok');
    $('live-badge').textContent='● Sincronizzato';
  } catch(e){if(!quiet||Date.now()-lastErrorTime>30000){toast('Sincronizzazione: '+e.message);lastErrorTime=Date.now()}
    banner('Connessione non disponibile. I dati sullo schermo potrebbero non essere aggiornati. Riprova quando torna la rete.','warn');$('live-badge').textContent='● Connessione assente';
  } finally{polling=false}
}
async function action(name,payload={},msg='Operazione completata'){
  if(writing){toast('Attendi il completamento dell’operazione precedente.');return null;}writing=true;document.body.classList.add('writing');
  try{const result=await call('sx_action',{p_token:token,p_action:name,p_payload:payload});
    if(msg)toast(msg);return result;
  }catch(e){toast('Operazione non eseguita: '+e.message);return null}
  finally{writing=false;document.body.classList.remove('writing');await refresh()}
}
function showLogin(){const open=$('access-section').hidden;$('access-section').hidden=!open;if(open)$('access-code').focus();else $('access-code').value=''}
async function login(e){e.preventDefault();const b=$('login-form').querySelector('button');b.disabled=true;
  try{const data=await call('sx_login',{p_code:$('access-code').value.trim()});token=data.token;
    sessionStorage.setItem(TOKEN_KEY,token);$('access-code').value='';$('access-section').hidden=true;
    stage=1;selected=data.teamId||null;toast('Accesso effettuato: '+({admin:'Regia',commissioner:'Commissario',team:'Squadra'}[data.role]||data.role));await refresh();
  }catch(err){toast('Accesso non riuscito: '+err.message)}finally{b.disabled=false}
}
async function logout(){if(gpsWatch!==null)await stopGps();token=null;sessionStorage.removeItem(TOKEN_KEY);selected=null;stage=1;displayedCodes=null;rotatedCodes=null;await refresh();toast('Hai effettuato l’uscita.')}
function render(){if(!state)return;
  $('role-badge').textContent=({admin:'Regia',commissioner:'Commissario',team:'Squadra',public:'Pubblico'})[role()];
  $('access-button').hidden=role()!=='public';$('logout-button').hidden=role()==='public';
  $('nav-regia').hidden=!(admin()||role()==='commissioner');$('regia').hidden=role()==='public'||role()==='team';
  $('hero-teams').textContent=state.teams.length.toString().padStart(2,'0');
  const select=$('teamSelect');const previously=select.value;
  select.innerHTML=state.teams.map(t=>`<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')||'<option>Nessuna squadra iscritta</option>';
  select.disabled=isRunner()||!state.teams.length;select.value=selected||previously;
  $('path-sub').textContent=isRunner()?'Segui il percorso della tua squadra: indizi e oggetti sono visibili quando la prova viene avviata.':
    admin()?'Seleziona una squadra e una tappa per seguire la gara e gestire gli indovinelli.':'Segui le tappe già pubblicate e scopri quando verranno svelati gli altri indovinelli.';
  const t=thisTeam();renderSteps(t);renderStats(t);renderClue(t);renderObjects(t);renderLeaderboard();renderGpsPanel(t);renderMap();if(admin()||role()==='commissioner')renderOps(t);
}
function renderSteps(t){$('steps').innerHTML=(state.stages||[]).map(s=>{
 const status=t?stateStage(t,s.number):'locked',title=s.visible?s.title:(s.number===5?'Il tesoro':'Indovinello '+s.number);
 const label={complete:'Completata',active:'In corso',ready:'Pronta',wait:'In attesa',locked:'Bloccata'}[status];
 return `<button class="step ${status} ${s.number===5?'final':''} ${s.number===stage?'active-step':''}" data-stage="${s.number}" aria-current="${s.number===stage?'step':'false'}"><span class="step-label">${esc(label)} · TAPPA ${s.number}</span><span class="step-number">${s.number===5?'✕':String(s.number).padStart(2,'0')}</span><h3>${esc(title)}</h3><small>${status==='complete'?'Tempo convalidato':status==='active'?'Prova attualmente in corso':status==='ready'?'Attende il via del commissario':s.published?'Indovinello pubblicato':'Un nuovo indizio ti attende'}</small></button>`;}).join('')}
function renderStats(t){const p=step(t,stage),s=stageInfo(stage);const st=t?stateStage(t,stage):'locked';
 const objects=(p?.checked||[]).filter(Boolean).length;
 const live=p?.startedAt&&!p?.verified?Math.max(0,now()-Date.parse(p.startedAt)):p?.elapsedMs;
 const correction=(s?.objects?.length||0)-objects*2;
 const hints=p?.hints||[];const min=correction*5+(hints[0]?15:0)+(hints[1]?20:0);
 const cells=[['Tappe concluse',t?completed(t)+' / 5':'—'],['Tempo cumulato',t&&completed(t)?fmt(total(t)):'—'],['Oggetti dichiarati',canWriteTeam(t)&&p?.startedAt?objects+' / '+s.objects.length:'—'],['Tempo della prova',p?.verified?fmt(p.correctedMs):st==='active'?fmt(live+min*60000):'—']];
 $('stats').innerHTML=cells.map(([label,val],i)=>`<div class="stat-card"><span>${esc(label)}</span><strong ${i===3?'class="live-timer"':''}>${esc(val)}</strong></div>`).join('');}
function renderClue(t){const s=stageInfo(stage),p=step(t,stage),status=t?stateStage(t,stage):'locked';if(!s)return;
 let body=`<div class="row"><h3>${esc(s.title)}</h3><span class="tag ${status==='active'?'orange':''}">${({complete:'Conclusa',active:'In corso',ready:'Pronta',wait:'In attesa',locked:'Bloccata'})[status]}</span></div>`;
 if(s.clue!==null&&s.visible){body+=`<div class="riddle">${esc(s.clue||'Il testo ufficiale non è ancora stato caricato.')}</div>`}
 else body+='<div class="riddle placeholder">🔒 L’indovinello comparirà quando la tua squadra avvia la prova o, per il pubblico, dopo la pubblicazione prevista.</div>';
 if(p?.startedAt){body+=`<div class="meta-grid"><div class="meta"><small>Avvio</small><strong>${datefmt(p.startedAt)}</strong></div><div class="meta"><small>${p.verified?'Tempo ufficiale':'Cronometro'}</small><strong class="live-timer">${p.verified?fmt(p.correctedMs):fmt(now()-Date.parse(p.startedAt))}</strong></div></div>`}
 if(status==='ready'&&canVerify(t))body+=`<div class="actions"><button class="btn dark" data-act="start" data-stage="${stage}">Avvia la prova per ${esc(t.name)}</button></div>`;
 if(stage===5&&p?.finalReadyAt&&!p.startedAt)body+=`<div class="status-note">Partenza assegnata: <b>${datefmt(p.finalReadyAt)}</b>. Il pulsante del commissario sarà disponibile soltanto dopo quell'orario.</div>`;
 if(status==='active'&&canWriteTeam(t)){
  const elapsed=now()-Date.parse(p.startedAt);body+=`<div class="divider"></div><div class="row"><h3>Aiuti all'indovinello</h3><span class="tag orange">+15 / +20 min</span></div><p class="info-line">Gli aiuti sono disponibili dopo 25 e 50 minuti dall'avvio. Solo il commissario può concederli e registrare il malus.</p><div class="actions">`;
  [0,1].forEach(i=>{const needed=(i===0?25:50)*60000;const label=(i===0?'Primo':'Secondo')+' aiuto';const requested=p.requested?.[i],granted=p.hints?.[i];
   if(granted)body+=`<span class="tag">${label} concesso</span>`;
   else if(!requested)body+=`<button class="btn ghost small" data-act="request_hint" data-hint="${i}" ${elapsed<needed?'disabled':''}>${label} ${elapsed<needed?'· tra '+Math.ceil((needed-elapsed)/60000)+' min':''}</button>`;
   else if(canVerify(t))body+=`<button class="btn dark small" data-act="grant_hint" data-hint="${i}">Concedi ${label.toLowerCase()}</button>`;
   else body+=`<span class="tag warning">${label} richiesto · attesa commissario</span>`;
  });body+='</div>';
  if(canVerify(t))body+=`<div class="divider"></div><button class="btn dark" data-act="verify">Convalida oggetti e chiudi la tappa</button>`;
 }
 $('clue-card').innerHTML=body;
}
function renderObjects(t){const s=stageInfo(stage),p=step(t,stage),ownWritable=canWriteTeam(t)&&p?.startedAt&&!p?.verified;
 let html=`<div class="row"><h3>Oggetti da recuperare</h3><span class="tag orange">${Array.isArray(p?.checked)?p.checked.filter(Boolean).length+'/'+s.objects.length:s.objects.length+' disponibili'}</span></div>`;
 if(!s.visible||!s.objects?.length)html+=`<p class="status-note">${s.visible?'Nessuna lista di oggetti prevista per questa tappa.':'La lista comparirà alla pubblicazione della prova.'}</p>`;
 else {
  html+=`<p class="info-line">${ownWritable?'Spunta gli oggetti trovati. Il commissario verifica e convalida il risultato finale.':'Gli oggetti vengono pubblicati insieme all’indovinello. Le selezioni sono modificabili solo dalla squadra durante la prova.'}</p>`;
  const count=(p?.checked||[]).filter(Boolean).length;
  html+=`<div class="progress"><i style="width:${100*count/s.objects.length}%"></i></div><div class="objects">`;
  html+=s.objects.map((obj,i)=>{const checked=!!p?.checked?.[i];return `<button class="object ${checked?'checked':''}" data-act="check" data-index="${i}" ${!ownWritable?'disabled':''}><span class="tick">${checked?'✓':''}</span><span>${esc(obj)}</span>${checked?'<span class="pill">−5 min</span>':''}</button>`}).join('')+'</div>';
  if(Array.isArray(p?.checked)){
   const hint=(p.hints?.[0]?15:0)+(p.hints?.[1]?20:0),bonus=count*5,malus=(s.objects.length-count)*5;
   html+=`<div class="totals"><div class="calc-row"><span>Bonus oggetti</span><strong>−${bonus} min</strong></div><div class="calc-row"><span>Malus mancanti (alla chiusura)</span><strong>+${malus} min</strong></div><div class="calc-row"><span>Aiuti concessi</span><strong>+${hint} min</strong></div><div class="calc-row total"><span>Correzione del tempo</span><strong>${malus+hint-bonus>=0?'+':''}${malus+hint-bonus} min</strong></div></div>`;
  }
 }
 $('objects-card').innerHTML=html;
}
function renderLeaderboard(){const sorted=[...state.teams].sort((a,b)=>completed(b)-completed(a)||total(a)-total(b)||a.name.localeCompare(b.name));
 $('leaderboard').innerHTML=sorted.map((t,i)=>{const running=t.stages.findIndex(p=>p.startedAt&&!p.verified);
 return `<tr><td class="rank">${i+1}</td><td><span class="team-dot" style="background:${esc(t.color)}"></span><strong>${esc(t.name)}</strong></td><td>${completed(t)} / 5</td><td><strong>${completed(t)?fmt(total(t)):'—'}</strong></td><td>${running>=0?'Tappa '+(running+1)+' · in corso':completed(t)===5?'Percorso completato':'In attesa'}</td></tr>`}).join('')||'<tr><td colspan="5">Le squadre compariranno quando la regia le avrà registrate.</td></tr>';
}
function mapInit(){if(map||!window.L)return;map=window.L.map('map',{scrollWheelZoom:false}).setView([40.906,14.510],14);
 window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
 setTimeout(()=>map.invalidateSize(),150);
}
function renderMap(){mapInit();if(!map)return;for(const marker of mapMarkers)map.removeLayer(marker);mapMarkers=[];
 const visible=state.teams.filter(t=>t.gps);
 $('map-legend').innerHTML=state.teams.map(t=>`<span><span class="team-dot" style="background:${esc(t.color)}"></span>${esc(t.name)} · ${t.gps?t.gps.approximate?'Posizione approssimata':'GPS attivo':'Nessuna posizione condivisa'}</span>`).join('')||'<span>Le squadre compariranno sulla mappa quando attiveranno la condivisione.</span>';
 for(const t of visible){const g=t.gps;const ic=window.L.divIcon({className:'',html:`<div class="leader-icon" style="background:${esc(t.color)}"></div>`,iconSize:[24,24],iconAnchor:[12,12]});
 const marker=window.L.marker([g.lat,g.lng],{icon:ic}).addTo(map).bindPopup(`<strong>${esc(t.name)}</strong><br>${g.approximate?'Posizione approssimata':'Posizione GPS'} · ${datefmt(g.updatedAt)}`);mapMarkers.push(marker);}
}
function renderGpsPanel(t){const allowed=isRunner();const mine=allowed?state.teams.find(x=>x.id===own()):null;
 $('gps-badge').textContent=gpsWatch!==null?'● Condivisione GPS attiva':visibleGpsText();
 if(!allowed){$('gps-panel').innerHTML=`<h3>Posizione delle squadre</h3><p class="info-line">${admin()?'Le posizioni esatte, se condivise, sono visibili qui alla regia. I telefoni devono rimanere accesi con il sito aperto.':'Il pubblico vede solo le posizioni approssimate condivise volontariamente, dopo 30 minuti dalla tappa in corso e mai durante la prova finale.'}</p><div class="status-note">Al momento sono visibili ${state.teams.filter(x=>x.gps).length} squadre su ${state.teams.length}.</div>`;return;}
 const current=mine?.gps;
 $('gps-panel').innerHTML=`<h3>Condivisione GPS</h3><p class="info-line">Attiva la posizione <b>soltanto con il consenso della persona che porta il telefono</b>. Il GPS preciso viene mostrato alla regia e a questa squadra. Sul sito pubblico la posizione rimane nascosta, a meno che tu non scelga di mostrarne una versione approssimata.</p>
 <div class="status-note ${gpsWatch!==null?'green':''}">${gpsWatch!==null?'● Rilevamento attivo su questo dispositivo':'○ Rilevamento spento su questo dispositivo'}<br>Ultimo GPS ricevuto dal server: ${datefmt(current?.updatedAt)}</div>
 <label class="toggle-row"><input type="checkbox" id="gps-public" ${gpsPublic?'checked':''}><span>Acconsento anche alla pubblicazione di una posizione <b>approssimata</b> (non durante la finale). Questa scelta può rivelare la zona della squadra agli spettatori.</span></label>
 <div class="actions"><button class="btn dark small" id="gps-start" ${gpsWatch!==null?'disabled':''}>⌖ Condividi la posizione</button><button class="btn ghost small" id="gps-stop" ${gpsWatch===null&&!current?'disabled':''}>Interrompi e cancella GPS</button></div>
 <p class="gps-legend-info">Il browser richiede HTTPS e l'autorizzazione GPS. La condivisione si interrompe se chiudi la pagina o il sistema sospende la geolocalizzazione. Non usare questa mappa per situazioni di emergenza.</p>`;
}
function visibleGpsText(){return thisTeam()?.gps?'● GPS visibile':'GPS spento'}
function stopGpsLocal(){if(gpsWatch!==null&&navigator.geolocation)navigator.geolocation.clearWatch(gpsWatch);gpsWatch=null;if(gpsBeat!==null)clearInterval(gpsBeat);gpsBeat=null;gpsPosition=null}
async function stopGps(){stopGpsLocal();gpsPublic=false;if(token&&isRunner())await action('gps_stop',{},'Condivisione interrotta. Le coordinate sono state cancellate dal servizio.');else renderGpsPanel(thisTeam())}
async function sendGps(position,force=false){gpsPosition=position;if(gpsWatch===null||!token||!isRunner()||gpsSending)return;
 if(!force&&Date.now()-lastGpsSent<15000)return;gpsSending=true;
 try{await call('sx_action',{p_token:token,p_action:'gps',p_payload:{lat:position.coords.latitude,lng:position.coords.longitude,accuracy:position.coords.accuracy,publicOptIn:gpsPublic}});
  lastGpsSent=Date.now();await refresh({quiet:true});
 }catch(e){toast('Posizione non inviata: '+e.message)}finally{gpsSending=false}
}
function startGps(){if(!isRunner())return;if(!navigator.geolocation||!window.isSecureContext){toast('Per il GPS apri il sito tramite HTTPS su uno smartphone con geolocalizzazione attiva.');return;}
 if(gpsWatch!==null)return;
 gpsWatch=navigator.geolocation.watchPosition(p=>sendGps(p),err=>toast('GPS: '+(err.code===1?'autorizzazione negata':err.message)),{enableHighAccuracy:true,maximumAge:10000,timeout:18000});
 gpsBeat=setInterval(()=>{if(gpsWatch!==null&&navigator.geolocation){navigator.geolocation.getCurrentPosition(p=>sendGps(p,true),()=>{}, {maximumAge:12000,enableHighAccuracy:true,timeout:16000})}},25000);
 renderGpsPanel(thisTeam());toast('Richiesta posizione inviata al browser. Tieni aperta questa pagina durante la gara.');
}
function editorValue(key, fallback){return editorDraft&&lastEditorStage===stage&&editorDraft[key]!==undefined?editorDraft[key]:fallback}
function captureEditor(){if(!admin())return;const ed=$('ops');if(!ed||!ed.querySelector('#stage-title'))return;
 if(lastEditorStage!==stage)return;
 editorDraft={title:$('stage-title').value,clue:$('stage-clue').value,objects:$('stage-objects').value,teamName:$('new-team').value};
}
function renderOps(t){if(!t && role()==='commissioner')return;
 $('ops-title').textContent=admin()?'Pannello di regia':'Pannello del commissario';
 $('ops-sub').textContent=admin()?'Gestisci gli indovinelli, registra le squadre e programma la partenza finale.':'Avvia e convalida le prove della tua squadra; gli orari ufficiali vengono assegnati dal server.';
 const s=stageInfo(stage),p=step(t,stage),status=t?stateStage(t,stage):'locked';
 const ops=$('ops');const hadEditor=ops.querySelector('#stage-title');if(hadEditor&&lastEditorStage===stage)captureEditor();
 let commissioner=`<div class="card"><div class="row"><h3>${esc(t?.name||'Seleziona una squadra')} · Tappa ${stage}</h3><span class="tag ${status==='active'?'orange':''}">${esc(status)}</span></div>`;
 if(t){commissioner+=`<p class="info-line">${p?.verified?'Prova convalidata.':p?.startedAt?'Cronometro in corso. Controlla gli oggetti dichiarati prima di chiudere la prova.':'Apri questa tappa quando la squadra riceve la busta.'}</p>`;
 if(status==='ready')commissioner+=`<button class="btn dark" data-act="start">Avvia il cronometro</button>`;
 if(status==='active')commissioner+=`<button class="btn dark" data-act="verify">Convalida e chiudi la prova</button>`;
 if(status==='complete')commissioner+=`<div class="status-note green">Tempo corretto della prova: <b>${fmt(p.correctedMs)}</b></div>`;
 if(status==='wait'&&stage===5&&p?.finalReadyAt)commissioner+=`<div class="status-note">Partenza della finale: <b>${datefmt(p.finalReadyAt)}</b></div>`;}
 commissioner+='</div>';
 if(!admin()){ops.innerHTML=commissioner;return;}
 const offsets=state.teams.length&&state.teams.every(x=>x.stages.slice(0,4).every(z=>z.verified));
 const hasFinalPlan=state.teams.some(x=>x.stages[4].finalReadyAt);
 const planList=hasFinalPlan?state.teams.map(x=>`<div class="calc-row"><span>${esc(x.name)}</span><strong>${datefmt(x.stages[4].finalReadyAt)}</strong></div>`).join(''):'Convalida le prime quattro prove di tutte le squadre per programmare le partenze.';
 const editingNote=state.teams.some(x=>x.stages[stage-1].startedAt)?'<p class="status-note alert">Questa tappa è già iniziata: contenuti bloccati per garantire parità di condizioni.</p>':'';
 ops.innerHTML=`<div class="ops-grid"><div class="ops-stack">${commissioner}<div class="card editor"><h3>Indovinello ${stage} · Contenuti</h3>${editingNote}<label for="stage-title">Titolo della tappa</label><input id="stage-title" maxlength="90" value="${esc(editorValue('title',s.title))}"><label for="stage-clue">Testo ufficiale dell’indovinello</label><textarea id="stage-clue" maxlength="3000" placeholder="Scrivi qui l'indovinello…">${esc(editorValue('clue',s.clue||''))}</textarea><label for="stage-objects">Oggetti da recuperare · uno per riga</label><textarea id="stage-objects" placeholder="La prima tappa prevede 12 oggetti. Nelle altre: 0 o 12.">${esc(editorValue('objects',s.objects.join('\n')))}</textarea><div class="actions"><button class="btn dark small" id="save-stage">Salva la tappa</button><button class="btn small" id="open-stage" ${s.released?'disabled':''}>${s.released?'Tappa già aperta':'Apri la tappa'}</button></div><div class="divider"></div><div class="row"><p class="info-line">La pubblicazione per gli spettatori scatta automaticamente 30 minuti dopo l'inizio della prima squadra.</p><button class="btn small ghost" id="publish-stage">${s.publicOverride?'Annulla pubblicazione manuale':'Pubblica manualmente'}</button></div></div></div>
 <div class="ops-stack"><div class="card editor"><h3>Registra una squadra</h3><p class="info-line">La regia riceve due codici diversi, uno per la squadra e uno per il commissario. Copiali e consegnali privatamente prima di chiudere questa schermata.</p><label for="new-team">Nome squadra</label><input id="new-team" maxlength="45" placeholder="Es. Gli esploratori" value="${esc(editorValue('teamName',''))}"><button class="btn ghost small" id="add-team">+ Registra squadra</button><div id="generated-codes">${displayedCodes?`<div class="code-box">SQUADRA: ${esc(displayedCodes.name)}\nCODICE SQUADRA: ${esc(displayedCodes.teamCode)}\nCODICE COMMISSARIO: ${esc(displayedCodes.commissionerCode)}</div><button id="copy-codes" class="btn small ghost">Copia i codici</button>`:'<div class="status-note">I codici appena generati vengono mostrati soltanto in questa sessione di regia: custodiscili fuori da GitHub.</div>'}</div></div>
 <div class="card"><h3>Gestione codici di accesso</h3><p class="info-line">Se un codice è stato perso o esposto, rigeneralo qui. Il vecchio codice e le relative sessioni saranno invalidati. Le prove e i risultati resteranno invariati.</p><div class="credentials-list">${state.teams.map(x=>`<div class="credentials-team"><strong>${esc(x.name)}</strong><div class="actions"><button class="btn small ghost" data-rotate-role="team" data-team-id="${esc(x.id)}">Rigenera codice squadra</button><button class="btn small ghost" data-rotate-role="commissioner" data-team-id="${esc(x.id)}">Rigenera codice commissario</button></div></div>`).join('')||'<p class="info-line">Registra una squadra per gestire i suoi accessi.</p>'}</div><div id="rotated-codes">${rotatedCodes?`<div class="code-box">NUOVO CODICE ${rotatedCodes.role==='team'?'SQUADRA':'COMMISSARIO'} · ${esc(rotatedCodes.name)}\n${esc(rotatedCodes.code)}</div><div class="actions"><button class="btn small ghost" id="copy-rotated-code">Copia nuovo codice</button><button class="btn small ghost" id="dismiss-rotated-code">Nascondi codice</button></div>`:'<p class="info-line">Il nuovo codice sarà mostrato solo dopo la rigenerazione. Copialo subito e consegnalo in privato.</p>'}</div></div>
 <div class="card"><h3>Partenze scaglionate · Tappa 5</h3><p class="info-line">I distacchi si calcolano dai tempi corretti delle prime quattro prove. La programmazione assegna gli orari di partenza dalla prima squadra alle successive.</p><div class="totals">${planList}</div><div class="actions"><button class="btn dark small" id="plan-final" ${!offsets||hasFinalPlan?'disabled':''}>${hasFinalPlan?'Partenze programmate':'Programma le partenze'}</button></div></div>
 <div class="card"><h3>Monitoraggio</h3><p class="info-line">La classifica e la mappa si aggiornano circa ogni sei secondi. La mappa esatta delle squadre è visibile solo dalla regia e dal proprio dispositivo.</p><div class="table-scroll"><table><thead><tr><th>Squadra</th><th>Prove</th><th>Tempo</th></tr></thead><tbody>${state.teams.map(x=>`<tr><td>${esc(x.name)}</td><td>${completed(x)}/5</td><td>${completed(x)?fmt(total(x)):'—'}</td></tr>`).join('')}</tbody></table></div></div></div></div>`;
 lastEditorStage=stage;
}
function navigate(id){$(id)?.scrollIntoView({behavior:'smooth',block:'start'});document.querySelectorAll('.nav button').forEach(b=>b.classList.toggle('active',b.dataset.go===id));if(id==='mappa'&&map)setTimeout(()=>map.invalidateSize(),350)}
async function handleClick(e){const b=e.target.closest('button');if(!b)return;
 if(b.dataset.go){navigate(b.dataset.go);return}
 if(b.dataset.stage&&b.classList.contains('step')){captureEditor();stage=Number(b.dataset.stage);editorDraft=null;render();navigate('percorso');return}
 if(b.id==='access-button'){showLogin();return}if(b.id==='logout-button'){await logout();return}
 if(b.id==='gps-start'){startGps();return}if(b.id==='gps-stop'){await stopGps();return}
 const t=thisTeam();if(!state)return;
 if(b.dataset.act){const name=b.dataset.act;
  if(!t)return;
  if(name==='check'){if(!canWriteTeam(t))return;const index=Number(b.dataset.index),p=step(t,stage);
    await action('check',{teamId:t.id,stage,index,checked:!p.checked[index]},'Oggetto aggiornato');return;}
  if(name==='verify'){if(!canVerify(t))return;const count=step(t,stage)?.checked?.filter(Boolean).length||0;
    if(!confirm(`Convalidare e chiudere la tappa ${stage} di ${t.name}?\nOggetti dichiarati: ${count}\nLa chiusura congela il tempo e non può essere annullata dal sito.`))return;
    if(await action('verify',{teamId:t.id,stage},'Tempo ufficiale convalidato')){stage=Math.min(5,stage+1);render()}return;}
  if(name==='start'){if(!canVerify(t))return;if(!confirm(`La squadra ${t.name} ha ricevuto la busta ${stage} ed è pronta a partire?`))return;
    await action('start',{teamId:t.id,stage},'Cronometro ufficiale avviato');return;}
  if(name==='request_hint'){await action('request_hint',{teamId:t.id,stage,hint:Number(b.dataset.hint)},'Aiuto richiesto al commissario');return;}
  if(name==='grant_hint'){if(!canVerify(t))return;await action('grant_hint',{teamId:t.id,stage,hint:Number(b.dataset.hint)},'Aiuto concesso: malus registrato');return;}
 }
 if(!admin())return;
 if(b.dataset.rotateRole){
   const targetTeam=state.teams.find(x=>x.id===b.dataset.teamId), targetRole=b.dataset.rotateRole;
   if(!targetTeam||!['team','commissioner'].includes(targetRole))return;
   const who=targetRole==='team'?'squadra':'commissario';
   if(!confirm(`Rigenerare il codice ${who} di ${targetTeam.name}?\nIl vecchio codice e tutte le sessioni di questo ruolo verranno revocati. I risultati della squadra resteranno invariati.`))return;
   if(writing)return;writing=true;document.body.classList.add('writing');
   try{
     const result=await call('sx_rotate_code',{p_token:token,p_team_id:targetTeam.id,p_role:targetRole});
     if(!result?.code)throw new Error('Codice non ricevuto: controlla l’aggiornamento SQL.');
     rotatedCodes={name:targetTeam.name,role:targetRole,code:result.code};
     if(displayedCodes?.name===targetTeam.name)displayedCodes=null;
     toast('Nuovo codice creato. Copialo adesso: il precedente non è più valido.');
   }catch(err){toast('Rigenerazione non riuscita: '+err.message)}
   finally{writing=false;document.body.classList.remove('writing');await refresh()}
   $('rotated-codes')?.scrollIntoView({behavior:'smooth',block:'center'});return;
 }
 if(b.id==='copy-rotated-code'&&rotatedCodes){
   try{await navigator.clipboard.writeText(`Saviano Express · ${rotatedCodes.name}\nCodice ${rotatedCodes.role==='team'?'squadra':'commissario'}: ${rotatedCodes.code}`);toast('Codice copiato. Consegnalo solo alla persona autorizzata.')}
   catch{toast('Copia il codice manualmente dalla schermata.')}return;
 }
 if(b.id==='dismiss-rotated-code'){rotatedCodes=null;render();return;}
 if(b.id==='save-stage'){const title=$('stage-title').value.trim(),clue=$('stage-clue').value.trim(),objects=$('stage-objects').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
   if((stage===1&&objects.length!==12)||(stage>1&&![0,12].includes(objects.length))){toast('Prima tappa: 12 oggetti. Altre tappe: zero oppure 12.');return;}
   editorDraft=null;lastEditorStage=null;await action('edit_stage',{stage,title,clue,objects},'Indovinello salvato');return;}
 if(b.id==='open-stage'){if(!confirm(`Aprire ufficialmente la tappa ${stage} per tutte le squadre?`))return;await action('open_stage',{stage},'Tappa aperta');return;}
 if(b.id==='publish-stage'){await action('publish_stage',{stage,published:!stageInfo(stage).publicOverride},'Pubblicazione aggiornata');return;}
 if(b.id==='add-team'){const name=$('new-team').value.trim();if(name.length<2){toast('Inserisci il nome della squadra.');return;}
   const color=['#DF5A30','#368560','#D4A13E','#657DB3','#95609B'][state.teams.length%5];
   const data=await action('create_team',{name,color},null);
   if(data){displayedCodes={name,teamCode:data.teamCode,commissionerCode:data.commissionerCode};rotatedCodes=null;editorDraft=null;lastEditorStage=null;render();toast('Squadra registrata. Conserva i codici mostrati in regia.')}return;}
 if(b.id==='copy-codes'&&displayedCodes){const c=displayedCodes;try{await navigator.clipboard.writeText(`Squadra ${c.name}\nCodice squadra: ${c.teamCode}\nCodice commissario: ${c.commissionerCode}`);toast('Codici copiati: inviali privatamente.')}catch{toast('Copia i codici manualmente dalla schermata.')}return;}
 if(b.id==='plan-final'){if(!confirm('Tutte le prime quattro prove sono definitive? Programmare ORA le partenze della finale, con 30 secondi per prepararsi?'))return;await action('plan_final',{},'Orari della prova finale assegnati');return;}
}
document.addEventListener('click',handleClick);
$('teamSelect').addEventListener('change',e=>{if(!state||isRunner())return;captureEditor();selected=e.target.value;render()});
$('login-form').addEventListener('submit',login);
document.addEventListener('change',e=>{if(e.target?.id==='gps-public'){
 gpsPublic=e.target.checked;if(gpsWatch!==null&&gpsPosition)sendGps(gpsPosition,true);
}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh({quiet:true})});
// Il server è la fonte autorevole del tempo: il timer client è soltanto indicativo fra due sincronizzazioni.
setInterval(()=>{if(!state||writing)return;const t=thisTeam(),p=step(t,stage);if(p?.startedAt&&!p?.verified){
  const shown=fmt(Math.max(0,now()-Date.parse(p.startedAt)));
  document.querySelectorAll('#clue-card .live-timer').forEach(x=>x.textContent=shown);
  const cs=stageInfo(stage),count=(p.checked||[]).filter(Boolean).length;
  const penalty=((cs.objects?.length||0)-2*count)*5+(p.hints?.[0]?15:0)+(p.hints?.[1]?20:0);
  const stat=$('stats').querySelector('.live-timer');if(stat)stat.textContent=fmt(now()-Date.parse(p.startedAt)+penalty*60000);
}},1000);
refresh();if(client)setInterval(()=>refresh({quiet:true}),Math.max(4000,Number(cfg.refreshMs)||6000));
