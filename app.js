import { ROLES, ROLE_KR, MODEL_VERSION, ROLE_RULES, parseDuration, validateGameStats, assessRole, deriveResult, applyRatingUpdate } from './role-model.js?v=6-readable-20261001';
import { SharedStore, mergeDocuments } from './shared-store.js?v=6-readable-20261001';
(() => {
  const PRIOR = [1.00,1.08,1.00,0.95]; // TOP, JG, MID, BOT
  const STORAGE_KEY = "naejun_matchmaker_web_v1"; // v2와 동일: 기존 데이터 이어받기
  const VERSION = 6;
  let sharedStore = null, storageError = null;

  const allRoles = () => Object.fromEntries(ROLES.map(r=>[r,true]));
  const roles = (...allowed) => Object.fromEntries(ROLES.map(r=>[r,allowed.includes(r)]));
  const emptyRoleRating = () => Object.fromEntries(ROLES.map(r=>[r,0]));
  const emptyRoleStats = () => Object.fromEntries(ROLES.map(r=>[r,{games:0,better:0,even:0,worse:0}]));
  const emptyStats = () => ({games:0,wins:0,losses:0,role:emptyRoleStats()});

  const seedRoster = [
    {name:"송민석",baseTier:3,possible:allRoles()},
    {name:"김동혁",baseTier:4,possible:roles("TOP","MID","ADC")},
    {name:"김정한",baseTier:2,possible:roles("TOP")},
    {name:"나욱도",baseTier:5,possible:roles("TOP","SUP")},
    {name:"김준서",baseTier:4,possible:roles("MID","SUP")},
    {name:"김신우",baseTier:0,possible:allRoles()},
    {name:"신하민",baseTier:3,possible:roles("JG","SUP")},
    {name:"길민형",baseTier:5,possible:roles("TOP","SUP")},
    {name:"박지민",baseTier:6,possible:roles("TOP","JG","SUP")},
    {name:"최종인",baseTier:6,possible:roles("TOP","ADC","SUP")},
    {name:"손연호",baseTier:4,possible:roles("TOP","JG","SUP")},
    {name:"곽예찬",baseTier:3,possible:allRoles()},
    {name:"박태우",baseTier:1,possible:allRoles()},
    {name:"양현우",baseTier:2,possible:allRoles()}
  ].map((p,i)=>({...p,id:`seed-${i+1}`,rating:0,roleRating:emptyRoleRating(),stats:emptyStats(),timeline:[]}));

  const clone = v => JSON.parse(JSON.stringify(v));
  const defaultState = () => {
    const roster=clone(seedRoster), now=new Date().toISOString();
    roster.forEach(p=>p.timeline=[{time:now,tier:Number(p.baseTier),source:"init"}]);
    return {
      version:VERSION,
      roster,
      model:{weights:[...PRIOR],gamesLearned:0},
      history:[],
      session:{selectedIds:[],fixedGroups:[]},
      lastBackup:null
    };
  };

  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  const sigmoid=x=>x>30?1:x<-30?0:1/(1+Math.exp(-x));
  const popcount=n=>{let c=0;while(n){c+=n&1;n>>>=1;}return c;};
  const $=q=>document.querySelector(q);
  const $$=q=>[...document.querySelectorAll(q)];
  const escapeHtml=s=>String(s).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
  const fmt=n=>Number(n).toFixed(1);

  function normalizePlayer(p){
    p.baseTier = Number.isFinite(Number(p.baseTier)) ? Number(p.baseTier) : Number(p.tier ?? 3);
    p.rating = Number.isFinite(Number(p.rating)) ? Number(p.rating) : 0;
    p.possible ||= allRoles();
    p.roleRating ||= emptyRoleRating();
    for(const r of ROLES) p.roleRating[r]=Number.isFinite(Number(p.roleRating[r]))?Number(p.roleRating[r]):0;
    p.stats ||= emptyStats();
    p.stats.games ||= 0; p.stats.wins ||= 0; p.stats.losses ||= 0; p.stats.role ||= emptyRoleStats();
    for(const r of ROLES){ p.stats.role[r] ||= {games:0,better:0,even:0,worse:0}; }
    p.timeline=Array.isArray(p.timeline)?p.timeline:[];
    if(!p.id) p.id=`p-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    return p;
  }

  function migrateLegacyPlayerStats(s, oldVersion){
    if(oldVersion>=3 || !Array.isArray(s.history)) return;
    // v2 기록에는 포지션별 우세가 없으므로 승패 정보만 아주 약하게 선수 자동보정에 반영한다.
    for(const h of s.history){
      if(!Array.isArray(h.players)||!Array.isArray(h.assignA)||!Array.isArray(h.assignB)) continue;
      const y=h.winner==="A"?1:0, p=Number.isFinite(h.predictedAWin)?h.predictedAWin:0.5;
      const d=0.045*(y-p);
      const idsA=h.assignA.map(i=>h.players[i]?.id).filter(Boolean);
      const idsB=h.assignB.map(i=>h.players[i]?.id).filter(Boolean);
      for(const id of idsA){ const pl=s.roster.find(x=>x.id===id); if(!pl)continue; pl.rating=clamp(pl.rating+d,-1.5,1.5); pl.stats.games++; if(h.winner==="A")pl.stats.wins++;else pl.stats.losses++; }
      for(const id of idsB){ const pl=s.roster.find(x=>x.id===id); if(!pl)continue; pl.rating=clamp(pl.rating-d,-1.5,1.5); pl.stats.games++; if(h.winner==="B")pl.stats.wins++;else pl.stats.losses++; }
    }
  }

  function migrateState(s){
    if(!s || !Array.isArray(s.roster) || !s.model || !Array.isArray(s.history)) throw new Error("올바른 백업 자료가 아닙니다.");
    const oldVersion=Number(s.version||1);
    s.roster=s.roster.map(normalizePlayer);
    s.model.weights=Array.isArray(s.model.weights)&&s.model.weights.length===4?s.model.weights.map(Number):[...PRIOR];
    s.model.gamesLearned=Number(s.model.gamesLearned||0);
    s.history ||= [];
    s.session ||= {selectedIds:[],fixedGroups:[]};
    s.session.selectedIds ||= []; s.session.fixedGroups ||= [];
    migrateLegacyPlayerStats(s,oldVersion);
    const migrationTime=new Date().toISOString();
    for(const p of s.roster){
      if(!p.timeline.length){
        const tier=Math.max(-0.5,Math.min(10,Number(p.baseTier)-Number(p.rating||0)));
        p.timeline.push({time:migrationTime,tier,source:"v4-start"});
      }
    }
    s.version=VERSION;
    return s;
  }

  function loadState(){
    try { const raw=localStorage.getItem(STORAGE_KEY); return raw ? migrateState(JSON.parse(raw)) : defaultState(); }
    catch(error) { storageError=error; return defaultState(); }
  }
  let state=loadState();
  try{const session=JSON.parse(localStorage.getItem("naejun_session_v6")||"null");if(session&&Array.isArray(session.selectedIds)&&Array.isArray(session.fixedGroups))state.session=session;}catch{}
  const initialLegacyState=storageError?null:clone(state);
  let currentPlans=[];
  let activePlanIndex=null;
  let worker=null;
  let groupDraft=new Set();
  let resultDraft={winner:null,mode:Object.fromEntries(ROLES.map(r=>[r,"S"])),stats:{}};
  let activeDetailId=null;
  let liveServerBase=null;
  let historyLimit=50;

  const playerById=id=>state.roster.find(p=>p.id===id);
  const selectedPlayers=()=>state.session.selectedIds.map(playerById).filter(Boolean);
  function save(){
    try{localStorage.setItem("naejun_session_v6",JSON.stringify(state.session));}catch{}
    if(sharedStore?.enabled) { return sharedStore.save(state); }
    if(storageError) { toast("기존 저장 자료를 읽지 못했습니다. 원본을 보존하고 있으니 백업을 확인해 주세요."); return; }
    try { localStorage.setItem(STORAGE_KEY,JSON.stringify(state)); $("#saveStatus").textContent="이 기기에 저장됨"; return true; }
    catch(error) { $("#saveStatus").textContent="기기에 저장하지 못했습니다 · 백업으로 보관해 주세요"; toast("저장하지 못했습니다. 입력은 화면에 남아 있습니다."); }
  }
  function toast(msg){ const t=$("#toast");t.textContent=msg;t.classList.add("show");clearTimeout(toast._t);toast._t=setTimeout(()=>t.classList.remove("show"),1900); }

  // 기준 티어는 사람이 정한다. 자동 보정값은 경기 기록에서만 움직인다.
  function estimatedTier(p){ return clamp(p.baseTier-p.rating,-0.5,10); }
  function roleTier(p,role){ return clamp(estimatedTier(p)-(p.roleRating?.[role]||0),-0.5,10); }
  function possibleText(p){const a=ROLES.filter(r=>p.possible[r]);return a.length===5?"올라운더":a.map(r=>ROLE_KR[r]).join(" · ");}
  function impossibleText(p){const a=ROLES.filter(r=>!p.possible[r]);return a.length?a.map(r=>ROLE_KR[r]).join(" · "):"없음";}
  function recordText(p){return p.stats.games?`${p.stats.wins}승 ${p.stats.losses}패 · ${p.stats.games}경기`:"전적 없음";}

  function numOrNull(v){
    if(v===null||v===undefined||String(v).trim()==="") return null;
    const n=Number(v); return Number.isFinite(n)&&n>=0?n:null;
  }
  function emptyGameStat(){return {level:null,k:null,d:null,a:null,cs:null,gold:null};}
  function durationFor(prefix){ return $(`#${prefix==="live"?"result":"past"}Duration`).value.trim(); }
  function roleStatAssessment(role,stats,duration){return assessRole(role,stats,duration);}
  function renderStatEntry(target,prefix,roleMap,modeObj,statsObj){
    const labels={level:"레벨",k:"킬",d:"데스",a:"어시스트",cs:"CS",gold:"획득 골드"};
    $(target).innerHTML=ROLES.map(r=>{
      const info=roleMap[r]; statsObj[r] ||= {A:emptyGameStat(),B:emptyGameStat()};
      const input=(side,k)=>`<input aria-label="${ROLE_KR[r]} ${side}팀 ${escapeHtml(side==='A'?info.aName:info.bName)} ${labels[k]}" id="${prefix}-${r}-${side}-${k}" data-stat-input="1" inputmode="numeric" type="number" min="${k==='level'?1:0}" max="${k==='level'?20:k==='gold'?1000000:10000}" step="1" value="${statsObj[r][side][k]??''}">`;
      return `<section class="stat-role-card" data-role="${r}"><div class="stat-role-head"><strong>${ROLE_KR[r]}</strong><div><span class="team-a-text">A ${escapeHtml(info.aName)}</span><i>VS</i><span class="team-b-text">B ${escapeHtml(info.bName)}</span></div></div><p class="role-definition">${ROLE_RULES[r].definition}</p><div class="stat-side-labels"><span></span><b>A팀</b><b>B팀</b></div>
        <div class="stat-compact-row"><span>레벨</span>${input('A','level')}${input('B','level')}</div>
        <div class="stat-compact-row"><span>K / D / A</span><div class="triple-input">${['k','d','a'].map(k=>input('A',k)).join('')}</div><div class="triple-input">${['k','d','a'].map(k=>input('B',k)).join('')}</div></div>
        <div class="stat-compact-row"><span>CS</span>${input('A','cs')}${input('B','cs')}</div><div class="stat-compact-row"><span>획득 골드</span>${input('A','gold')}${input('B','gold')}</div>
        <div class="stat-assessment" id="${prefix}-assessment-${r}"><span>수치상 비교</span><b>입력 대기</b></div>
        <details class="stat-final"><summary>이 포지션 보정 설정</summary><label><input type="checkbox" data-exclude-role="${r}" ${modeObj[r]==='U'?'checked':''}> 이번 경기의 포지션 보정에서 제외</label></details></section>`;
    }).join('');
    $$(`${target} [data-stat-input]`).forEach(inp=>inp.addEventListener('input',()=>{refreshStatAssessments(prefix,roleMap,modeObj,statsObj);persistGameDraft(prefix);}));
    $$(`${target} [data-exclude-role]`).forEach(inp=>inp.addEventListener('change',()=>{modeObj[inp.dataset.excludeRole]=inp.checked?'U':'S';persistGameDraft(prefix);}));
    refreshStatAssessments(prefix,roleMap,modeObj,statsObj);
  }
  function collectStatsFromDom(prefix,statsObj,requireCore=true){
    let ok=true;
    for(const r of ROLES){statsObj[r]||={A:emptyGameStat(),B:emptyGameStat()};for(const side of ['A','B'])for(const key of ['level','k','d','a','cs','gold']){
      const el=$(`#${prefix}-${r}-${side}-${key}`); if(!el)continue;const v=numOrNull(el.value);statsObj[r][side][key]=v;
      const min=key==='level'?1:0,max=key==='level'?20:key==='gold'?1000000:10000;
      const valid=v!==null&&Number.isSafeInteger(v)&&v>=min&&v<=max;
      el.setAttribute('aria-invalid',el.value!==''&&!valid?'true':'false'); if(requireCore&&!valid)ok=false;
    }} return ok;
  }
  function refreshStatAssessments(prefix,roleMap,modeObj,statsObj){
    collectStatsFromDom(prefix,statsObj,false);
    for(const r of ROLES){const a=roleStatAssessment(r,statsObj,durationFor(prefix)),box=$(`#${prefix}-assessment-${r}`);if(!box)continue;
      if(!a){box.innerHTML='<span>수치상 비교</span><b>게임 시간과 해당 포지션 수치를 입력해 주세요</b>';continue;}
      const detail=a.parts.map(x=>`${x.label} ${x.diff===null?'미확인':`${x.diff>=0?'+':''}${x.diff.toFixed(2)}`}`).join(' · ');
      box.innerHTML=`<span>같은 경기 · 같은 포지션 비교</span><b>${escapeHtml(a.label)} <em>${a.score>=0?'+':''}${a.score.toFixed(3)}</em></b><small>${escapeHtml(detail)}</small><small>A ${a.rates.A.cs.toFixed(1)} CS/분 · ${a.rates.A.gold.toFixed(0)} 골드/분 / B ${a.rates.B.cs.toFixed(1)} CS/분 · ${a.rates.B.gold.toFixed(0)} 골드/분</small>`;
    }
  }
  function resolveStatResult(modeObj,statsObj,duration){return deriveResult(statsObj,duration,modeObj);}
  function draftKey(prefix){return `naejun_game_draft_v6_${prefix}`;}
  function persistGameDraft(prefix){
    try { const draft=prefix==='live'?{...resultDraft,roles:resultDraft.roles,duration:durationFor(prefix)}:{stats:window._pastStats,mode:window._pastMode,duration:durationFor(prefix),winner:$('#pastWinner').value,date:$('#pastDate').value,roles:pastRoleMapFromSelectors(false).roleMap};localStorage.setItem(draftKey(prefix),JSON.stringify(draft));if(prefix==='live')$('#resumeDraftBtn').hidden=false;
      if(prefix==='live'&&sharedStore?.enabled){state.activeDraft={...clone(draft),id:resultDraft.id};clearTimeout(persistGameDraft.timer);persistGameDraft.timer=setTimeout(()=>save(),600);}
    }
    catch { $('#saveStatus').textContent='초안을 기기에 저장하지 못했습니다 · 입력은 화면에 남아 있습니다'; }
  }
  function readGameDraft(prefix){try { return JSON.parse(localStorage.getItem(draftKey(prefix))||'null'); }catch{return null;}}
  function clearGameDraft(prefix){if(prefix==='live')clearTimeout(persistGameDraft.timer);try {localStorage.removeItem(draftKey(prefix));if(prefix==='live')$('#resumeDraftBtn').hidden=true;}catch{}}

  function renderParticipantGrid(){
    const sel=new Set(state.session.selectedIds);
    const sorted=[...state.roster].sort((a,b)=>estimatedTier(a)-estimatedTier(b)||a.name.localeCompare(b.name,"ko"));
    $("#participantGrid").innerHTML=sorted.map(p=>`<button class="participant-card ${sel.has(p.id)?"selected":""}" data-id="${p.id}" aria-pressed="${sel.has(p.id)}"><span class="check" aria-hidden="true">✓</span><strong>${escapeHtml(p.name)}</strong>${tierFacts(p)}<span class="position-label">가능 포지션</span>${positionChips(p)}</button>`).join("");
    $$("#participantGrid .participant-card").forEach(btn=>btn.onclick=()=>toggleParticipant(btn.dataset.id));
    $("#selectedCounter").textContent=`${sel.size} / 10`;
    $('#sharedDraftBtn').hidden=!sharedStore?.enabled||!state.activeDraft;
    $("#generateBtn").disabled=sel.size!==10; $("#addFixedGroupBtn").disabled=sel.size!==10;
  }

  function tierFacts(p){return `<span class="tier-facts"><span class="tier-fact"><span class="tier-fact-label">기준 티어</span><span class="tier-fact-value">${fmt(p.baseTier)}<span class="tier-unit">티어</span></span></span><span class="tier-fact estimated"><span class="tier-fact-label">추정 티어</span><span class="tier-fact-value">${fmt(estimatedTier(p))}<span class="tier-unit">티어</span></span></span></span>`;}
  function positionChips(p){return `<span class="position-chips">${ROLES.filter(r=>p.possible[r]).map(r=>`<span class="position-chip">${ROLE_KR[r]}</span>`).join('')}</span>`;}

  function toggleParticipant(id){
    const a=state.session.selectedIds, idx=a.indexOf(id);
    if(idx>=0){a.splice(idx,1);state.session.fixedGroups=state.session.fixedGroups.filter(g=>!g.includes(id));}
    else{if(a.length>=10){toast("참가자는 10명까지만 선택할 수 있습니다.");return;}a.push(id);}
    currentPlans=[];save();renderAll();
  }

  function renderFixedGroups(){
    const box=$("#fixedGroups");
    if(!state.session.fixedGroups.length){box.innerHTML='<div class="empty-note">고정 그룹 없음. 2~5명이 같은 장소라 반드시 한 팀이어야 할 때만 추가하세요.</div>';return;}
    box.innerHTML=state.session.fixedGroups.map((g,i)=>`<div class="group-chip"><div><small class="eyebrow">GROUP ${i+1}</small><div class="names">${g.map(id=>escapeHtml(playerById(id)?.name||"?")).join(" · ")}</div></div><button class="remove-group" data-i="${i}">삭제</button></div>`).join("");
    $$(".remove-group").forEach(b=>b.onclick=()=>{state.session.fixedGroups.splice(Number(b.dataset.i),1);save();renderFixedGroups();});
  }

  function renderTierList(targetId,markSelected=true){
    const selected=new Set(state.session.selectedIds);
    const sorted=[...state.roster].sort((a,b)=>estimatedTier(a)-estimatedTier(b)||a.name.localeCompare(b.name,"ko"));
    $(targetId).innerHTML=`<div class="tier-ranking">${sorted.map((p,i)=>`<button type="button" class="tier-rank-row ${markSelected&&selected.has(p.id)?"selected":""}" data-player-detail-id="${p.id}"><span class="tier-rank">${i+1}</span><span class="tier-rank-main"><strong>${escapeHtml(p.name)}${markSelected&&selected.has(p.id)?'<span class="today-mark">오늘</span>':''}</strong><small>${recordText(p)}</small><span class="position-label">가능 포지션</span>${positionChips(p)}</span>${tierFacts(p)}</button>`).join("")}</div>`;
    $$(`${targetId} [data-player-detail-id]`).forEach(el=>el.onclick=()=>openPlayerDetail(el.dataset.playerDetailId));
  }

  function renderRoster(){
    renderTierList("#tierListRoster",false);
    const sorted=[...state.roster].sort((a,b)=>estimatedTier(a)-estimatedTier(b)||a.name.localeCompare(b.name,"ko"));
    $("#rosterList").innerHTML=sorted.map(p=>{
      const roleLine=ROLES.filter(r=>p.possible[r]).map(r=>`${r} ${fmt(roleTier(p,r))}`).join(" · ");
      const delta=p.rating>=0?`-${Math.abs(p.rating).toFixed(2)}`:`+${Math.abs(p.rating).toFixed(2)}`;
      return `<div class="roster-card"><div class="roster-main roster-open" data-detail-id="${p.id}"><div class="roster-name">${escapeHtml(p.name)} <span class="badge">추정 ${fmt(estimatedTier(p))}</span></div><div class="roster-meta">기준 ${fmt(p.baseTier)} · 자동 보정 ${delta} · ${recordText(p)}</div><div class="roster-meta role-estimates">${escapeHtml(roleLine)}</div><div class="roster-meta">가능: ${escapeHtml(possibleText(p))} · 불가능: ${escapeHtml(impossibleText(p))}</div></div><div class="roster-actions"><button class="detail-btn" data-detail-id="${p.id}">상세</button><button class="edit-btn" data-id="${p.id}">수정</button></div></div>`;
    }).join("");
    $$("#rosterList .edit-btn").forEach(b=>b.onclick=e=>{e.stopPropagation();openMemberDialog(b.dataset.id);});
    $$("#rosterList .detail-btn, #rosterList .roster-open").forEach(b=>b.onclick=()=>openPlayerDetail(b.dataset.detailId));
  }

  function playerMatchRows(p){
    const rows=[];
    for(const h of state.history||[]){
      if(!h?.roles) continue;
      for(const r of ROLES){
        const m=h.roles[r]; if(!m)continue;
        let side=null,opponentId=null,opponentName="?";
        if(m.aId===p.id){side="A";opponentId=m.bId;opponentName=m.bName||playerById(m.bId)?.name||"?";}
        else if(m.bId===p.id){side="B";opponentId=m.aId;opponentName=m.aName||playerById(m.aId)?.name||"?";}
        if(!side)continue;
        const raw=h.roleAdv?.[r]||"U";
        let lane="모름";
        if(raw==="E")lane="비슷";
        else if(raw==="A")lane=side==="A"?"우세":"열세";
        else if(raw==="B")lane=side==="B"?"우세":"열세";
        rows.push({record:h,role:r,side,opponentId,opponentName,won:h.winner==='A'||h.winner==='B'?h.winner===side:null,lane});
        break;
      }
    }
    return rows.sort((a,b)=>new Date(b.record.time)-new Date(a.record.time));
  }

  function detailRoleStats(p){
    const out=Object.fromEntries(ROLES.map(r=>[r,{games:0,wins:0,losses:0,better:0,even:0,worse:0,unknown:0}]));
    for(const x of playerMatchRows(p)){
      const s=out[x.role];s.games++;if(x.won===true)s.wins++;else if(x.won===false)s.losses++;
      if(x.lane==="우세")s.better++;else if(x.lane==="비슷")s.even++;else if(x.lane==="열세")s.worse++;else s.unknown++;
    }
    return out;
  }

  function tierTrendSvg(p){
    const pts=(p.timeline||[]).filter(x=>Number.isFinite(Number(x.tier))).sort((a,b)=>new Date(a.time)-new Date(b.time)).slice(-40);
    if(pts.length<2)return `<div class="trend-empty">v4 이후 경기 결과가 더 쌓이면 추정 티어 변화가 선으로 표시됩니다.</div>`;
    const W=640,H=190,L=42,R=16,T=18,B=30,values=pts.map(x=>Number(x.tier));
    let min=Math.min(...values,Number(p.baseTier)),max=Math.max(...values,Number(p.baseTier));
    if(max-min<1){min-=.5;max+=.5;}else{min-=.25;max+=.25;}
    const x=i=>L+(W-L-R)*(i/(pts.length-1));
    const y=v=>T+(H-T-B)*((v-min)/(max-min)); // 숫자가 낮을수록 위(강함)
    const path=pts.map((q,i)=>`${i?"L":"M"}${x(i).toFixed(1)},${y(Number(q.tier)).toFixed(1)}`).join(" ");
    const baseY=y(Number(p.baseTier));
    const dots=pts.map((q,i)=>`<circle cx="${x(i).toFixed(1)}" cy="${y(Number(q.tier)).toFixed(1)}" r="${i===pts.length-1?4.5:2.7}" />`).join("");
    const grids=[0,.25,.5,.75,1].map(f=>{const v=min+(max-min)*f,yy=y(v);return `<g><line x1="${L}" x2="${W-R}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}"/><text x="${L-7}" y="${(yy+3).toFixed(1)}">${v.toFixed(1)}</text></g>`;}).join("");
    return `<div class="trend-chart-wrap"><svg class="trend-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(p.name)} 추정 티어 변화"><g class="trend-grid">${grids}</g><line class="base-tier-line" x1="${L}" x2="${W-R}" y1="${baseY.toFixed(1)}" y2="${baseY.toFixed(1)}"/><path class="trend-path" d="${path}"/><g class="trend-dots">${dots}</g><text class="chart-caption" x="${L}" y="${H-7}">과거</text><text class="chart-caption" text-anchor="end" x="${W-R}" y="${H-7}">현재</text></svg><div class="trend-legend"><span><i class="legend-line current"></i>추정 티어</span><span><i class="legend-line base"></i>기준 ${fmt(p.baseTier)}</span><small>위로 갈수록 강함 · 최근 ${pts.length}개 갱신</small></div></div>`;
  }

  function openPlayerDetail(id){
    const p=playerById(id);if(!p)return;activeDetailId=id;
    const sorted=[...state.roster].sort((a,b)=>estimatedTier(a)-estimatedTier(b)||a.name.localeCompare(b.name,"ko")),rank=sorted.findIndex(x=>x.id===id)+1;
    const games=p.stats.games||0,knownGames=(p.stats.wins||0)+(p.stats.losses||0),winRate=knownGames?100*(p.stats.wins||0)/knownGames:0,rs=detailRoleStats(p),matches=playerMatchRows(p);
    const roleCards=ROLES.map(r=>{const st=rs[r],wr=(st.wins+st.losses)?100*st.wins/(st.wins+st.losses):0,possible=p.possible[r];return `<div class="role-detail-row ${possible?"":"role-disabled"}"><div><strong>${r}</strong><small>${possible?"현재 역할 추정":"현재 배치 불가"}</small></div><div class="role-detail-tier">${possible?fmt(roleTier(p,r)):"—"}</div><div><b>${st.games}경기</b><small>${(st.wins+st.losses)?`${wr.toFixed(0)}% 승률`:"승패 미기록"}</small></div><div><b>${st.better}/${st.even}/${st.worse}</b><small>우세/비슷/열세</small></div></div>`;}).join("");
    const recent=matches.slice(0,8).map(x=>`<div class="player-game-row"><span class="wl ${x.won===null?"unknown":x.won?"win":"loss"}">${x.won===null?"?":x.won?"W":"L"}</span><div><strong>${x.role} vs ${escapeHtml(x.opponentName)}</strong><small>${new Date(x.record.time).toLocaleDateString("ko-KR",{month:"numeric",day:"numeric"})} · 수치 ${x.lane} · ${x.record.source==="past"?"지난 전적":"실시간"}</small></div></div>`).join("")||'<div class="empty-note">기록된 경기가 없습니다.</div>';
    const autoDelta=-Number(p.rating||0);
    $("#playerDetailContent").innerHTML=`<div class="player-detail-hero"><div><p class="eyebrow">PLAYER PROFILE</p><h2>${escapeHtml(p.name)}</h2><p>전체 ${rank}위 · 가능 ${escapeHtml(possibleText(p))}</p></div><div class="detail-tier-orb"><span>추정</span><b>${fmt(estimatedTier(p))}</b></div></div><div class="detail-summary-grid"><div><small>기준 티어</small><b>${fmt(p.baseTier)}</b></div><div><small>자동 보정</small><b>${autoDelta>=0?"+":""}${autoDelta.toFixed(2)}</b></div><div><small>전적</small><b>${games?`${p.stats.wins}승 ${p.stats.losses}패`:"—"}</b></div><div><small>승률</small><b>${knownGames?`${winRate.toFixed(0)}%`:"—"}</b></div></div><section class="player-detail-section"><div class="detail-section-head"><div><h3>추정 티어 변화</h3><p>기준 티어는 고정하고 실제 경기로 자동 보정된 값의 흐름입니다.</p></div></div>${tierTrendSvg(p)}</section><section class="player-detail-section"><div class="detail-section-head"><div><h3>포지션별 기록</h3><p>현재 역할 추정치와 수치상 비교 기록을 함께 봅니다.</p></div></div><div class="role-detail-list">${roleCards}</div></section><section class="player-detail-section"><div class="detail-section-head"><div><h3>최근 경기</h3><p>최근 8경기에서 맡은 역할과 상대, 라인 판정입니다.</p></div></div><div class="player-game-list">${recent}</div></section>`;
    $("#playerDetailEditBtn").onclick=()=>{$("#playerDetailDialog").close();openMemberDialog(id);};
    $("#playerDetailDialog").showModal();
  }

  function appendTimelinePoint(p,record){
    p.timeline ||= [];
    const point={time:record.loggedAt||new Date().toISOString(),tier:Number(estimatedTier(p).toFixed(4)),source:record.source||"live",gameId:record.id};
    const last=p.timeline[p.timeline.length-1];
    if(!last||Math.abs(Number(last.tier)-point.tier)>.0001||last.gameId!==point.gameId)p.timeline.push(point);

  }

  function advShort(v){return v==="A"?"A":v==="B"?"B":v==="E"?"=":"?";}
  function renderHistory(){
    $("#gamesBadge").textContent=`${state.model.gamesLearned}경기`;
    const labels=["TOP","JG","MID","BOT"];
    $("#weightBars").innerHTML=labels.map((l,i)=>{const w=state.model.weights[i],pct=Math.max(10,Math.min(100,w/1.8*100));return `<div class="weight-item"><div class="weight-label">${l}</div><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><div class="weight-value">${w.toFixed(3)}</div></div>`;}).join("");
    const items=[...state.history].sort((a,b)=>new Date(b.time)-new Date(a.time)).slice(0,historyLimit);
    $("#historyList").innerHTML=items.length?items.map(h=>{
      const adv=h.roleAdv?ROLES.map(r=>{const src=h.roleAdvSource?.[r]==="stats"||h.roleAdvSource?.[r]==="five-inputs"?"수치":"";const sc=Number(h.statAssessment?.[r]?.score);return `${r} ${advShort(h.roleAdv[r]||"U")}${src&&Number.isFinite(sc)?`(${sc>=0?"+":""}${sc.toFixed(2)})`:""}`;}).join(" · "):"포지션 우세 미기록";
      const source=h.source==="past"?"지난 전적":"실시간";
      return `<div class="history-item"><div class="history-top"><div class="history-title">${h.plan?`${h.plan}안 · `:""}${h.winner?`${h.winner}팀 승리`:"승패 미기록"} <span class="history-source">${source}</span></div><div class="history-date">${new Date(h.time).toLocaleString("ko-KR",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})}</div></div><div class="history-sub">${adv}</div><div class="history-sub">당시 모형 A ${(Number(h.predictedAWin??.5)*100).toFixed(1)}% : B ${((1-Number(h.predictedAWin??.5))*100).toFixed(1)}%</div></div>`;
    }).join(""):'<div class="empty-note">아직 기록한 경기가 없습니다.</div>';
    $('#historyMoreBtn').hidden=state.history.length<=historyLimit;
  }

  function renderCriteria(){
    const labels=["TOP","JG","MID","BOT"],target=$("#criteriaWeightBars");
    if(target)target.innerHTML=labels.map((l,i)=>{const w=state.model.weights[i],pct=Math.max(10,Math.min(100,w/1.8*100));return `<div class="weight-item"><div class="weight-label">${l}</div><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><div class="weight-value">${w.toFixed(3)}</div></div>`;}).join("");
    const games=state.model.gamesLearned||0;
    if($("#criteriaGames"))$("#criteriaGames").textContent=`${games}경기 학습`;
    if($("#modelStatus"))$("#modelStatus").textContent=games<10?"초기값 중심":games<30?"실전 보정 중":"누적 데이터 반영";
  }
  function renderAll(){renderParticipantGrid();renderFixedGroups();renderRoster();renderHistory();renderCriteria();}

  function roleGapLabel(g){if(g<.01)return"동급";if(g<=1)return"양호";if(g<=2)return"주의";return"큰 격차";}
  function verdict(c){const maxCore=Math.max(c.topGap,c.jgGap,c.midGap),pd=Math.abs(c.predictedAWin-.5);if(c.totalGap<=1&&maxCore<=1&&c.botGap<=.75&&pd<=.04)return["매우 균형","great"];if(c.totalGap<=2&&maxCore<=1.5&&c.botGap<=1&&pd<=.06)return["균형","good"];if(maxCore<=2&&c.botGap<=1.5&&pd<=.08)return["조건 내 양호","ok"];return["편차 있음","bad"];}
  function teamStrengthText(c,players){
    const a=[],b=[]; [["TOP",0],["JG",1],["MID",2]].forEach(([role,i])=>{const ta=roleTier(players[c.assignA[i]],role),tb=roleTier(players[c.assignB[i]],role);if(ta<tb)a.push(role);else if(tb<ta)b.push(role);});
    if(c.botIndexA<c.botIndexB-.01)a.push("BOT");else if(c.botIndexB<c.botIndexA-.01)b.push("BOT");
    if(a.length&&b.length)return `A팀은 ${a.join("·")}, B팀은 ${b.join("·")} 쪽이 상대적으로 강해 우세가 한쪽에만 몰리지 않습니다.`;
    if(a.length)return `주요 역할 우세가 A팀(${a.join("·")})에 다소 몰려 있습니다.`;if(b.length)return `주요 역할 우세가 B팀(${b.join("·")})에 다소 몰려 있습니다.`;return"주요 역할의 계산상 우열이 거의 없습니다.";
  }
  function explain(c,players){const maxCore=Math.max(c.topGap,c.jgGap,c.midGap),coreRole=["TOP","JG","MID"][[c.topGap,c.jgGap,c.midGap].indexOf(maxCore)],p=[];p.push(c.totalGap<=1?`역할 보정 체급 합 차이는 ${c.totalGap.toFixed(1)}로 매우 작습니다.`:`역할 보정 체급 합은 ${c.tierSumA.toFixed(1)} 대 ${c.tierSumB.toFixed(1)}로 ${c.totalGap.toFixed(1)} 차이가 남습니다.`);if(maxCore<=1)p.push("TOP·JG·MID가 모두 1티어 이내라 한 역할에서 게임이 일찍 무너질 위험을 억제했습니다.");else p.push(`${coreRole}의 ${maxCore.toFixed(1)}티어 차이가 가장 큰 변수입니다.`);p.push(c.botGap<=1?`바텀 듀오 지수 차이는 ${c.botGap.toFixed(2)}로 ADC와 SUP의 상호보완까지 고려해 가깝습니다.`:`바텀 듀오 지수 차이는 ${c.botGap.toFixed(2)}로 바텀 편차가 남습니다.`);p.push(teamStrengthText(c,players));return p;}

  function renderPlans(){
    const players=selectedPlayers();renderTierList("#tierListResult",true);$("#planCountBadge").textContent=`${currentPlans.length}개`;const first=currentPlans[0];
    $("#plansContainer").innerHTML=currentPlans.map((c,idx)=>{
      const [v,cls]=verdict(c),ex=explain(c,players),changeText=idx===0?"최저 밸런스 점수":`${first?popcount((first.teamMaskA^c.teamMaskA)>>>0)/2:0}명 교체 구성`;
      const teamA=c.assignA.map(i=>players[i].name).join(" · "),teamB=c.assignB.map(i=>players[i].name).join(" · ");
      const rows=ROLES.map((r,i)=>{const a=players[c.assignA[i]],b=players[c.assignB[i]],ta=roleTier(a,r),tb=roleTier(b,r),gap=Math.abs(ta-tb);return `<div class="match-row"><div class="role-tag">${r}</div><div class="player-side a"><div class="player-name">${escapeHtml(a.name)}</div><div class="player-tier">역할 추정 ${fmt(ta)} · 기준 ${fmt(a.baseTier)}</div></div><div class="vs">VS</div><div class="player-side b"><div class="player-name">${escapeHtml(b.name)} <span class="gap-dot">${roleGapLabel(gap)}</span></div><div class="player-tier">역할 추정 ${fmt(tb)} · 기준 ${fmt(b.baseTier)}</div></div></div>`;}).join("");
      const marker=Math.max(3,Math.min(97,c.predictedAWin*100)),confidence=state.model.gamesLearned<10?"초기치 중심":state.model.gamesLearned<30?"실전 보정 중":"누적 데이터 반영";
      return `<article class="plan-card ${idx===0?"featured":""}"><div class="plan-top"><div><div class="plan-rank">황금 밸런스 ${idx+1}안</div><div class="plan-subline">${changeText}</div></div><span class="verdict ${cls}">${v}</span></div><div class="team-strip"><div class="team-block"><div class="team-label a">TEAM A</div><div class="team-names">${escapeHtml(teamA)}</div></div><div class="team-block"><div class="team-label b">TEAM B</div><div class="team-names">${escapeHtml(teamB)}</div></div></div><div class="match-table">${rows}</div><div class="balance-bar"><div class="balance-bar-top"><span>A ${(c.predictedAWin*100).toFixed(1)}</span><span>모형상 균형 추정 · ${confidence}</span><span>${((1-c.predictedAWin)*100).toFixed(1)} B</span></div><div class="balance-track"><span class="balance-marker" style="left:${marker}%"></span></div></div><div class="metrics"><div class="metric"><small>역할보정 합</small><strong>A ${c.tierSumA.toFixed(1)} : B ${c.tierSumB.toFixed(1)}</strong></div><div class="metric"><small>TOP / JG / MID</small><strong>${c.topGap.toFixed(1)} / ${c.jgGap.toFixed(1)} / ${c.midGap.toFixed(1)}</strong></div><div class="metric"><small>BOT 듀오</small><strong>${c.botIndexA.toFixed(2)} : ${c.botIndexB.toFixed(2)}</strong></div><div class="metric"><small>ADC / SUP 차이</small><strong>${c.adcGap.toFixed(1)} / ${c.supGap.toFixed(1)}</strong></div></div><div class="explanation">${ex.map((x,i)=>`<p>${i+1}. ${escapeHtml(x)}</p>`).join("")}</div><button class="play-btn" data-plan="${idx}">이 안으로 경기</button></article>`;
    }).join("")||'<div class="empty-note">조건을 만족하는 팀을 만들 수 없습니다.</div>';
    $$(".play-btn").forEach(b=>b.onclick=()=>openResultDialog(Number(b.dataset.plan)));$("#resultSection").classList.remove("hidden");setTimeout(()=>$("#resultSection").scrollIntoView({behavior:"smooth",block:"start"}),80);
  }

  function showLoading(show,text="가능한 조합을 계산하고 있습니다…"){let el=$("#loadingOverlay");if(show){if(!el){el=document.createElement("div");el.id="loadingOverlay";el.className="loading-overlay";el.innerHTML=`<div class="loading-box"><div class="spinner"></div><strong>${escapeHtml(text)}</strong><p class="muted" style="font-size:12px;margin-top:6px">현재 추정 티어·역할 숙련·고정팀 조건까지 전수 비교합니다.</p></div>`;document.body.appendChild(el);}}else el?.remove();}
  function generate(){if(state.session.selectedIds.length!==10)return;showLoading(true);if(worker)worker.terminate();worker=new Worker("matcher-worker.js");worker.onmessage=e=>{if(e.data.progress)return;showLoading(false);if(e.data.error){toast(e.data.error);return;}currentPlans=e.data.plans||[];renderPlans();if(!currentPlans.length)toast("현재 조건으로 가능한 정상 배치가 없습니다.");};worker.onerror=()=>{showLoading(false);toast("계산 중 오류가 발생했습니다.");};worker.postMessage({players:selectedPlayers(),model:state.model,fixedGroups:state.session.fixedGroups});}

  function openMemberDialog(id=null){
    const p=id?playerById(id):null;$("#memberId").value=p?.id||"";$("#memberName").value=p?.name||"";$("#memberTier").value=p?.baseTier??3;$("#memberDialogTitle").textContent=p?"멤버 수정":"새 멤버 추가";$("#memberDialogEyebrow").textContent=p?"EDIT PLAYER":"NEW PLAYER";
    $("#memberImpossibleRoles").innerHTML=ROLES.map(r=>`<label class="role-check"><input type="checkbox" data-role="${r}" ${p&&!p.possible[r]?"checked":""}><span>${r}</span></label>`).join("");
    const info=$("#memberAutoInfo");if(info)info.innerHTML=p?`현재 추정 티어 <b>${fmt(estimatedTier(p))}</b> · 자동 보정 ${p.rating>=0?"-":"+"}${Math.abs(p.rating).toFixed(2)} · ${recordText(p)}`:"새 멤버는 자동 보정 0에서 시작합니다.";$("#memberDialog").showModal();
  }
  function saveMember(){
    const id=$("#memberId").value,name=$("#memberName").value.trim(),baseTier=Number($("#memberTier").value);if(!name||!Number.isFinite(baseTier)){toast("이름과 기준 티어를 확인해주세요.");return false;}
    const impossible=new Set($$("#memberImpossibleRoles input:checked").map(x=>x.dataset.role)),possible=Object.fromEntries(ROLES.map(r=>[r,!impossible.has(r)]));if(!ROLES.some(r=>possible[r])){toast("최소 한 포지션은 가능해야 합니다.");return false;}
    if(id){const p=playerById(id);p.name=name;p.baseTier=baseTier;p.possible=possible;}else state.roster.push(normalizePlayer({id:`p-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,name,baseTier,possible}));
    save();renderAll();toast(id?"멤버 정보를 저장했습니다.":"새 멤버를 저장했습니다.");return true;
  }

  function openGroupDialog(){const used=new Set(state.session.fixedGroups.flat());groupDraft=new Set();$("#groupMemberChoices").innerHTML=state.session.selectedIds.map(id=>{const p=playerById(id),disabled=used.has(id);return `<button type="button" class="participant-card ${disabled?"disabled":""}" data-id="${id}" ${disabled?"disabled":""}><strong>${escapeHtml(p.name)}</strong><small>추정 ${fmt(estimatedTier(p))}${disabled?" · 다른 그룹에 포함":""}</small></button>`;}).join("");$$("#groupMemberChoices .participant-card:not(:disabled)").forEach(b=>b.onclick=()=>{const id=b.dataset.id;if(groupDraft.has(id)){groupDraft.delete(id);b.classList.remove("selected");}else{if(groupDraft.size>=5){toast("한 그룹은 최대 5명입니다.");return;}groupDraft.add(id);b.classList.add("selected");}});$("#groupDialog").showModal();}
  function saveGroup(){if(groupDraft.size<2){toast("같은 팀 고정은 2명 이상 선택해주세요.");return false;}state.session.fixedGroups.push([...groupDraft]);save();renderFixedGroups();toast(`${groupDraft.size}명을 같은 팀으로 고정했습니다.`);return true;}

  function botDuoIndex(adc,sup){const strong=Math.min(adc,sup),weak=Math.max(adc,sup);return .60*strong+.40*weak;}
  function predictFeatureFromRoles(roleMap){
    const ta=ROLES.map(r=>roleTier(playerById(roleMap[r].aId),r)),tb=ROLES.map(r=>roleTier(playerById(roleMap[r].bId),r));
    const botA=botDuoIndex(ta[3],ta[4]),botB=botDuoIndex(tb[3],tb[4]);const feature=[(tb[0]-ta[0])/3,(tb[1]-ta[1])/3,(tb[2]-ta[2])/3,(botB-botA)/3];
    let z=0;for(let i=0;i<4;i++)z+=state.model.weights[i]*feature[i];return {feature,predictedAWin:sigmoid(z)};
  }

  function liveRoleMap(plan){const ps=selectedPlayers(),map={};ROLES.forEach((r,i)=>{const a=ps[plan.assignA[i]],b=ps[plan.assignB[i]];map[r]={aId:a.id,bId:b.id,aName:a.name,bName:b.name,aTier:roleTier(a,r),bTier:roleTier(b,r)};});return map;}
  function openResultDialog(idx){
    activePlanIndex=idx;
    const c=currentPlans[idx];if(!c)return;const roleMap=liveRoleMap(c);
    if(sharedStore?.enabled&&state.activeDraft&&JSON.stringify(ROLES.map(r=>[state.activeDraft.roles[r].aId,state.activeDraft.roles[r].bId]))!==JSON.stringify(ROLES.map(r=>[roleMap[r].aId,roleMap[r].bId]))){toast('입력 중인 공유 경기가 있습니다. 공유 경기 입력에서 먼저 완료해 주세요.');return;}
    resultDraft={winner:null,roles:roleMap,mode:Object.fromEntries(ROLES.map(r=>[r,"S"])),stats:Object.fromEntries(ROLES.map(r=>[r,{A:emptyGameStat(),B:emptyGameStat()}]))};
    $("#resultDialogTitle").textContent=`${idx+1}안 경기 결과`;
    $("#resultDialogText").textContent="레벨·K/D/A·CS·획득 골드를 입력해 주세요. 게임 시간은 한 번만 입력합니다. 승리팀 선택은 생략할 수 있습니다.";
    $$(".winner-choice").forEach(b=>b.classList.remove("active"));
    $("#resultDuration").value="";
    liveServerBase=sharedStore?.enabled&&state.activeDraft?clone(state.activeDraft):null;
    const localDraft=readGameDraft('live');
    const draft=sharedStore?.enabled&&state.activeDraft?state.activeDraft:localDraft;
    if(draft&&JSON.stringify(ROLES.map(r=>[draft.roles?.[r]?.aId,draft.roles?.[r]?.bId]))===JSON.stringify(ROLES.map(r=>[roleMap[r].aId,roleMap[r].bId]))) { resultDraft={...resultDraft,...draft};$('#resultDuration').value=draft.duration||''; }
    $$('.winner-choice').forEach(b=>b.classList.toggle('active',b.dataset.winner===resultDraft.winner));
    renderStatEntry("#resultStatEntry","live",roleMap,resultDraft.mode,resultDraft.stats);
    if(sharedStore?.enabled){resultDraft.id||=`g-${crypto.randomUUID()}`;state.activeDraft={...clone(resultDraft),duration:durationFor('live')};save();}
    $("#saveResultBtn").disabled=false;$("#resultDialog").showModal();
  }

  function signFromAdv(v){return v==="A"?1:v==="B"?-1:v==="E"?0:null;}
  function ensurePlayer(id){return playerById(id);}
  function applyLearning(record){ applyRatingUpdate(state,record); return save(); }
  function validateResult(stats,duration){
    const error=validateGameStats(stats,duration);
    if(error) { toast(error==='게임시간'?'게임 시간을 분:초 형식으로 입력해 주세요. 예: 31:42':error);return false; }return true;
  }
  function saveLiveResult(){
    if(!collectStatsFromDom("live",resultDraft.stats,true)){toast("10명 모두 레벨·K/D/A·CS·골드를 확인해 주세요.");return;}
    if(!validateResult(resultDraft.stats,durationFor("live")))return;
    const c=currentPlans[activePlanIndex];if(!c)return;const roles=resultDraft.roles,resolved=resolveStatResult(resultDraft.mode,resultDraft.stats,durationFor("live"));
    const record={id:resultDraft.id||`g-${crypto.randomUUID()}`,time:new Date().toISOString(),source:"live",plan:activePlanIndex+1,winner:resultDraft.winner,duration:$("#resultDuration").value.trim()||null,predictedAWin:c.predictedAWin,feature:[...c.feature],roles,stats:clone(resultDraft.stats),...resolved};
    if(state.history.some(h=>h.id===record.id)){toast('이미 저장한 경기입니다.');return;}
    state.activeDraft=null;if(applyLearning(record))clearGameDraft("live");$("#resultDialog").close();renderAll();currentPlans=[];$("#resultSection").classList.add("hidden");toast("경기 수치를 저장했습니다. 다음 매칭에 작은 보정을 반영합니다.");
  }

  function pastRoleMapFromSelectors(requireAll=false){
    const roleMap={},ids=[];for(const r of ROLES){const aId=$(`#pastA-${r}`)?.value||"",bId=$(`#pastB-${r}`)?.value||"";if(requireAll&&(!aId||!bId))return null;roleMap[r]={aId,bId,aName:playerById(aId)?.name||"A 선수",bName:playerById(bId)?.name||"B 선수",aTier:aId?roleTier(playerById(aId),r):3,bTier:bId?roleTier(playerById(bId),r):3};if(aId)ids.push(aId);if(bId)ids.push(bId);}return {roleMap,ids};
  }
  function openPastDialog(){
    const sorted=[...state.roster].sort((a,b)=>estimatedTier(a)-estimatedTier(b)||a.name.localeCompare(b.name,"ko")),options='<option value="">선택</option>'+sorted.map(p=>`<option value="${p.id}">${escapeHtml(p.name)} (추정 ${fmt(estimatedTier(p))})</option>`).join("");
    $("#pastRows").innerHTML=ROLES.map(r=>`<div class="past-row"><strong>${r}</strong><select id="pastA-${r}" class="past-select" aria-label="${ROLE_KR[r]} A팀 선수">${options}</select><span class="vs">VS</span><select id="pastB-${r}" class="past-select" aria-label="${ROLE_KR[r]} B팀 선수">${options}</select></div>`).join("");
    const now=new Date(),local=new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,16);$("#pastDate").value=local;$("#pastWinner").value="";$("#pastDuration").value="";
    window._pastMode=Object.fromEntries(ROLES.map(r=>[r,"S"]));window._pastStats=Object.fromEntries(ROLES.map(r=>[r,{A:emptyGameStat(),B:emptyGameStat()}]));
    const draft=readGameDraft('past');
    if(draft?.roles){window._pastMode=draft.mode;window._pastStats=draft.stats;$('#pastDuration').value=draft.duration||'';$('#pastWinner').value=draft.winner||'';$('#pastDate').value=draft.date||local;for(const r of ROLES){$(`#pastA-${r}`).value=draft.roles[r].aId;$(`#pastB-${r}`).value=draft.roles[r].bId;}}
    const byPlayer=new Map();for(const r of ROLES)for(const side of ['A','B']){const id=$(`#past${side}-${r}`).value;if(id)byPlayer.set(id,clone(window._pastStats[r][side]));}
    const refreshPast=()=>{const got=pastRoleMapFromSelectors(false);renderStatEntry("#pastStatEntry","past",got.roleMap,window._pastMode,window._pastStats);};
    refreshPast();$$('#pastRows select').forEach(el=>{let previous=el.value;el.addEventListener('change',()=>{collectStatsFromDom('past',window._pastStats,false);const match=el.id.match(/^past([AB])-(.+)$/),side=match[1],r=match[2];if(previous)byPlayer.set(previous,clone(window._pastStats[r][side]));window._pastStats[r][side]=clone(byPlayer.get(el.value)||emptyGameStat());previous=el.value;refreshPast();persistGameDraft('past');});});$("#pastDialog").showModal();
  }
  function savePastMatch(){
    const got=pastRoleMapFromSelectors(true);if(!got){toast("A/B 모든 포지션의 선수를 선택해주세요.");return false;}const {roleMap,ids}=got;
    if(new Set(ids).size!==10){toast("한 경기에서는 10명이 각각 한 포지션만 맡아야 합니다.");return false;}
    if(!collectStatsFromDom("past",window._pastStats,true)){toast("10명 모두 레벨·K/D/A·CS·골드를 확인해 주세요.");return false;}
    if(!validateResult(window._pastStats,durationFor("past")))return false;
    const winner=$("#pastWinner").value||null,pred=predictFeatureFromRoles(roleMap),date=$("#pastDate").value,resolved=resolveStatResult(window._pastMode,window._pastStats,durationFor("past"));
    const record={id:`past-${crypto.randomUUID()}`,time:date?new Date(date).toISOString():new Date().toISOString(),source:"past",plan:null,winner,duration:$("#pastDuration").value.trim()||null,predictedAWin:pred.predictedAWin,feature:pred.feature,roles:roleMap,stats:clone(window._pastStats),...resolved};
    if(applyLearning(record))clearGameDraft("past");renderAll();toast("지난 전적의 경기 수치까지 학습 데이터에 추가했습니다.");return true;
  }

  function exportData(){state.lastBackup=new Date().toISOString();save();const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`내전자동매칭기_백업_${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),500);toast("백업 파일을 만들었습니다.");}
  async function importData(file){if(sharedStore?.enabled){await sharedStore.importFile(file);return;}try{const obj=JSON.parse(await file.text());state=migrateState(obj);save();currentPlans=[];renderAll();$("#resultSection").classList.add("hidden");toast("백업을 불러왔습니다.");}catch{toast("올바른 백업 파일이 아닙니다.");}}

  function bind(){
    $$(".nav-btn").forEach(b=>b.onclick=()=>{$$(".nav-btn").forEach(x=>{x.classList.toggle("active",x===b);if(x===b)x.setAttribute("aria-current","page");else x.removeAttribute("aria-current");});$$('.tab-panel').forEach(p=>p.classList.remove('active'));$(`#tab-${b.dataset.tab}`).classList.add('active');window.scrollTo({top:0,behavior:'smooth'});});
    $("#clearSelectionBtn").onclick=()=>{state.session={selectedIds:[],fixedGroups:[]};currentPlans=[];save();renderAll();$("#resultSection").classList.add("hidden");};
    $("#addFixedGroupBtn").onclick=openGroupDialog;$("#generateBtn").onclick=generate;$("#addMemberBtn").onclick=()=>openMemberDialog();
    $("#memberForm").addEventListener("submit",e=>{if(e.submitter?.value==="cancel"){e.submitter.form.noValidate=true;return;}e.submitter.form.noValidate=false;if(!saveMember()){e.preventDefault();return;}});
    $("#groupForm").addEventListener("submit",e=>{if(e.submitter?.value==="cancel"){e.submitter.form.noValidate=true;return;}e.submitter.form.noValidate=false;if(!saveGroup()){e.preventDefault();return;}});
    $$(".winner-choice").forEach(b=>b.onclick=()=>{resultDraft.winner=resultDraft.winner===b.dataset.winner?null:b.dataset.winner;$$('.winner-choice').forEach(x=>x.classList.toggle('active',x.dataset.winner===resultDraft.winner));persistGameDraft('live');});
    $("#saveResultBtn").onclick=saveLiveResult;
    $("#addPastBtn").onclick=openPastDialog;$("#pastForm").addEventListener("submit",e=>{if(e.submitter?.value==="cancel"){e.submitter.form.noValidate=true;return;}e.submitter.form.noValidate=false;if(!savePastMatch()){e.preventDefault();return;}});
    $("#exportBtn").onclick=exportData;$("#importInput").onchange=e=>{const f=e.target.files?.[0];if(f)importData(f);e.target.value="";};
    $("#resetBtn").onclick=async()=>{if(sharedStore?.enabled){await sharedStore.reset();return;}if(confirm("백업 파일을 먼저 만든 뒤 멤버·경기 기록을 초기화할까요?")){exportData();state=defaultState();save();currentPlans=[];renderAll();$("#resultSection").classList.add("hidden");toast("초기화했습니다.");}};
    $('#sharedDraftBtn').onclick=()=>resumeRoles(state.activeDraft);
    $('#historyMoreBtn').onclick=()=>{historyLimit+=50;renderHistory();};
    $("#installHelpBtn").onclick=()=>$("#installDialog").showModal();
  }

  async function init(){
    bind();renderAll();document.querySelector('.app-shell').inert=true;
    for(const prefix of ['live','past']) $(`#${prefix==='live'?'result':'past'}Duration`).addEventListener('input',()=>{
      const stats=prefix==='live'?resultDraft.stats:window._pastStats;
      if(stats){refreshStatAssessments(prefix,{},prefix==='live'?resultDraft.mode:window._pastMode,stats);persistGameDraft(prefix);}
    });
    $('#pastWinner').addEventListener('change',()=>persistGameDraft('past'));
    $('#pastDate').addEventListener('change',()=>persistGameDraft('past'));
    sharedStore=new SharedStore({ getState:()=>state, setState:value=>{
      const session=state.session;
      if($('#resultDialog').open&&value.activeDraft?.id===resultDraft.id){
        collectStatsFromDom('live',resultDraft.stats,false);
        const local={id:resultDraft.id,roles:resultDraft.roles,stats:resultDraft.stats,mode:resultDraft.mode,winner:resultDraft.winner,duration:durationFor('live')};
        try{const merged=liveServerBase?mergeDocuments(liveServerBase,local,value.activeDraft):local;liveServerBase=clone(value.activeDraft);resultDraft={...resultDraft,...merged};
          for(const r of ROLES)for(const side of ['A','B'])for(const key of ['level','k','d','a','cs','gold']){const el=$(`#live-${r}-${side}-${key}`),v=merged.stats[r][side][key]??'';if(el&&el.value!==String(v))el.value=v;}
          $('#resultDuration').value=merged.duration;$$('.winner-choice').forEach(b=>b.classList.toggle('active',b.dataset.winner===merged.winner));$$('#resultStatEntry [data-exclude-role]').forEach(e=>e.checked=merged.mode[e.dataset.excludeRole]==='U');
          refreshStatAssessments('live',merged.roles,merged.mode,merged.stats);
        }catch{sharedStore.blocked=true;toast('같은 경기 입력이 겹칩니다. 초안은 기기에 보존했습니다.');}
      }
      state=migrateState(value);const known=new Set(state.roster.map(p=>p.id));session.selectedIds=session.selectedIds.filter(id=>known.has(id));session.fixedGroups=session.fixedGroups.map(g=>g.filter(id=>known.has(id))).filter(g=>g.length>=2);state.session=session;renderAll();
    }, legacy:initialLegacyState, migrate:migrateState, toast });
    await sharedStore.start();
    if(!sharedStore.enabled){document.querySelector('.app-shell').inert=false;save();}
    if(navigator.storage?.persist){try{await navigator.storage.persist();}catch{}}
    if('serviceWorker' in navigator)navigator.serviceWorker.register('service-worker.js').catch(()=>{});
    const liveDraft=readGameDraft('live');
    $('#resumeDraftBtn').hidden=!liveDraft;
    $('#resumeDraftBtn').onclick=()=>resumeRoles(readGameDraft('live'));
  }
  function resumeRoles(d){
    if(!d?.roles)return;
    state.session.selectedIds=ROLES.flatMap(r=>[d.roles[r].aId,d.roles[r].bId]);renderAll();
    const ps=selectedPlayers();if(ps.length!==10){toast('초안의 선수 정보가 달라졌습니다. 기존 입력은 보존했습니다.');return;}
    const map=new Map(ps.map((p,i)=>[p.id,i]));const c={assignA:ROLES.map(r=>map.get(d.roles[r].aId)),assignB:ROLES.map(r=>map.get(d.roles[r].bId)),...predictFeatureFromRoles(d.roles)};
    currentPlans=[c];openResultDialog(0);
  }
  document.addEventListener("DOMContentLoaded",init);
})();
