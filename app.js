import { ROLES, ROLE_KR, MODEL_VERSION, ROLE_RULES, parseDuration, validateGameStats, assessRole, deriveResult, applyRatingUpdate, estimatedTier, roleTier, tierCorrection, tierTrendPoints, recordPendingReasons, teamPrediction, roleEvidence, roleUncertainty } from './role-model.js?v=9-role-readings-20261007';
import { SharedStore, mergeDocuments } from './shared-store.js?v=9-role-readings-20261007';
import { comparePlayerNames, normalizeGameDuration, firstStatIssue, sameGameInput , parseQuickStats, requiredRoleIssue } from './entry-input.js?v=9-role-readings-20261007';
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
      session:{selectedIds:[],fixedGroups:[],fixedRoles:{}},
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
    s.session ||= {selectedIds:[],fixedGroups:[],fixedRoles:{}};
    s.session.selectedIds ||= []; s.session.fixedGroups ||= []; s.session.fixedRoles ||= {};
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
  state.session.fixedRoles ||= {};
  const initialLegacyState=storageError?null:clone(state);
  let currentPlans=[];
  let activePlanIndex=null;
  let worker=null;
  let groupDraft=new Set();
  let resultDraft={winner:null,mode:Object.fromEntries(ROLES.map(r=>[r,"S"])),stats:{}};
  let activeDetailId=null;
  let liveServerBase=null;
  let historyLimit=50;
  let pastEditing=null;

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
  function possibleText(p){const a=ROLES.filter(r=>p.possible[r]);return a.length===5?"올라운더":a.map(r=>ROLE_KR[r]).join(" · ");}
  function impossibleText(p){const a=ROLES.filter(r=>!p.possible[r]);return a.length?a.map(r=>ROLE_KR[r]).join(" · "):"없음";}
  function recordText(p){const rows=playerMatchRows(p),wins=rows.filter(x=>x.won===true).length,losses=rows.filter(x=>x.won===false).length,pending=rows.filter(x=>x.record.pendingReasons?.length).length;return rows.length?`${wins}승 ${losses}패 · ${rows.length}경기${pending?` · 선택 정보 미입력 ${pending}경기`:""}`:"전적 없음";}

  function numOrNull(v){
    if(v===null||v===undefined||String(v).trim()==="") return null;
    const n=Number(v); return Number.isFinite(n)?n:null;
  }
  function emptyGameStat(){return {level:null,k:null,d:null,a:null,cs:null,gold:null,damage:null};}
  function durationFor(prefix){ const raw=$(`#${prefix==="live"?"result":"past"}Duration`).value.trim(); return normalizeGameDuration(raw)||raw; }
  function roleStatAssessment(role,stats,duration){return assessRole(role,stats,duration);}
  const entryRoleState={live:'TOP',past:'TOP'};
  function showEntryRole(prefix,role){
    entryRoleState[prefix]=role;const target=$(`#${prefix==='live'?'result':'past'}StatEntry`);
    target.querySelectorAll('[data-role-card]').forEach(c=>c.hidden=c.dataset.roleCard!==role);
    target.querySelectorAll('[data-entry-role]').forEach(b=>{b.setAttribute('aria-pressed',b.dataset.entryRole===role?'true':'false');});
  }
  function renderStatEntry(target,prefix,roleMap,modeObj,statsObj){
    const labels={level:'레벨',k:'킬',d:'데스',a:'어시스트',cs:'CS',gold:'골드',damage:'피해량'};
    $(target).innerHTML=`<div class="entry-role-tabs" aria-label="입력할 역할">${ROLES.map(r=>`<button type="button" class="secondary-btn" data-entry-role="${r}" aria-pressed="${r===entryRoleState[prefix]}">${ROLE_KR[r]}</button>`).join('')}</div><p class="field-help">한 역할씩 입력합니다. K/D/A 칸에 6/2/20을 붙여넣으면 세 칸이 함께 채워집니다. Enter는 다음 칸으로 이동합니다.</p><label class="partial-save-choice"><input type="checkbox" id="${prefix}-allow-partial"> 미확인 필수 값은 나중에 보충 · 원본부터 저장</label>`+ROLES.map(r=>{
      const info=roleMap[r];statsObj[r]||={A:emptyGameStat(),B:emptyGameStat()};
      const input=(side,k)=>`<input aria-label="${ROLE_KR[r]} ${side}팀 ${escapeHtml(side==='A'?info.aName:info.bName)} ${labels[k]}" id="${prefix}-${r}-${side}-${k}" data-stat-input="1" data-field="${k}" inputmode="numeric" type="number" min="${k==='level'?1:0}" max="${k==='level'?20:['gold','damage'].includes(k)?1000000:10000}" step="1" value="${statsObj[r][side][k]??''}">`;
      const row=(k,title)=>`<div class="stat-compact-row"><span>${title}</span>${input('A',k)}${input('B',k)}</div>`;
      const primary=r==='SUP'?[]:['damage','cs',...ROLE_RULES[r].required],extra=['damage','cs','gold','level'].filter(k=>!primary.includes(k));
      return `<section class="stat-role-card" data-role-card="${r}" data-role="${r}"><div class="stat-role-head"><strong>${ROLE_KR[r]}</strong><div><span class="team-a-text">A팀 · ${escapeHtml(info.aName)}</span><i>VS</i><span class="team-b-text">B팀 · ${escapeHtml(info.bName)}</span></div></div><p class="role-definition">${ROLE_RULES[r].definition}</p><details class="quick-entry"><summary>한 줄 붙여넣기</summary><p class="field-help">K/D/A 피해량 CS 골드 레벨 순서 · 예: 6/2/20 15374 - 13886 16. 모르는 값은 -로 표시합니다.</p>${['A','B'].map(side=>`<label>${side}팀 <input type="text" data-quick-side="${side}" data-quick-role="${r}" placeholder="6/2/20 15374 - 13886 16" aria-label="${ROLE_KR[r]} ${side}팀 한 줄 입력"></label><button type="button" data-apply-quick="${r}-${side}" class="secondary-btn">${side}팀에 적용</button>`).join('')}</details><div class="stat-side-labels"><span></span><b>A팀</b><b>B팀</b></div><div class="stat-compact-row"><span>K/D/A</span><div class="triple-input">${['k','d','a'].map(k=>input('A',k)).join('')}</div><div class="triple-input">${['k','d','a'].map(k=>input('B',k)).join('')}</div></div>${primary.map(k=>row(k,labels[k]+(ROLE_RULES[r].required.includes(k)?' · 필수':' · 선택'))).join('')}<details class="entry-extra"><summary>${r==='SUP'?'추가 원본 수치 · 평가에는 사용하지 않음':'추가 수치 · 선택'}</summary>${extra.map(k=>row(k,labels[k])).join('')}</details><div class="stat-assessment" id="${prefix}-assessment-${r}"></div><details class="stat-final"><summary>이 역할 보정 설정</summary><label><input type="checkbox" data-exclude-role="${r}" ${modeObj[r]==='U'?'checked':''}> 이번 경기의 역할 수치 보정 제외</label></details>${r!=='SUP'?`<button type="button" class="secondary-btn entry-next" data-next-role="${ROLES[ROLES.indexOf(r)+1]}">다음 · ${ROLE_KR[ROLES[ROLES.indexOf(r)+1]]} →</button>`:'<p class="field-help">입력이 끝나면 아래 저장 버튼을 누르세요. 빈 선택 값은 0점으로 처리하지 않습니다.</p>'}</section>`;
    }).join('');
    showEntryRole(prefix,entryRoleState[prefix]);
    const changed=()=>{clearEntryError(prefix);refreshStatAssessments(prefix,roleMap,modeObj,statsObj);persistGameDraft(prefix);};
    $$(`${target} [data-entry-role],${target} [data-next-role]`).forEach(b=>b.onclick=()=>{collectStatsFromDom(prefix,statsObj,false);showEntryRole(prefix,b.dataset.entryRole||b.dataset.nextRole);persistGameDraft(prefix);});
    $$(`${target} [data-stat-input]`).forEach(inp=>{
      inp.addEventListener('input',changed);
      inp.addEventListener('paste',e=>{if(!['k','d','a'].includes(inp.dataset.field))return;const text=e.clipboardData.getData('text');if(!text.includes('/'))return;e.preventDefault();try{const values=parseQuickStats(text),parts=inp.id.split('-'),role=parts[1],side=parts[2];for(const key of ['k','d','a'])$(`#${prefix}-${role}-${side}-${key}`).value=values[key];changed();}catch(error){entryError(prefix,error.message,inp);}});
      inp.addEventListener('keydown',e=>{if(e.key!=='Enter')return;e.preventDefault();const inputs=[...inp.closest('[data-role-card]').querySelectorAll('[data-stat-input]')].filter(x=>x.getClientRects().length),next=inputs[inputs.indexOf(inp)+1];if(next)next.focus();else if(ROLES.indexOf(entryRoleState[prefix])<4)showEntryRole(prefix,ROLES[ROLES.indexOf(entryRoleState[prefix])+1]);});
    });
    $$(`${target} [data-apply-quick]`).forEach(b=>b.onclick=()=>{const [role,side]=b.dataset.applyQuick.split('-');try{const values=parseQuickStats($(target).querySelector(`[data-quick-role="${role}"][data-quick-side="${side}"]`).value);for(const[k,v]of Object.entries(values))$(`#${prefix}-${role}-${side}-${k}`).value=v??'';changed();}catch(error){entryError(prefix,error.message);}});
    $$(`${target} [data-quick-side]`).forEach(inp=>inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();$(target).querySelector(`[data-apply-quick="${inp.dataset.quickRole}-${inp.dataset.quickSide}"]`).click();}}));
    $$(`${target} [data-exclude-role]`).forEach(inp=>inp.addEventListener('change',()=>{modeObj[inp.dataset.excludeRole]=inp.checked?'U':'S';persistGameDraft(prefix);}));
    $(`#${prefix}-allow-partial`).checked=!!readGameDraft(prefix)?.allowPartial;
    $(`#${prefix}-allow-partial`).onchange=()=>persistGameDraft(prefix);
    refreshStatAssessments(prefix,roleMap,modeObj,statsObj);
  }
  function collectStatsFromDom(prefix,statsObj,requireCore=true){
    let ok=true;
    for(const r of ROLES){statsObj[r]||={A:emptyGameStat(),B:emptyGameStat()};for(const side of ['A','B'])for(const key of ['level','k','d','a','cs','gold','damage']){
      const el=$(`#${prefix}-${r}-${side}-${key}`); if(!el)continue;const v=numOrNull(el.value);statsObj[r][side][key]=v;
      const min=key==='level'?1:0,max=key==='level'?20:['gold','damage'].includes(key)?1000000:10000;
      const valid=v!==null&&Number.isSafeInteger(v)&&v>=min&&v<=max;
      el.setAttribute('aria-invalid',!valid&&(requireCore||el.value!=='')?'true':'false'); if(requireCore&&!valid)ok=false;
    }} return ok;
  }
  function refreshStatAssessments(prefix,roleMap,modeObj,statsObj){
    collectStatsFromDom(prefix,statsObj,false);
    for(const r of ROLES){const a=roleStatAssessment(r,statsObj,durationFor(prefix)),box=$(`#${prefix}-assessment-${r}`);if(!box)continue;

      if(!a){box.innerHTML='<span>수치상 비교</span><b>양 팀에서 함께 입력한 수치만 비교합니다</b>';continue;}
      const detail=a.parts.map(x=>`${x.label}: ${Math.abs(x.diff)<.1?'두 팀이 비슷':`${x.diff>0?'A':'B'}팀이 더 높음`}`).join(' · ');
      box.innerHTML=`<span>확인한 같은 역할의 수치 비교</span><b>${a.adv==='E'?'입력한 수치에서는 두 선수가 비슷한 편':`${a.adv}팀 선수가 입력한 수치에서 앞서는 편`}</b><small>${escapeHtml(detail)}</small><small>${r==='SUP'?'골드·CS·레벨·피해량은 지원 역할 평가에서 제외':a.growthParts.cs===null?'CS는 입력하지 않아 비교에서 뺐습니다. 누락만으로 불이익을 주지 않습니다.':'입력한 CS도 함께 참고했습니다.'}${prefix==='past'&&!$('#pastRolesConfirmed').checked?' · 역할 미확정이므로 이 배치로 실력을 보정하지 않습니다.':''}</small><details><summary>수치 비교의 계산값</summary><small>전체 비교값 ${a.score>=0?'+':''}${a.score.toFixed(3)} · 양수는 A팀, 음수는 B팀의 입력 수치가 더 높다는 뜻입니다. 이 경기 수치의 비교이며 전체 실력을 확정하지 않습니다.</small></details>`;
    }
  }
  function resolveStatResult(modeObj,statsObj,duration){return deriveResult(statsObj,duration,modeObj);}
  function draftKey(prefix){return prefix==='past'&&pastEditing?`naejun_game_edit_v6_${pastEditing.recordId}`:`naejun_game_draft_v6_${prefix}`;}
  function persistGameDraft(prefix){
    try { const draft=prefix==='live'?{...resultDraft,activeRole:entryRoleState.live,allowPartial:$('#live-allow-partial')?.checked,roles:resultDraft.roles,duration:durationFor(prefix)}:{id:window._pastRecordId,editing:pastEditing,activeRole:entryRoleState.past,allowPartial:$('#past-allow-partial')?.checked,stats:window._pastStats,mode:window._pastMode,duration:durationFor(prefix),winner:$('#pastWinner').value,rolesConfirmed:$('#pastRolesConfirmed').checked,date:$('#pastDate').value,roles:pastRoleMapFromSelectors(false).roleMap};localStorage.setItem(draftKey(prefix),JSON.stringify(draft));if(prefix==='live')$('#resumeDraftBtn').hidden=false;
      if(prefix==='live'&&sharedStore?.enabled){state.activeDraft={...clone(draft),id:resultDraft.id};clearTimeout(persistGameDraft.timer);persistGameDraft.timer=setTimeout(()=>save(),600);}
    }
    catch { $('#saveStatus').textContent='초안을 기기에 저장하지 못했습니다 · 입력은 화면에 남아 있습니다'; }
  }
  function readGameDraft(prefix){try { return JSON.parse(localStorage.getItem(draftKey(prefix))||'null'); }catch{return null;}}
  function clearGameDraft(prefix){if(prefix==='live')clearTimeout(persistGameDraft.timer);try {localStorage.removeItem(draftKey(prefix));if(prefix==='live')$('#resumeDraftBtn').hidden=true;}catch{}}

  function renderParticipantGrid(){
    const sel=new Set(state.session.selectedIds);
    const sorted=[...state.roster].sort(comparePlayerNames);
    $("#participantGrid").innerHTML=sorted.map(p=>`<button class="participant-card ${sel.has(p.id)?"selected":""}" data-id="${p.id}" aria-pressed="${sel.has(p.id)}"><span class="check" aria-hidden="true">✓</span><strong>${escapeHtml(p.name)}</strong>${tierFacts(p)}<span class="position-label">가능 포지션</span>${positionChips(p)}</button>`).join("");
    $$("#participantGrid .participant-card").forEach(btn=>btn.onclick=()=>toggleParticipant(btn.dataset.id));
    $("#selectedCounter").textContent=`${sel.size} / 10`;
    $('#sharedDraftBtn').hidden=!sharedStore?.enabled||!state.activeDraft;
    $("#generateBtn").disabled=sel.size!==10; $("#addFixedGroupBtn").disabled=sel.size!==10;
  }

  function correctionText(p){const d=tierCorrection(p);return Math.abs(d)<.05?'기준과 비슷하게 추정':`기준보다 ${Math.abs(d)<.5?'조금 ':''}${d<0?'강하게':'약하게'} 추정`;}
  function roleReading(p,r){const e=roleEvidence(p,r);if(!p.possible[r])return '현재 배치하지 않는 역할';if(!e.games)return e.observations?'경기 수치만 참고 · 승패 기록 없음':'전적 없음 · 매칭은 기준 참고';return `${e.games}경기 반영 · ${e.games<5?'더 지켜볼 추정':'상대와 경기 흐름에 따라 달라짐'}`;}
  function roleEstimateText(p,r){const e=roleEvidence(p,r);if(!e.games&&!e.observations)return `역할 전적 없음 · 매칭 참고 ${fmt(roleTier(p,r))}`;if(!e.games)return `수치만 참고 ${fmt(roleTier(p,r))} · 승패 기록 필요`;return `역할 추정 ${fmt(roleTier(p,r))} · ${e.games}경기 참고`;}
  function teamReading(c){return c.totalGap<=1?'전체 실력이 비슷한 편':c.totalGap<=2?'전체 실력에 약간 차이':`${c.tierSumA<c.tierSumB?'A':'B'}팀 전체 실력이 더 높게 추정`;}
  function laneReading(c){const gaps=[c.topGap,c.jgGap,c.midGap,c.adcGap,c.supGap],max=Math.max(...gaps),r=ROLES[gaps.indexOf(max)];return max<=1?'다섯 역할의 격차가 작은 편':`${ROLE_KR[r]}에서 ${max<=2?'조금 차이가 남음':'큰 차이가 남음'}`;}
  function winReading(c){return c.unratedAssignments?'전적이 없는 역할의 기록이 더 필요':c.predictedAWin>.55?'A팀이 유리하게 추정':c.predictedAWin<.45?'B팀이 유리하게 추정':'승부가 가까울 것으로 추정';}

  function tierFacts(p){return `<span class="tier-facts"><span class="tier-fact"><span class="tier-fact-label">기준 티어</span><span class="tier-fact-value">${fmt(p.baseTier)}<span class="tier-unit">티어</span></span></span><span class="tier-fact estimated"><span class="tier-fact-label">추정 티어</span><span class="tier-fact-value">${fmt(estimatedTier(p))}<span class="tier-unit">티어</span></span></span></span>`;}
  function positionChips(p){return `<span class="position-chips">${ROLES.filter(r=>p.possible[r]).map(r=>`<span class="position-chip">${ROLE_KR[r]}</span>`).join('')}</span>`;}

  function toggleParticipant(id){
    const a=state.session.selectedIds, idx=a.indexOf(id);
    if(idx>=0){a.splice(idx,1);for(const value of Object.values(state.session.fixedRoles||{}))for(const side of ['A','B'])if(value[side]===id)delete value[side];state.session.fixedGroups=state.session.fixedGroups.filter(g=>!g.includes(id));}
    else{if(a.length>=10){toast("참가자는 10명까지만 선택할 수 있습니다.");return;}a.push(id);}
    invalidatePlans();save();renderAll();
  }

  function invalidatePlans(){if(worker){worker.terminate();worker=null;}showLoading(false);currentPlans=[];$('#resultSection').classList.add('hidden');}
  function persistMatchingSession(){try{localStorage.setItem('naejun_session_v6',JSON.stringify(state.session));}catch{toast('편성 설정을 기기에 저장하지 못했습니다. 화면에는 남아 있습니다.');}}
  function renderFixedRoles(){
    state.session.fixedRoles ||= {};const people=selectedPlayers().slice().sort(comparePlayerNames),used=new Set(Object.values(state.session.fixedRoles).flatMap(v=>[v.A,v.B]).filter(Boolean));
    $('#fixedRoleChoices').innerHTML=`<div class="fixed-role-labels"><span>라인</span><b>A팀</b><b>B팀</b></div>`+ROLES.map(r=>`<div class="fixed-role-row"><b>${ROLE_KR[r]}</b>${['A','B'].map(side=>{const value=state.session.fixedRoles[r]?.[side]||'';return `<select aria-label="${ROLE_KR[r]} ${side}팀 고정 선수" data-fixed-role="${r}" data-fixed-side="${side}"><option value="">자동 배정</option>${people.map(p=>`<option value="${escapeHtml(p.id)}" ${p.id===value?'selected':''} ${!p.possible[r]||(used.has(p.id)&&p.id!==value)?'disabled':''}>${escapeHtml(p.name)}${p.possible[r]?'':' · 배치 불가'}</option>`).join('')}</select>`;}).join('')}</div>`).join('');
    $('#matchConstraintStatus').textContent=used.size?`${used.size}자리 고정 · 나머지 자동 배정 · 이 브라우저에 보존`:'고정 없음 · 가능한 역할 안에서 모두 자동 배정';
    $$('#fixedRoleChoices select').forEach(el=>el.onchange=()=>{const r=el.dataset.fixedRole,side=el.dataset.fixedSide;state.session.fixedRoles[r]||={};if(el.value)state.session.fixedRoles[r][side]=el.value;else delete state.session.fixedRoles[r][side];invalidatePlans();$('#matchConstraintError').hidden=true;persistMatchingSession();renderFixedRoles();});
  }

  function renderFixedGroups(){
    const box=$("#fixedGroups");
    if(!state.session.fixedGroups.length){box.innerHTML='<div class="empty-note">고정 그룹 없음. 2~5명이 같은 장소라 반드시 한 팀이어야 할 때만 추가하세요.</div>';return;}
    box.innerHTML=state.session.fixedGroups.map((g,i)=>`<div class="group-chip"><div><small class="eyebrow">GROUP ${i+1}</small><div class="names">${g.map(id=>playerById(id)).filter(Boolean).sort(comparePlayerNames).map(p=>escapeHtml(p.name)).join(" · ")}</div></div><button class="remove-group" data-i="${i}">삭제</button></div>`).join("");
    $$(".remove-group").forEach(b=>b.onclick=()=>{state.session.fixedGroups.splice(Number(b.dataset.i),1);invalidatePlans();save();renderFixedGroups();});
  }

  function renderTierList(target,onlySelected=false){
    const people=(onlySelected?selectedPlayers():state.roster).slice().sort(comparePlayerNames);
    $(target).innerHTML=`<section class="role-tier-section"><h3>역할별 티어 · 가나다순</h3><p class="field-help">기준은 사람이 정한 출발점입니다. 역할 값은 내전 팀을 나누기 위한 추정이며 공식 랭크나 사람의 가치를 뜻하지 않습니다. 전적이 없는 역할은 —로 표시하고 매칭에서는 기준 티어를 참고합니다. 적은 경기는 더 지켜볼 추정입니다.</p><div class="role-tier-scroll"><table class="role-tier-table"><caption>선수별 기준·전체·다섯 역할 추정</caption><thead><tr><th scope="col">선수</th><th scope="col">기준</th><th scope="col">전체</th>${ROLES.map(r=>`<th scope="col">${ROLE_KR[r]}</th>`).join('')}</tr></thead><tbody>${people.map(p=>`<tr><th scope="row"><button type="button" class="text-btn" data-profile-id="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button></th><td>${fmt(p.baseTier)}</td><td>${fmt(estimatedTier(p))}</td>${ROLES.map(r=>{const e=roleEvidence(p,r);return `<td class="${p.possible[r]?'':'unavailable-role'}"><b>${e.games||e.observations?fmt(roleTier(p,r)):'—'}</b><small>${roleReading(p,r)}</small></td>`;}).join('')}</tr>`).join('')}</tbody></table></div></section>`;
    $(target).querySelectorAll('[data-profile-id]').forEach(b=>b.onclick=()=>openPlayerDetail(b.dataset.profileId));
  }

  function renderRoster(){
    renderTierList("#tierListRoster",false);
    const sorted=[...state.roster].sort(comparePlayerNames);
    $("#rosterList").innerHTML=sorted.map(p=>{
      const roleLine=ROLES.filter(r=>p.possible[r]).map(r=>`${ROLE_KR[r]} ${roleEvidence(p,r).games||roleEvidence(p,r).observations?fmt(roleTier(p,r)):"전적 없음"}`).join(" · ");
      const correction=tierCorrection(p),delta=`${correction<0?"-":"+"}${Math.abs(correction).toFixed(2)}`;
      return `<div class="roster-card"><div class="roster-main roster-open" data-detail-id="${p.id}"><div class="roster-name">${escapeHtml(p.name)} <span class="badge">추정 ${fmt(estimatedTier(p))}</span></div><div class="roster-meta">기준 ${fmt(p.baseTier)} · ${correctionText(p)} · ${recordText(p)}</div><div class="roster-meta role-estimates">${escapeHtml(roleLine)}</div><div class="roster-meta">가능: ${escapeHtml(possibleText(p))} · 불가능: ${escapeHtml(impossibleText(p))}</div></div><div class="roster-actions"><button class="detail-btn" data-detail-id="${p.id}">상세</button><button class="edit-btn" data-id="${p.id}">수정</button></div></div>`;
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
    return rows.sort((a,b)=>new Date(b.record.time||b.record.loggedAt)-new Date(a.record.time||a.record.loggedAt));
  }

  function detailRoleStats(p){
    const out=Object.fromEntries(ROLES.map(r=>[r,{games:0,wins:0,losses:0,better:0,even:0,worse:0,unknown:0,provisional:0}]));
    for(const x of playerMatchRows(p)){
      if(x.record.rolesConfirmed===false&&!x.record.roleAssessmentProvisional)continue;const s=out[x.role];s.games++;if(x.record.rolesConfirmed===false)s.provisional++;if(x.won===true)s.wins++;else if(x.won===false)s.losses++;
      if(x.lane==="우세")s.better++;else if(x.lane==="비슷")s.even++;else if(x.lane==="열세")s.worse++;else s.unknown++;
    }
    return out;
  }

  function tierTrendSvg(p){
    const pts=tierTrendPoints(p);
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
    const sorted=[...state.roster].sort((a,b)=>estimatedTier(a)-estimatedTier(b)||comparePlayerNames(a,b)),rank=sorted.findIndex(x=>x.id===id)+1;
    const matches=playerMatchRows(p),games=matches.length,wins=matches.filter(x=>x.won===true).length,losses=matches.filter(x=>x.won===false).length,knownGames=wins+losses,winRate=knownGames?100*wins/knownGames:0,rs=detailRoleStats(p);
    const roleCards=ROLES.map(r=>{const st=rs[r],wr=(st.wins+st.losses)?100*st.wins/(st.wins+st.losses):0,possible=p.possible[r];return `<div class="role-detail-row ${possible?"":"role-disabled"}"><div><strong>${ROLE_KR[r]}</strong><small>${possible?(st.games?(st.games<=2?"초기 역할 추정":"현재 역할 추정"):"역할 전적 없음 · 기준값 참고"):"현재 배치 불가"}</small></div><div class="role-detail-tier">${possible&&(roleEvidence(p,r).games||roleEvidence(p,r).observations)?fmt(roleTier(p,r)):"—"}</div><div><b>${st.games}경기${st.provisional?` · 임시 ${st.provisional}`:""}</b><small>${(st.wins+st.losses)?`${wr.toFixed(0)}% 승률`:"승패 미기록"}</small></div><div><b class="qualitative-value">수치상 앞섬 ${st.better}경기</b><small>비슷 ${st.even} · 뒤처짐 ${st.worse} · 미확인 ${st.unknown}</small></div></div>`;}).join("");
    const recent=matches.slice(0,8).map(x=>`<div class="player-game-row"><span class="wl ${x.won===null?"unknown":x.won?"win":"loss"}">${x.won===null?"?":x.won?"W":"L"}</span><div><strong>${x.record.rolesConfirmed===false?"역할 미확정":x.role+" vs "+escapeHtml(x.opponentName)}</strong><small>${x.record.time?new Date(x.record.time).toLocaleDateString("ko-KR",{month:"numeric",day:"numeric"}):"날짜 미입력"} · ${x.record.pendingReasons?.length?"선택 정보 미입력: "+escapeHtml(x.record.pendingReasons.join(" · ")):"수치 "+x.lane} · ${x.record.source==="past"?"지난 전적":"실시간"}</small></div><button type="button" class="secondary-btn" data-edit-record="${escapeHtml(x.record.id)}">전적 수정</button></div>`).join("")||'<div class="empty-note">기록된 경기가 없습니다.</div>';
    const autoDelta=tierCorrection(p);
    $("#playerDetailContent").innerHTML=`<div class="player-detail-hero"><div><p class="eyebrow">PLAYER PROFILE</p><h2>${escapeHtml(p.name)}</h2><p>내전 ${games}경기 · 가능 ${escapeHtml(possibleText(p))}</p></div><div class="detail-tier-orb"><span>추정</span><b>${fmt(estimatedTier(p))}</b></div></div><div class="detail-summary-grid"><div><small>기준 티어</small><b>${fmt(p.baseTier)}</b></div><div><small>현재 해석</small><b class="qualitative-value">${correctionText(p)}</b></div><div><small>전적</small><b>${games?`${wins}승 ${losses}패`:"—"}</b></div><div><small>승률</small><b>${knownGames?`${winRate.toFixed(0)}%`:"—"}</b></div></div><section class="player-detail-section"><div class="detail-section-head"><div><h3>추정 티어 변화</h3><p>과거 점과 현재 모형의 추정을 구별합니다. 변화는 기준 티어를 덮어쓰지 않습니다.</p></div></div>${tierTrendSvg(p)}</section><section class="player-detail-section"><div class="detail-section-head"><div><h3>포지션별 기록</h3><p>현재 역할 추정치와 수치상 비교 기록을 함께 봅니다.</p></div></div><div class="role-detail-list">${roleCards}</div></section><section class="player-detail-section"><div class="detail-section-head"><div><h3>최근 경기</h3><p>최근 8경기에서 맡은 역할과 상대, 라인 판정입니다.</p></div></div><div class="player-game-list">${recent}</div></section>`;
    $$('#playerDetailContent [data-edit-record]').forEach(button=>button.onclick=()=>{$('#playerDetailDialog').close();openPastDialog(button.dataset.editRecord);});
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
    $("#gamesBadge").textContent=`${state.history.length}경기 · 티어 반영 ${state.model.gamesLearned}경기`;
    const items=[...state.history].sort((a,b)=>new Date(b.time||b.loggedAt)-new Date(a.time||a.loggedAt)).slice(0,historyLimit);
    $("#historyList").innerHTML=items.length?items.map(h=>{
      const adv=h.roleAdv?ROLES.map(r=>{const src=h.roleAdvSource?.[r]==="stats"||["five-inputs","available-inputs"].includes(h.roleAdvSource?.[r])?"수치":"";const sc=Number(h.statAssessment?.[r]?.score);return `${r} ${advShort(h.roleAdv[r]||"U")}${src&&Number.isFinite(sc)?`(${sc>=0?"+":""}${sc.toFixed(2)})`:""}`;}).join(" · "):"포지션 우세 미기록";
      const source=h.source==="past"?"지난 전적":"실시간";
      return `<div class="history-item"><div class="history-top"><div class="history-title">${h.plan?`${h.plan}안 · `:""}${h.winner?`${h.winner}팀 승리`:"승패 미기록"} <span class="history-source">${source}</span></div><div class="history-date">${h.time?new Date(h.time).toLocaleString("ko-KR",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}):"경기 날짜 미입력"} · ${escapeHtml(h.duration||"")}</div></div><div class="history-sub">${h.pendingReasons?.length?"선택 정보 미입력: "+escapeHtml(h.pendingReasons.join(" · ")):adv}</div><div class="history-sub">${h.ratingApplied===false?"원본 저장 · 비교값 없음":h.pendingReasons?.length?"티어 반영 · 미입력 항목 제외":`당시 예상: ${Number(h.predictedAWin??.5)>.55?"A팀이 유리하게 추정":Number(h.predictedAWin??.5)<.45?"B팀이 유리하게 추정":"승부가 가까울 것으로 추정"}`}</div><div class="history-sub">${h.rolesConfirmed===false?"역할 미확정 · 아래는 임시 배치: ":""}${ROLES.map(r=>`${ROLE_KR[r]}: ${escapeHtml(h.roles?.[r]?.aName||"미확인")} / ${escapeHtml(h.roles?.[r]?.bName||"미확인")}`).join(" · ")}</div><button type="button" class="secondary-btn" data-edit-record="${escapeHtml(h.id)}">전적 수정</button></div>`;
    }).join(""):'<div class="empty-note">아직 기록한 경기가 없습니다.</div>';
    $$('#historyList [data-edit-record]').forEach(button=>button.onclick=()=>openPastDialog(button.dataset.editRecord));
    $('#historyMoreBtn').hidden=state.history.length<=historyLimit;
  }

  function renderCriteria(){
    if($('#modelStateSummary'))$('#modelStateSummary').textContent=`현재 등록 ${state.history.length}경기 · 역할별 표에서 경기 수와 초기 추정을 확인하세요.`;
    const labels=["TOP","JG","MID","BOT"],target=$("#criteriaWeightBars");
    if(target)target.innerHTML=labels.map((l,i)=>{const w=state.model.weights[i],pct=Math.max(10,Math.min(100,w/1.8*100));return `<div class="weight-item"><div class="weight-label">${l}</div><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><div class="weight-value">${w.toFixed(3)}</div></div>`;}).join("");
    const games=state.model.gamesLearned||0;
    if($("#criteriaGames"))$("#criteriaGames").textContent=`${games}경기 학습`;
    if($("#modelStatus"))$("#modelStatus").textContent=games<10?"초기값 중심":games<30?"실전 보정 중":"누적 데이터 반영";
  }
  function renderAll(){renderParticipantGrid();renderFixedGroups();renderFixedRoles();renderRoster();renderHistory();renderCriteria();}

  function roleGapLabel(g){if(g<=1)return"비슷한 편";if(g<=2)return"조금 차이";return"격차 큼";}
  function verdict(c){if(c.unratedAssignments)return ['전적이 더 필요한 역할 포함','uncertain'];const maxCore=Math.max(c.topGap,c.jgGap,c.midGap),pd=Math.abs(c.predictedAWin-.5);if(c.totalGap<=1&&maxCore<=1&&c.botGap<=.75&&pd<=.04)return["계산된 격차가 작은 구성","great"];if(c.totalGap<=2&&maxCore<=1.5&&c.botGap<=1&&pd<=.06)return["비교적 고른 구성","good"];if(maxCore<=2&&c.botGap<=1.5&&pd<=.08)return["조건 안에서 맞춘 구성","ok"];return["일부 역할에 격차가 남음","bad"];}
  function teamStrengthText(c,players){
    const a=[],b=[]; [["TOP",0],["JG",1],["MID",2]].forEach(([role,i])=>{const ta=roleTier(players[c.assignA[i]],role),tb=roleTier(players[c.assignB[i]],role);if(ta<tb)a.push(ROLE_KR[role]);else if(tb<ta)b.push(ROLE_KR[role]);});
    if(c.botIndexA<c.botIndexB-.01)a.push("바텀");else if(c.botIndexB<c.botIndexA-.01)b.push("바텀");
    if(a.length&&b.length)return `A팀은 ${a.join("·")}, B팀은 ${b.join("·")} 쪽이 상대적으로 강해 우세가 한쪽에만 몰리지 않습니다.`;
    if(a.length)return `주요 역할 우세가 A팀(${a.join("·")})에 다소 몰려 있습니다.`;if(b.length)return `주요 역할 우세가 B팀(${b.join("·")})에 다소 몰려 있습니다.`;return"주요 역할의 계산상 우열이 거의 없습니다.";
  }
  function explain(c,players){const gaps=[c.topGap,c.jgGap,c.midGap,c.adcGap,c.supGap],max=Math.max(...gaps),r=ROLES[gaps.indexOf(max)],p=[];p.push(max<=1?'특정 한 역할에 큰 격차가 몰리지 않도록 배치했습니다.':`${ROLE_KR[r]}에서 가장 큰 추정 차이가 남습니다. 이 역할의 차이까지 없앨 수 있는 구성은 아닙니다.`);p.push(teamStrengthText(c,players));const fixed=Object.values(state.session.fixedRoles||{}).flatMap(v=>[v.A,v.B]).filter(Boolean).length;if(fixed)p.push(`지정한 ${fixed}자리를 그대로 지키고, 나머지 선수와 역할을 조정해 찾은 구성입니다.`);return p;}


  function renderPlans(){
    const players=selectedPlayers();renderTierList("#tierListResult",true);$("#planCountBadge").textContent=`${currentPlans.length}개`;const first=currentPlans[0];
    $("#plansContainer").innerHTML=`<div class="plan-overview"><table><caption>${currentPlans.length}안 빠른 비교 · 서로 다른 팀 구성</caption><thead><tr><th>구성</th><th>전체 균형</th><th>라인별 균형</th><th>경기 예상</th></tr></thead><tbody>${currentPlans.map((c,i)=>`<tr><th>${i+1}안</th><td>${teamReading(c)}</td><td>${laneReading(c)}</td><td>${winReading(c)}</td></tr>`).join('')}</tbody></table><p class="field-help">승률은 모형 추정입니다. 전체와 역할 격차를 먼저 비교하고, 기록이 적은 역할은 초기 추정으로 봅니다.</p></div><div class="plan-tabs" aria-label="팀 구성 선택">${currentPlans.map((c,i)=>`<button type="button" class="secondary-btn" data-show-plan="${i}" aria-pressed="${i===0}">${i+1}안 · ${i===0?'격차 최소':'다른 구성'}</button>`).join('')}</div>`+currentPlans.map((c,idx)=>{
      const [v,cls]=verdict(c),ex=explain(c,players),changeText=idx===0?"최저 밸런스 점수":`${first?popcount((first.teamMaskA^c.teamMaskA)>>>0)/2:0}명 교체 구성`;
      const teamA=c.assignA.map(i=>players[i]).sort(comparePlayerNames).map(p=>p.name).join(" · "),teamB=c.assignB.map(i=>players[i]).sort(comparePlayerNames).map(p=>p.name).join(" · ");
      const rows=ROLES.map((r,i)=>{const a=players[c.assignA[i]],b=players[c.assignB[i]],ta=roleTier(a,r),tb=roleTier(b,r),gap=Math.abs(ta-tb);return `<div class="match-row"><div class="role-tag">${ROLE_KR[r]}</div><div class="player-side a"><div class="player-name">${escapeHtml(a.name)}${state.session.fixedRoles?.[r]?.A===a.id?'<small class="fixed-slot-badge">고정</small>':''}</div><div class="player-tier">${roleEstimateText(a,r)}</div></div><div class="vs">VS</div><div class="player-side b"><div class="player-name">${escapeHtml(b.name)}${state.session.fixedRoles?.[r]?.B===b.id?'<small class="fixed-slot-badge">고정</small>':''} <span class="gap-dot">${!roleEvidence(a,r).games&&!roleEvidence(a,r).observations||!roleEvidence(b,r).games&&!roleEvidence(b,r).observations?"전적 더 필요":roleGapLabel(gap)}</span></div><div class="player-tier">${roleEstimateText(b,r)}</div></div></div>`;}).join("");
      const marker=Math.max(3,Math.min(97,c.predictedAWin*100)),confidence=state.model.gamesLearned<10?"초기치 중심":state.model.gamesLearned<30?"실전 보정 중":"누적 데이터 반영";
      return `<article class="plan-card ${idx===0?"featured":""}" data-plan-card="${idx}" ${idx===0?"":"hidden"}><div class="plan-top"><div><div class="plan-rank">${idx===0?"격차 최소안":idx===1?"다른 팀 구성 1":"다른 팀 구성 2"}</div><div class="plan-subline">${changeText}</div></div><span class="verdict ${cls}">${v}</span></div><div class="team-strip"><div class="team-block"><div class="team-label a">TEAM A</div><div class="team-names">${escapeHtml(teamA)}</div></div><div class="team-block"><div class="team-label b">TEAM B</div><div class="team-names">${escapeHtml(teamB)}</div></div></div><div class="match-table">${rows}</div><div class="plan-reading"><strong>${teamReading(c)}</strong><p>${laneReading(c)} · ${winReading(c)}</p>${c.unratedAssignments?'<p>전적이 없는 역할은 기준 티어를 참고했습니다. 실제 경기로 추정을 보완합니다.</p>':''}</div><details class="plan-numbers"><summary>세부 계산값 보기</summary><p>승률은 모형의 계산값이며 실제 승리를 보장하지 않습니다. 팀 합은 각 역할의 추정 티어를 더한 값이며, 낮을수록 강하게 추정합니다.</p><div class="balance-bar"><div class="balance-bar-top"><span>A ${(c.predictedAWin*100).toFixed(1)}%</span><span>계산한 승률</span><span>B ${((1-c.predictedAWin)*100).toFixed(1)}%</span></div><div class="balance-track"><span class="balance-marker" style="left:${marker}%"></span></div></div><div class="metrics"><div class="metric"><small>역할 티어 합</small><strong>A ${c.tierSumA.toFixed(1)} : B ${c.tierSumB.toFixed(1)}</strong></div><div class="metric"><small>탑 · 정글 · 미드 격차</small><strong>${c.topGap.toFixed(1)} / ${c.jgGap.toFixed(1)} / ${c.midGap.toFixed(1)}</strong></div><div class="metric"><small>원딜·서포터의 평균</small><strong>A ${c.botIndexA.toFixed(2)} : B ${c.botIndexB.toFixed(2)}</strong></div><div class="metric"><small>원딜 · 서포터 격차</small><strong>${c.adcGap.toFixed(1)} / ${c.supGap.toFixed(1)}</strong></div></div></details><div class="explanation">${ex.map((x,i)=>`<p>${i+1}. ${escapeHtml(x)}</p>`).join("")}</div><button class="play-btn" data-plan="${idx}">이 안으로 경기</button></article>`;
    }).join("")||'<div class="empty-note">조건을 만족하는 팀을 만들 수 없습니다.</div>';
    $$('[data-show-plan]').forEach(b=>b.onclick=()=>{$$('[data-plan-card]').forEach(c=>c.hidden=c.dataset.planCard!==b.dataset.showPlan);$$('[data-show-plan]').forEach(t=>t.setAttribute('aria-pressed',String(t===b)));});
    $$(".play-btn").forEach(b=>b.onclick=()=>openResultDialog(Number(b.dataset.plan)));$("#resultSection").classList.remove("hidden");setTimeout(()=>$("#resultSection").scrollIntoView({behavior:"smooth",block:"start"}),80);
  }

  function showLoading(show,text="가능한 조합을 계산하고 있습니다…"){let el=$("#loadingOverlay");if(show){if(!el){el=document.createElement("div");el.id="loadingOverlay";el.className="loading-overlay";el.innerHTML=`<div class="loading-box"><div class="spinner"></div><strong>${escapeHtml(text)}</strong><p class="muted" style="font-size:12px;margin-top:6px">현재 추정 티어·역할 숙련·고정팀 조건까지 전수 비교합니다.</p></div>`;document.body.appendChild(el);}}else el?.remove();}
  function generate(){if(state.session.selectedIds.length!==10)return;$("#matchConstraintError").hidden=true;showLoading(true);if(worker)worker.terminate();worker=new Worker("matcher-worker.js?v=9-role-readings-20261007",{type:"module"});worker.onmessage=e=>{if(e.data.progress)return;showLoading(false);if(e.data.error){invalidatePlans();$("#matchConstraintError").textContent=e.data.error;$("#matchConstraintError").hidden=false;toast(e.data.error);return;}currentPlans=e.data.plans||[];renderPlans();if(!currentPlans.length)toast("현재 조건으로 가능한 정상 배치가 없습니다.");};worker.onerror=()=>{showLoading(false);toast("계산 중 오류가 발생했습니다.");};worker.postMessage({players:selectedPlayers(),model:state.model,fixedGroups:state.session.fixedGroups,fixedRoles:state.session.fixedRoles});}

  function openMemberDialog(id=null){
    const p=id?playerById(id):null;$("#memberId").value=p?.id||"";$("#memberName").value=p?.name||"";$("#memberTier").value=p?.baseTier??3;$("#memberDialogTitle").textContent=p?"멤버 수정":"새 멤버 추가";$("#memberDialogEyebrow").textContent=p?"EDIT PLAYER":"NEW PLAYER";
    $("#memberImpossibleRoles").innerHTML=ROLES.map(r=>`<label class="role-check"><input type="checkbox" data-role="${r}" ${p&&!p.possible[r]?"checked":""}><span>${r}</span></label>`).join("");
    const info=$("#memberAutoInfo");if(info)info.innerHTML=p?`현재 추정 티어 <b>${fmt(estimatedTier(p))}</b> · ${correctionText(p)} · ${recordText(p)}`:"새 멤버는 기준 티어에서 시작하며 전적을 쌓아 역할별 추정을 보완합니다.";$("#memberDialog").showModal();
  }
  function saveMember(){
    const id=$("#memberId").value,name=$("#memberName").value.trim(),baseTier=Number($("#memberTier").value);if(!name||!Number.isFinite(baseTier)){toast("이름과 기준 티어를 확인해주세요.");return false;}
    const impossible=new Set($$("#memberImpossibleRoles input:checked").map(x=>x.dataset.role)),possible=Object.fromEntries(ROLES.map(r=>[r,!impossible.has(r)]));if(!ROLES.some(r=>possible[r])){toast("최소 한 포지션은 가능해야 합니다.");return false;}
    if(id){const p=playerById(id);p.name=name;p.baseTier=baseTier;p.possible=possible;}else state.roster.push(normalizePlayer({id:`p-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,name,baseTier,possible}));
    invalidatePlans();save();renderAll();toast(id?"멤버 정보를 저장했습니다.":"새 멤버를 저장했습니다.");return true;
  }

  function openGroupDialog(){const used=new Set(state.session.fixedGroups.flat());groupDraft=new Set();$("#groupMemberChoices").innerHTML=state.session.selectedIds.map(playerById).filter(Boolean).sort(comparePlayerNames).map(p=>{const id=p.id,disabled=used.has(id);return `<button type="button" class="participant-card ${disabled?"disabled":""}" data-id="${id}" ${disabled?"disabled":""}><strong>${escapeHtml(p.name)}</strong><small>추정 ${fmt(estimatedTier(p))}${disabled?" · 다른 그룹에 포함":""}</small></button>`;}).join("");$$("#groupMemberChoices .participant-card:not(:disabled)").forEach(b=>b.onclick=()=>{const id=b.dataset.id;if(groupDraft.has(id)){groupDraft.delete(id);b.classList.remove("selected");}else{if(groupDraft.size>=5){toast("한 그룹은 최대 5명입니다.");return;}groupDraft.add(id);b.classList.add("selected");}});$("#groupDialog").showModal();}
  function saveGroup(){if(groupDraft.size<2){toast("같은 팀 고정은 2명 이상 선택해주세요.");return false;}state.session.fixedGroups.push([...groupDraft]);invalidatePlans();save();renderFixedGroups();toast(`${groupDraft.size}명을 같은 팀으로 고정했습니다.`);return true;}

  function predictFeatureFromRoles(roleMap){return teamPrediction(state.roster,roleMap);}

  function liveRoleMap(plan){const ps=selectedPlayers(),map={};ROLES.forEach((r,i)=>{const a=ps[plan.assignA[i]],b=ps[plan.assignB[i]];map[r]={aId:a.id,bId:b.id,aName:a.name,bName:b.name,aTier:roleTier(a,r),bTier:roleTier(b,r)};});return map;}
  function openResultDialog(idx){
    activePlanIndex=idx;
    const c=currentPlans[idx];if(!c)return;const roleMap=liveRoleMap(c);
    if(sharedStore?.enabled&&state.activeDraft&&JSON.stringify(ROLES.map(r=>[state.activeDraft.roles[r].aId,state.activeDraft.roles[r].bId]))!==JSON.stringify(ROLES.map(r=>[roleMap[r].aId,roleMap[r].bId]))){toast('입력 중인 공유 경기가 있습니다. 공유 경기 입력에서 먼저 완료해 주세요.');return;}
    resultDraft={winner:null,roles:roleMap,mode:Object.fromEntries(ROLES.map(r=>[r,"S"])),stats:Object.fromEntries(ROLES.map(r=>[r,{A:emptyGameStat(),B:emptyGameStat()}]))};
    $("#resultDialogTitle").textContent=`${idx+1}안 경기 결과`;
    $("#resultDialogText").textContent="K/D/A·피해량·CS를 입력하고, 탑·정글은 골드·레벨, 미드·원딜은 골드를 추가해 주세요. 확인이 어려우면 아래에서 사후 보충을 선택할 수 있습니다. 시간·승패와 빈 선택 값은 추정하지 않습니다.";
    $$(".winner-choice").forEach(b=>b.classList.remove("active"));
    $("#resultDuration").value="";
    liveServerBase=sharedStore?.enabled&&state.activeDraft?clone(state.activeDraft):null;
    const localDraft=readGameDraft('live');entryRoleState.live=localDraft?.activeRole||'TOP';
    const draft=sharedStore?.enabled&&state.activeDraft?state.activeDraft:localDraft;
    if(draft&&JSON.stringify(ROLES.map(r=>[draft.roles?.[r]?.aId,draft.roles?.[r]?.bId]))===JSON.stringify(ROLES.map(r=>[roleMap[r].aId,roleMap[r].bId]))) { resultDraft={...resultDraft,...draft};$('#resultDuration').value=draft.duration||''; }
    $$('.winner-choice').forEach(b=>b.classList.toggle('active',b.dataset.winner===resultDraft.winner));
    clearEntryError('live');renderStatEntry("#resultStatEntry","live",roleMap,resultDraft.mode,resultDraft.stats);
    if(sharedStore?.enabled){resultDraft.id||=`g-${crypto.randomUUID()}`;state.activeDraft={...clone(resultDraft),duration:durationFor('live')};save();}
    $("#saveResultBtn").disabled=false;$("#resultDialog").showModal();
  }

  function signFromAdv(v){return v==="A"?1:v==="B"?-1:v==="E"?0:null;}
  function ensurePlayer(id){return playerById(id);}
  function clearEntryError(prefix){
    const box=$(`#${prefix==='live'?'result':'past'}SaveError`);box.textContent='';box.hidden=true;
    $(`#${prefix==='live'?'result':'past'}DurationError`).textContent='';
  }
  function entryError(prefix,message,field){
    persistGameDraft(prefix);
    const box=$(`#${prefix==='live'?'result':'past'}SaveError`);box.textContent=message;box.hidden=false;
    if(field){const card=field.closest('[data-role-card]');if(card)showEntryRole(prefix,card.dataset.roleCard);const details=field.closest('details');if(details)details.open=true;field.setAttribute('aria-invalid','true');field.focus();field.scrollIntoView({block:'center',behavior:'smooth'});}
    if(field?.id.endsWith('Duration'))$(`#${prefix==='live'?'result':'past'}DurationError`).textContent=message;
    return false;
  }
  function validateEntry(prefix,stats){
    collectStatsFromDom(prefix,stats,false);clearEntryError(prefix);
    if(durationFor(prefix)&&!normalizeGameDuration(durationFor(prefix)))return entryError(prefix,'게임 시간을 입력해 주세요. 31:42 또는 31분 42초로 입력할 수 있습니다.',$(`#${prefix==='live'?'result':'past'}Duration`));
    const issue=firstStatIssue(stats,true)||(!$(`#${prefix}-allow-partial`)?.checked?requiredRoleIssue(stats):null);
    if(issue)return entryError(prefix,issue.message,$(`#${prefix}-${issue.role}-${issue.side}-${issue.key}`));
    const error=validateGameStats(stats,durationFor(prefix),true);
    if(error)return entryError(prefix,error);
    return true;
  }
  const busyEntryControls=new Map();
  function setEntryBusy(prefix,busy){
    const form=$(`#${prefix==='live'?'result':'past'}Form`);
    form.setAttribute('aria-busy',String(busy));
    if(busy){const controls=[...form.querySelectorAll('input,select,button')].map(el=>[el,el.disabled]);busyEntryControls.set(prefix,controls);for(const [el] of controls)el.disabled=true;}
    else{for(const [el,disabled] of busyEntryControls.get(prefix)||[])el.disabled=disabled;busyEntryControls.delete(prefix);}
  }
  async function commitGame(record){
    const existing=state.history.find(h=>h.id===record.id);
    if(existing&&!sameGameInput(existing,record))throw new Error('이 경기의 이전 입력이 저장 대기 중이거나 이미 저장되었습니다. 상단에서 저장 상태를 확인해 주세요. 바꾼 입력은 초안에 보관했습니다.');
    if(!existing)applyRatingUpdate(state,record);
    if(sharedStore?.enabled){await sharedStore.saveConfirmed(state);}
    else if(!save())throw new Error('기기에 저장하지 못했습니다. 입력을 보존했으니 다시 시도해 주세요.');
  }
  async function saveLiveResult(){
    if(!validateEntry('live',resultDraft.stats))return;
    const c=currentPlans[activePlanIndex];if(!c)return;const roles=resultDraft.roles,resolved=resolveStatResult(resultDraft.mode,resultDraft.stats,durationFor('live'));
    const record={id:resultDraft.id||`g-${crypto.randomUUID()}`,time:new Date().toISOString(),source:'live',plan:activePlanIndex+1,winner:resultDraft.winner,duration:durationFor('live'),predictedAWin:c.predictedAWin,feature:[...c.feature],roles,stats:clone(resultDraft.stats),...resolved};
    resultDraft.id=record.id;persistGameDraft('live');clearTimeout(persistGameDraft.timer);
    const button=$('#saveResultBtn');setEntryBusy('live',true);button.textContent='저장 중…';
    const previousDraft=state.activeDraft;state.activeDraft=null;
    try{await commitGame(record);clearGameDraft('live');$('#resultDialog').close();renderAll();currentPlans=[];$('#resultSection').classList.add('hidden');toast('경기 기록을 저장했습니다.');}
    catch(error){state.activeDraft=previousDraft;entryError('live',error.message);}
    finally{setEntryBusy('live',false);button.textContent='경기 기록 저장';}
  }

  function pastRoleMapFromSelectors(requireAll=false){
    const roleMap={},ids=[];for(const r of ROLES){const aId=$(`#pastA-${r}`)?.value||"",bId=$(`#pastB-${r}`)?.value||"";if(requireAll&&(!aId||!bId))return null;roleMap[r]={aId,bId,aName:playerById(aId)?.name||"선수 선택 전",bName:playerById(bId)?.name||"선수 선택 전",aTier:aId?roleTier(playerById(aId),r):3,bTier:bId?roleTier(playerById(bId),r):3};if(aId)ids.push(aId);if(bId)ids.push(bId);}return {roleMap,ids};
  }
  function openPastDialog(recordId=null){
    const original=recordId?state.history.find(h=>h.id===recordId):null;
    if(recordId&&(!original||validateGameStats(original.stats,original.duration,original.source==='past'))){toast('이 전적은 원본 경기 수치가 부족하여 수정할 수 없습니다. 원본 백업을 확인해 주세요.');return;}
    pastEditing=original?{recordId:original.id,editId:`edit-${crypto.randomUUID()}`,expectedRecord:clone(original)}:null;
    $('#pastDialogTitle').textContent=original?'전적 수정':'지난 전적 입력';
    $('#pastDialogText').textContent=original?'미입력 값은 비워 둘 수 있습니다. 역할 미확정 경기의 배치는 임시이며 확정 전에도 임시 역할로 평가합니다. 역할군을 바꾸면 같은 팀의 두 선수와 수치를 함께 교환합니다. 저장하면 이 경기부터 이후 티어 보정을 다시 계산하고 수정 전 기록을 보관합니다.':'예전 경기의 10명과 결과 수치를 직접 입력합니다. 여러 경기를 넣을 때는 가능하면 오래된 경기부터 입력하세요.';
    $('#savePastBtn').textContent=original?'수정 저장 · 추정 갱신':'지난 전적 저장';
    const edits=original?(state.recordEdits||[]).filter(e=>e.recordId===original.id):[];
    $('#recordEditHistory').hidden=!edits.length;
    $('#recordEditHistory').innerHTML=edits.length?`<details><summary>수정 이력 ${edits.length}건</summary>${edits.slice().reverse().map(e=>`<p>${escapeHtml(new Date(e.time).toLocaleString('ko-KR'))} · 수정 전: ${ROLES.map(r=>`${ROLE_KR[r]} ${escapeHtml(e.before.history[0].roles[r].aName)} / ${escapeHtml(e.before.history[0].roles[r].bName)}`).join(' · ')}</p>`).join('')}</details>`:'';
    const sorted=[...state.roster].sort(comparePlayerNames),options='<option value="">선택</option>'+sorted.map(p=>`<option value="${p.id}">${escapeHtml(p.name)} (추정 ${fmt(estimatedTier(p))})</option>`).join("");
    $("#pastRows").innerHTML=ROLES.map(r=>`<div class="past-row"><strong>${r}</strong><select id="pastA-${r}" class="past-select" aria-label="${ROLE_KR[r]} A팀 선수">${options}</select><span class="vs">VS</span><select id="pastB-${r}" class="past-select" aria-label="${ROLE_KR[r]} B팀 선수">${options}</select></div>`).join("");
    if(original)for(const side of ['A','B']){const teamIds=new Set(ROLES.map(r=>original.roles[r][side==='A'?'aId':'bId']));for(const r of ROLES)for(const option of $(`#past${side}-${r}`).options)option.disabled=!teamIds.has(option.value);}
    $('#pastRolesConfirmed').checked=original?.rolesConfirmed!==false;
    const now=new Date(),local=new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,16);$("#pastDate").value=local;$("#pastWinner").value="";$("#pastDuration").value="";
    window._pastMode=Object.fromEntries(ROLES.map(r=>[r,"S"]));window._pastStats=Object.fromEntries(ROLES.map(r=>[r,{A:emptyGameStat(),B:emptyGameStat()}]));
    const stored=readGameDraft('past');const draft=stored||(original?{id:original.id,stats:clone(original.stats),mode:Object.fromEntries(ROLES.map(r=>[r,original.ratingApplied!==false&&original.roleAdv?.[r]==='U'?'U':'S'])),duration:original.duration,winner:original.winner,roles:original.roles,rolesConfirmed:original.rolesConfirmed!==false,date:original.time?new Date(new Date(original.time).getTime()-new Date(original.time).getTimezoneOffset()*60000).toISOString().slice(0,16):''}:null);if(stored?.editing)pastEditing=stored.editing;entryRoleState.past=draft?.activeRole||'TOP';window._pastRecordId=draft?.id||`past-${crypto.randomUUID()}`;clearEntryError('past');
    if(draft?.roles){window._pastMode=draft.mode;window._pastStats=draft.stats;$('#pastDuration').value=draft.duration||'';$('#pastWinner').value=draft.winner||'';$('#pastDate').value=draft.date??local;$('#pastRolesConfirmed').checked=draft.rolesConfirmed!==false;for(const r of ROLES){$(`#pastA-${r}`).value=draft.roles[r].aId;$(`#pastB-${r}`).value=draft.roles[r].bId;}}
    const byPlayer=new Map();for(const r of ROLES)for(const side of ['A','B']){const id=$(`#past${side}-${r}`).value;if(id)byPlayer.set(id,clone(window._pastStats[r][side]));}
    const refreshPast=()=>{const got=pastRoleMapFromSelectors(false);renderStatEntry("#pastStatEntry","past",got.roleMap,window._pastMode,window._pastStats);};
    refreshPast();$$('#pastRows select').forEach(el=>{el.dataset.previous=el.value;el.addEventListener('change',()=>{
      collectStatsFromDom('past',window._pastStats,false);
      for(const r of ROLES)for(const side of ['A','B']){const selector=$(`#past${side}-${r}`),id=selector.dataset.previous;if(id)byPlayer.set(id,clone(window._pastStats[r][side]));}
      const side=el.id.match(/^past([AB])-/)[1],previous=el.dataset.previous;
      if(pastEditing){const other=$$('#pastRows select').find(s=>s!==el&&s.id.startsWith(`past${side}-`)&&s.value===el.value);if(other)other.value=previous;}
      for(const r of ROLES)for(const team of ['A','B']){const selector=$(`#past${team}-${r}`);window._pastStats[r][team]=clone(byPlayer.get(selector.value)||emptyGameStat());selector.dataset.previous=selector.value;}
      refreshPast();persistGameDraft('past');
    });});$('#pastDialog').showModal();

  }
  function showRecordConflicts(error,request){
    entryError('past',error.message);const box=$('#pastSaveError'),latest=error.data.latestRecord;
    const labels={level:'레벨',k:'킬',d:'데스',a:'어시스트',cs:'CS',gold:'골드',damage:'피해량',winner:'승리팀',duration:'게임 시간',time:'날짜',rolesConfirmed:'역할 확인'};
    const choices=error.data.conflicts.map((c,i)=>{const parts=c.field.split('.'),person=parts[0]==='statsByPlayer'?playerById(parts[1])?.name:null,label=person?`${person} ${labels[parts[2]]||parts[2]}`:c.field.startsWith('roles.')?`${ROLE_KR[parts[1]]} 선수 배치`:labels[c.field]||c.field;return `<label style="display:block;margin-top:12px">${escapeHtml(label)}<select data-conflict-choice="${i}" aria-label="${escapeHtml(label)} 충돌 값 선택" style="max-width:100%;width:100%"><option value="">저장할 값 선택</option><option value="local">내 입력: ${escapeHtml(c.local??'미입력')}</option><option value="remote">서버 값: ${escapeHtml(c.remote??'미입력')}</option></select></label>`;}).join('');
    box.insertAdjacentHTML('beforeend',choices+'<button type="button" class="primary-btn" id="resolveRecordConflict" style="margin-top:16px;width:100%">선택한 값으로 저장</button>');
    $('#resolveRecordConflict').onclick=async()=>{
      const selects=$$('[data-conflict-choice]');if(selects.some(s=>!s.value)){selects.find(s=>!s.value).focus();return;}
      const {rebaseRecordEdit}=await import('./record-edits.js?v=9-role-readings-20261007');
      const resolutions=Object.fromEntries(error.data.conflicts.map((c,i)=>[c.field,selects[i].value]));
      const merged=rebaseRecordEdit(request.expectedRecord,request.input,latest,resolutions);
      pastEditing={recordId:latest.id,editId:`edit-${crypto.randomUUID()}`,expectedRecord:clone(latest)};
      window._pastStats=clone(merged.stats);window._pastMode=clone(merged.roleAdv);
      for(const r of ROLES)for(const side of ['A','B'])$(`#past${side}-${r}`).value=merged.roles[r][side==='A'?'aId':'bId'];
      $('#pastDuration').value=merged.duration;$('#pastWinner').value=merged.winner||'';$('#pastRolesConfirmed').checked=merged.rolesConfirmed;
      $('#pastDate').value=merged.time?new Date(new Date(merged.time).getTime()-new Date(merged.time).getTimezoneOffset()*60000).toISOString().slice(0,16):'';
      renderStatEntry('#pastStatEntry','past',pastRoleMapFromSelectors(false).roleMap,window._pastMode,window._pastStats);persistGameDraft('past');await savePastMatch();
    };
    return false;
  }
  async function savePastMatch(){
    collectStatsFromDom('past',window._pastStats,false);clearEntryError('past');
    const got=pastRoleMapFromSelectors(true);
    if(!got){const empty=$$('#pastRows select').find(el=>!el.value);return entryError('past','A/B팀의 다섯 포지션 선수를 모두 선택해 주세요.',empty);}
    const {roleMap,ids}=got;
    if(new Set(ids).size!==10)return entryError('past','한 선수는 한 경기에서 한 포지션만 맡을 수 있습니다. 중복 선택을 확인해 주세요.');
    if(!validateEntry('past',window._pastStats))return false;
    const date=$('#pastDate').value;
    if(date&&!Number.isFinite(new Date(date).getTime()))return entryError('past','경기 시각을 확인하거나 비워 주세요.',$('#pastDate'));
    const winner=$('#pastWinner').value||null,pred=predictFeatureFromRoles(roleMap),resolved=resolveStatResult(window._pastMode,window._pastStats,durationFor('past'));
    const unchangedEditDate=pastEditing?.expectedRecord.time?new Date(new Date(pastEditing.expectedRecord.time).getTime()-new Date(pastEditing.expectedRecord.time).getTimezoneOffset()*60000).toISOString().slice(0,16):null;
    const record={id:window._pastRecordId,time:pastEditing&&date&&date===unchangedEditDate?pastEditing.expectedRecord.time:date?new Date(date).toISOString():null,source:'past',plan:null,winner,duration:durationFor('past'),predictedAWin:pred.predictedAWin,feature:pred.feature,roles:roleMap,stats:clone(window._pastStats),...resolved};
    record.rolesConfirmed=$('#pastRolesConfirmed').checked;record.pendingReasons=recordPendingReasons(record);
    persistGameDraft('past');
    let editRequest=null;const button=$('#savePastBtn');setEntryBusy('past',true);button.textContent='저장 중…';
    try{if(pastEditing){
      const input={id:pastEditing.recordId,time:record.time,winner:record.winner,duration:record.duration,rolesConfirmed:record.rolesConfirmed,roles:Object.fromEntries(ROLES.map(r=>[r,{aId:record.roles[r].aId,bId:record.roles[r].bId}])),stats:record.stats,roleAdv:record.roleAdv};
      const request={...pastEditing,input};editRequest=request;
      if(sharedStore?.enabled)await sharedStore.editRecord(request);
      else{const {editRecord}=await import('./record-edits.js?v=9-role-readings-20261007');const previous=state;state=editRecord(state,request,'participant');if(!save()){state=previous;throw new Error('기기에 저장하지 못했습니다. 수정 초안은 보존했습니다.');}}
    }else await commitGame(record);clearGameDraft('past');$('#pastDialog').close();renderAll();currentPlans=[];$('#resultSection').classList.add('hidden');toast(!pastEditing&&record.ratingApplied===false?'원본을 저장했습니다. 비교할 수 있는 입력은 나중에 추가할 수 있습니다.':record.pendingReasons.length?'전적을 저장했습니다. 빈 항목을 제외하고 티어에 반영했습니다.':pastEditing?'전적 수정과 티어를 저장했습니다.':'지난 전적을 저장했습니다.');pastEditing=null;return true;}
    catch(error){if(editRequest&&error.data?.conflicts?.length&&error.data.latestRecord)return showRecordConflicts(error,editRequest);return entryError('past',error.message);}
    finally{setEntryBusy('past',false);button.textContent=pastEditing?'수정 저장 · 추정 갱신':'지난 전적 저장';}
  }

  function exportData(){state.lastBackup=new Date().toISOString();save();const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`내전자동매칭기_백업_${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),500);toast("백업 파일을 만들었습니다.");}
  async function importData(file){if(sharedStore?.enabled){await sharedStore.importFile(file);return;}try{const obj=JSON.parse(await file.text());state=migrateState(obj);save();currentPlans=[];renderAll();$("#resultSection").classList.add("hidden");toast("백업을 불러왔습니다.");}catch{toast("올바른 백업 파일이 아닙니다.");}}

  function bind(){
    $$(".nav-btn").forEach(b=>b.onclick=()=>{$$(".nav-btn").forEach(x=>{x.classList.toggle("active",x===b);if(x===b)x.setAttribute("aria-current","page");else x.removeAttribute("aria-current");});$$('.tab-panel').forEach(p=>p.classList.remove('active'));$(`#tab-${b.dataset.tab}`).classList.add('active');window.scrollTo({top:0,behavior:'smooth'});});
    $('#clearFixedRolesBtn').onclick=()=>{state.session.fixedRoles={};invalidatePlans();$('#matchConstraintError').hidden=true;persistMatchingSession();renderFixedRoles();};
    $("#clearSelectionBtn").onclick=()=>{state.session={selectedIds:[],fixedGroups:[],fixedRoles:{}};currentPlans=[];save();renderAll();$("#resultSection").classList.add("hidden");};
    $("#addFixedGroupBtn").onclick=openGroupDialog;$("#generateBtn").onclick=generate;$("#addMemberBtn").onclick=()=>openMemberDialog();
    $("#memberForm").addEventListener("submit",e=>{if(e.submitter?.value==="cancel"){e.submitter.form.noValidate=true;return;}e.submitter.form.noValidate=false;if(!saveMember()){e.preventDefault();return;}});
    $("#groupForm").addEventListener("submit",e=>{if(e.submitter?.value==="cancel"){e.submitter.form.noValidate=true;return;}e.submitter.form.noValidate=false;if(!saveGroup()){e.preventDefault();return;}});
    $$(".winner-choice").forEach(b=>b.onclick=()=>{resultDraft.winner=resultDraft.winner===b.dataset.winner?null:b.dataset.winner;$$('.winner-choice').forEach(x=>x.classList.toggle('active',x.dataset.winner===resultDraft.winner));persistGameDraft('live');});
    $('#resultForm').addEventListener('submit',e=>{e.preventDefault();if(!$('#saveResultBtn').disabled)saveLiveResult();});
    $('#resultForm button[value=cancel]').onclick=()=>{persistGameDraft('live');$('#resultDialog').close();};
    for(const prefix of ['live','past'])$(`#${prefix==='live'?'result':'past'}Dialog`).addEventListener('cancel',e=>{if(busyEntryControls.has(prefix))e.preventDefault();else persistGameDraft(prefix);});
    $("#addPastBtn").onclick=()=>openPastDialog();$('#pastRolesConfirmed').addEventListener('change',()=>{persistGameDraft('past');refreshStatAssessments('past',pastRoleMapFromSelectors(false).roleMap,window._pastMode,window._pastStats);});$('#pastForm').addEventListener('submit',e=>{e.preventDefault();if(!$('#savePastBtn').disabled)savePastMatch();});$$('#pastForm button[value=cancel]').forEach(button=>button.onclick=()=>{persistGameDraft('past');$('#pastDialog').close();});
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
      if(stats){clearEntryError(prefix);$(`#${prefix==='live'?'result':'past'}Duration`).setAttribute('aria-invalid','false');refreshStatAssessments(prefix,{},prefix==='live'?resultDraft.mode:window._pastMode,stats);persistGameDraft(prefix);}
    });
    $('#pastWinner').addEventListener('change',()=>persistGameDraft('past'));
    $('#pastDate').addEventListener('change',()=>persistGameDraft('past'));
    sharedStore=new SharedStore({ getState:()=>state, setState:value=>{
      const session=state.session;
      if($('#resultDialog').open&&value.activeDraft?.id===resultDraft.id){
        collectStatsFromDom('live',resultDraft.stats,false);
        const local={id:resultDraft.id,roles:resultDraft.roles,stats:resultDraft.stats,mode:resultDraft.mode,winner:resultDraft.winner,duration:durationFor('live')};
        try{const merged=liveServerBase?mergeDocuments(liveServerBase,local,value.activeDraft):local;liveServerBase=clone(value.activeDraft);resultDraft={...resultDraft,...merged};
          for(const r of ROLES)for(const side of ['A','B'])for(const key of ['level','k','d','a','cs','gold','damage']){const el=$(`#live-${r}-${side}-${key}`),v=merged.stats[r][side][key]??'';if(el&&el.value!==String(v))el.value=v;}
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
