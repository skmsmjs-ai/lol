(() => {
  const ROLES = ["TOP","JG","MID","ADC","SUP"];
  const ROLE_KR = {TOP:"탑",JG:"정글",MID:"미드",ADC:"원딜",SUP:"서폿"};
  const PRIOR = [1.00,1.08,1.00,0.95];
  const STORAGE_KEY = "naejun_matchmaker_web_v1";
  const VERSION = 2;

  const allRoles = () => Object.fromEntries(ROLES.map(r=>[r,true]));
  const roles = (...allowed) => Object.fromEntries(ROLES.map(r=>[r,allowed.includes(r)]));
  const seedRoster = [
    {name:"송민석",tier:3,possible:allRoles()},
    {name:"김동혁",tier:4,possible:roles("TOP","MID","ADC")},
    {name:"김정한",tier:2,possible:roles("TOP")},
    {name:"나욱도",tier:5,possible:roles("TOP","SUP")},
    {name:"김준서",tier:4,possible:roles("MID","SUP")},
    {name:"김신우",tier:0,possible:allRoles()},
    {name:"신하민",tier:3,possible:roles("JG","SUP")},
    {name:"길민형",tier:5,possible:roles("TOP","SUP")},
    {name:"박지민",tier:6,possible:roles("TOP","JG","SUP")},
    {name:"최종인",tier:6,possible:roles("TOP","ADC","SUP")},
    {name:"손연호",tier:4,possible:roles("TOP","JG","SUP")},
    {name:"곽예찬",tier:3,possible:allRoles()},
    {name:"박태우",tier:1,possible:allRoles()},
    {name:"양현우",tier:2,possible:allRoles()}
  ].map((p,i)=>({...p,id:`seed-${i+1}`}));

  const defaultState = () => ({
    version:VERSION,
    roster:structuredCloneSafe(seedRoster),
    model:{weights:[...PRIOR],gamesLearned:0},
    history:[],
    session:{selectedIds:[],fixedGroups:[]},
    lastBackup:null
  });

  function structuredCloneSafe(v){ return JSON.parse(JSON.stringify(v)); }
  function loadState(){
    try {
      const raw=localStorage.getItem(STORAGE_KEY); if(!raw) return defaultState();
      const s=JSON.parse(raw);
      if(!s.roster || !s.model) throw new Error("invalid");
      s.session ||= {selectedIds:[],fixedGroups:[]}; s.history ||= [];
      s.model.weights ||= [...PRIOR]; s.model.gamesLearned ||= 0;
      return s;
    } catch { return defaultState(); }
  }
  let state=loadState();
  let currentPlans=[];
  let activePlanIndex=null;
  let worker=null;
  let groupDraft=new Set();
  const $=q=>document.querySelector(q);
  const $$=q=>[...document.querySelectorAll(q)];
  const escapeHtml=s=>String(s).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
  const playerById=id=>state.roster.find(p=>p.id===id);
  const selectedPlayers=()=>state.session.selectedIds.map(playerById).filter(Boolean);
  const popcount=n=>{let c=0;while(n){c+=n&1;n>>>=1;}return c;};

  function save(){ localStorage.setItem(STORAGE_KEY,JSON.stringify(state)); }
  function toast(msg){ const t=$("#toast"); t.textContent=msg; t.classList.add("show"); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove("show"),1800); }

  function possibleText(p){ const a=ROLES.filter(r=>p.possible[r]); return a.length===5?"올라운더":a.map(r=>ROLE_KR[r]).join(" · "); }
  function impossibleText(p){ const a=ROLES.filter(r=>!p.possible[r]); return a.length? a.map(r=>ROLE_KR[r]).join(" · "):"없음"; }

  function renderParticipantGrid(){
    const sel=new Set(state.session.selectedIds);
    const sorted=[...state.roster].sort((a,b)=>a.tier-b.tier || a.name.localeCompare(b.name,"ko"));
    $("#participantGrid").innerHTML=sorted.map(p=>`<button class="participant-card ${sel.has(p.id)?"selected":""}" data-id="${p.id}"><span class="check">✓</span><strong>${escapeHtml(p.name)}</strong><small>티어 ${p.tier} · ${escapeHtml(possibleText(p))}</small></button>`).join("");
    $$("#participantGrid .participant-card").forEach(btn=>btn.onclick=()=>toggleParticipant(btn.dataset.id));
    $("#selectedCounter").textContent=`${sel.size} / 10`;
    $("#generateBtn").disabled=sel.size!==10;
    $("#addFixedGroupBtn").disabled=sel.size!==10;
  }

  function toggleParticipant(id){
    const a=state.session.selectedIds; const idx=a.indexOf(id);
    if(idx>=0){ a.splice(idx,1); state.session.fixedGroups=state.session.fixedGroups.filter(g=>!g.includes(id)); }
    else { if(a.length>=10){toast("참가자는 10명까지만 선택할 수 있습니다.");return;} a.push(id); }
    currentPlans=[]; save(); renderAll();
  }

  function renderFixedGroups(){
    const box=$("#fixedGroups");
    if(!state.session.fixedGroups.length){box.innerHTML='<div class="empty-note">고정 그룹 없음. 필요할 때만 추가하세요.</div>';return;}
    box.innerHTML=state.session.fixedGroups.map((g,i)=>`<div class="group-chip"><div><small class="eyebrow">GROUP ${i+1}</small><div class="names">${g.map(id=>escapeHtml(playerById(id)?.name||"?")).join(" · ")}</div></div><button class="remove-group" data-i="${i}">삭제</button></div>`).join("");
    $$(".remove-group").forEach(b=>b.onclick=()=>{state.session.fixedGroups.splice(Number(b.dataset.i),1);save();renderFixedGroups();});
  }

  function renderTierList(targetId, markSelected=true){
    const groups=new Map();
    [...state.roster].sort((a,b)=>a.tier-b.tier||a.name.localeCompare(b.name,"ko")).forEach(p=>{
      const key=String(p.tier); if(!groups.has(key)) groups.set(key,[]); groups.get(key).push(p);
    });
    const selected=new Set(state.session.selectedIds);
    $(targetId).innerHTML=[...groups.entries()].map(([tier,ps])=>`<div class="tier-row"><div class="tier-number">${tier}</div><div class="tier-names">${ps.map(p=>`<span class="tier-person ${markSelected&&selected.has(p.id)?"selected":""}">${escapeHtml(p.name)}</span>`).join('<span class="muted">/</span>')}</div></div>`).join("");
  }

  function renderRoster(){
    renderTierList("#tierListRoster",false);
    const sorted=[...state.roster].sort((a,b)=>a.tier-b.tier||a.name.localeCompare(b.name,"ko"));
    $("#rosterList").innerHTML=sorted.map(p=>`<div class="roster-card"><div class="roster-main"><div class="roster-name">${escapeHtml(p.name)} <span class="badge">${p.tier}</span></div><div class="roster-meta">가능: ${escapeHtml(possibleText(p))} · 불가능: ${escapeHtml(impossibleText(p))}</div></div><button class="edit-btn" data-id="${p.id}">수정</button></div>`).join("");
    $$("#rosterList .edit-btn").forEach(b=>b.onclick=()=>openMemberDialog(b.dataset.id));
  }

  function renderHistory(){
    $("#gamesBadge").textContent=`${state.model.gamesLearned}경기`;
    const labels=["TOP","JG","MID","BOT"];
    $("#weightBars").innerHTML=labels.map((l,i)=>{
      const w=state.model.weights[i]; const pct=Math.max(10,Math.min(100,w/1.8*100));
      return `<div class="weight-item"><div class="weight-label">${l}</div><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><div class="weight-value">${w.toFixed(3)}</div></div>`;
    }).join("");
    const items=[...state.history].reverse().slice(0,30);
    $("#historyList").innerHTML=items.length?items.map(h=>`<div class="history-item"><div class="history-top"><div class="history-title">${h.plan}안 · ${h.winner}팀 승리</div><div class="history-date">${new Date(h.time).toLocaleString("ko-KR",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})}</div></div><div class="history-sub">당시 예상 A ${(h.predictedAWin*100).toFixed(1)}% : B ${((1-h.predictedAWin)*100).toFixed(1)}%</div></div>`).join(""):'<div class="empty-note">아직 학습한 경기가 없습니다.</div>';
  }

  function renderCriteria(){
    const labels=["TOP","JG","MID","BOT"];
    const target=$("#criteriaWeightBars");
    if(target){
      target.innerHTML=labels.map((l,i)=>{
        const w=state.model.weights[i];
        const pct=Math.max(10,Math.min(100,w/1.8*100));
        return `<div class="weight-item"><div class="weight-label">${l}</div><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><div class="weight-value">${w.toFixed(3)}</div></div>`;
      }).join("");
    }
    const games=state.model.gamesLearned||0;
    if($("#criteriaGames")) $("#criteriaGames").textContent=`${games}경기 학습`;
    if($("#modelStatus")){
      const status=games<10?"초기값 중심":games<30?"실전 보정 중":"누적 데이터 반영";
      $("#modelStatus").textContent=status;
    }
  }

  function renderAll(){ renderParticipantGrid(); renderFixedGroups(); renderRoster(); renderHistory(); renderCriteria(); }

  function roleGapLabel(g){ if(g<.01)return"동급"; if(g<=1)return"양호"; if(g<=2)return"주의"; return"큰 격차"; }
  function verdict(c){
    const maxCore=Math.max(c.topGap,c.jgGap,c.midGap), pd=Math.abs(c.predictedAWin-.5);
    if(c.totalGap<=1 && maxCore<=1 && c.botGap<=.75 && pd<=.04) return ["매우 균형","great"];
    if(c.totalGap<=2 && maxCore<=1.5 && c.botGap<=1 && pd<=.06) return ["균형","good"];
    if(maxCore<=2 && c.botGap<=1.5 && pd<=.08) return ["조건 내 양호","ok"];
    return ["편차 있음","bad"];
  }
  function teamStrengthText(c, players){
    const a=[],b=[];
    [["TOP",c.topGap,0],["JG",c.jgGap,1],["MID",c.midGap,2]].forEach(([role,,i])=>{
      const ta=players[c.assignA[i]].tier, tb=players[c.assignB[i]].tier;
      if(ta<tb) a.push(role); else if(tb<ta)b.push(role);
    });
    if(c.botIndexA<c.botIndexB-.01)a.push("BOT"); else if(c.botIndexB<c.botIndexA-.01)b.push("BOT");
    if(a.length&&b.length)return `A팀은 ${a.join("·")}, B팀은 ${b.join("·")} 쪽이 상대적으로 강해 강점이 한쪽에만 몰리지 않습니다.`;
    if(a.length)return `주요 역할 우세가 A팀(${a.join("·")})에 다소 몰려 있습니다.`;
    if(b.length)return `주요 역할 우세가 B팀(${b.join("·")})에 다소 몰려 있습니다.`;
    return "주요 역할의 계산상 우열이 거의 없습니다.";
  }
  function explain(c,players){
    const maxCore=Math.max(c.topGap,c.jgGap,c.midGap); const coreRole=["TOP","JG","MID"][[c.topGap,c.jgGap,c.midGap].indexOf(maxCore)];
    const p=[];
    p.push(c.totalGap<=1?`전체 티어 합 차이는 ${c.totalGap.toFixed(1)}로 매우 작습니다.`:`전체 티어 합은 ${c.tierSumA.toFixed(1)} 대 ${c.tierSumB.toFixed(1)}로 ${c.totalGap.toFixed(1)} 차이가 남습니다.`);
    if(maxCore<=1)p.push("TOP·JG·MID가 모두 1티어 이내라 한 역할이 초반부터 터질 위험을 강하게 억제했습니다.");
    else p.push(`${coreRole}의 ${maxCore.toFixed(1)}티어 차이가 가장 큰 변수입니다.`);
    p.push(c.botGap<=1?`바텀 듀오 지수 차이는 ${c.botGap.toFixed(2)}로, ADC와 SUP의 상호보완까지 고려해 비교적 가깝습니다.`:`바텀 듀오 지수 차이는 ${c.botGap.toFixed(2)}로 바텀 편차가 남습니다.`);
    p.push(teamStrengthText(c,players));
    return p;
  }

  function renderPlans(){
    const players=selectedPlayers();
    renderTierList("#tierListResult",true);
    $("#planCountBadge").textContent=`${currentPlans.length}개`;
    const first=currentPlans[0];
    const html=currentPlans.map((c,idx)=>{
      const [v,cls]=verdict(c);
      const ex=explain(c,players);
      const changeText=idx===0?"최저 밸런스 점수":`${first?popcount((first.teamMaskA^c.teamMaskA)>>>0)/2:0}명 교체 구성`;
      const teamA=c.assignA.map(i=>players[i].name).join(" · ");
      const teamB=c.assignB.map(i=>players[i].name).join(" · ");
      const rows=ROLES.map((r,i)=>{
        const a=players[c.assignA[i]], b=players[c.assignB[i]], gap=Math.abs(a.tier-b.tier);
        return `<div class="match-row"><div class="role-tag">${r}</div><div class="player-side a"><div class="player-name">${escapeHtml(a.name)}</div><div class="player-tier">티어 ${a.tier}</div></div><div class="vs">VS</div><div class="player-side b"><div class="player-name">${escapeHtml(b.name)} <span class="gap-dot">${roleGapLabel(gap)}</span></div><div class="player-tier">티어 ${b.tier}</div></div></div>`;
      }).join("");
      const marker=Math.max(3,Math.min(97,c.predictedAWin*100));
      const confidence=state.model.gamesLearned<10?"초기치 중심":state.model.gamesLearned<30?"실전 보정 중":"누적 데이터 반영";
      return `<article class="plan-card ${idx===0?"featured":""}">
        <div class="plan-top"><div><div class="plan-rank">황금 밸런스 ${idx+1}안</div><div class="plan-subline">${changeText}</div></div><span class="verdict ${cls}">${v}</span></div>
        <div class="team-strip"><div class="team-block"><div class="team-label a">TEAM A</div><div class="team-names">${escapeHtml(teamA)}</div></div><div class="team-block"><div class="team-label b">TEAM B</div><div class="team-names">${escapeHtml(teamB)}</div></div></div>
        <div class="match-table">${rows}</div>
        <div class="balance-bar"><div class="balance-bar-top"><span>A ${(c.predictedAWin*100).toFixed(1)}</span><span>모형상 균형 추정 · ${confidence}</span><span>${((1-c.predictedAWin)*100).toFixed(1)} B</span></div><div class="balance-track"><span class="balance-marker" style="left:${marker}%"></span></div></div>
        <div class="metrics"><div class="metric"><small>티어 합</small><strong>A ${c.tierSumA.toFixed(1)} : B ${c.tierSumB.toFixed(1)}</strong></div><div class="metric"><small>TOP / JG / MID</small><strong>${c.topGap.toFixed(1)} / ${c.jgGap.toFixed(1)} / ${c.midGap.toFixed(1)}</strong></div><div class="metric"><small>BOT 듀오</small><strong>${c.botIndexA.toFixed(2)} : ${c.botIndexB.toFixed(2)}</strong></div><div class="metric"><small>ADC / SUP 차이</small><strong>${c.adcGap.toFixed(1)} / ${c.supGap.toFixed(1)}</strong></div></div>
        <div class="explanation">${ex.map((x,i)=>`<p>${i+1}. ${escapeHtml(x)}</p>`).join("")}</div>
        <button class="play-btn" data-plan="${idx}">이 안으로 경기</button>
      </article>`;
    }).join("");
    $("#plansContainer").innerHTML=html || '<div class="empty-note">조건을 만족하는 팀을 만들 수 없습니다.</div>';
    $$(".play-btn").forEach(b=>b.onclick=()=>openResultDialog(Number(b.dataset.plan)));
    $("#resultSection").classList.remove("hidden");
    setTimeout(()=>$("#resultSection").scrollIntoView({behavior:"smooth",block:"start"}),80);
  }

  function showLoading(show,text="가능한 조합을 계산하고 있습니다…"){
    let el=$("#loadingOverlay");
    if(show){ if(!el){el=document.createElement("div");el.id="loadingOverlay";el.className="loading-overlay";el.innerHTML=`<div class="loading-box"><div class="spinner"></div><strong>${escapeHtml(text)}</strong><p class="muted" style="font-size:12px;margin-top:6px">포지션 제한과 고정팀 조건까지 전수 비교합니다.</p></div>`;document.body.appendChild(el);} }
    else el?.remove();
  }

  function generate(){
    if(state.session.selectedIds.length!==10)return;
    showLoading(true);
    if(worker)worker.terminate();
    worker=new Worker("matcher-worker.js");
    worker.onmessage=e=>{
      if(e.data.progress)return;
      showLoading(false);
      if(e.data.error){toast(e.data.error);return;}
      currentPlans=e.data.plans||[];
      renderPlans();
      if(!currentPlans.length)toast("현재 조건으로 가능한 정상 배치가 없습니다.");
    };
    worker.onerror=()=>{showLoading(false);toast("계산 중 오류가 발생했습니다.");};
    worker.postMessage({players:selectedPlayers(),model:state.model,fixedGroups:state.session.fixedGroups});
  }

  function openMemberDialog(id=null){
    const p=id?playerById(id):null;
    $("#memberId").value=p?.id||""; $("#memberName").value=p?.name||""; $("#memberTier").value=p?.tier??3;
    $("#memberDialogTitle").textContent=p?"멤버 수정":"새 멤버 추가"; $("#memberDialogEyebrow").textContent=p?"EDIT PLAYER":"NEW PLAYER";
    $("#memberImpossibleRoles").innerHTML=ROLES.map(r=>`<label class="role-check"><input type="checkbox" data-role="${r}" ${p && !p.possible[r]?"checked":""}><span>${r}</span></label>`).join("");
    $("#memberDialog").showModal();
  }
  function saveMember(){
    const id=$("#memberId").value, name=$("#memberName").value.trim(), tier=Number($("#memberTier").value);
    if(!name || !Number.isFinite(tier)){toast("이름과 티어를 확인해주세요.");return false;}
    const impossible=new Set($$("#memberImpossibleRoles input:checked").map(x=>x.dataset.role));
    const possible=Object.fromEntries(ROLES.map(r=>[r,!impossible.has(r)]));
    if(!ROLES.some(r=>possible[r])){toast("최소 한 포지션은 가능해야 합니다.");return false;}
    if(id){ const p=playerById(id); p.name=name;p.tier=tier;p.possible=possible; }
    else state.roster.push({id:`p-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,name,tier,possible});
    save();renderAll();toast(id?"멤버 정보를 저장했습니다.":"새 멤버를 저장했습니다.");return true;
  }

  function openGroupDialog(){
    const used=new Set(state.session.fixedGroups.flat()); groupDraft=new Set();
    $("#groupMemberChoices").innerHTML=state.session.selectedIds.map(id=>{const p=playerById(id),disabled=used.has(id);return `<button type="button" class="participant-card ${disabled?"disabled":""}" data-id="${id}" ${disabled?"disabled":""}><strong>${escapeHtml(p.name)}</strong><small>티어 ${p.tier}${disabled?" · 다른 그룹에 포함":""}</small></button>`}).join("");
    $$("#groupMemberChoices .participant-card:not(:disabled)").forEach(b=>b.onclick=()=>{const id=b.dataset.id;if(groupDraft.has(id)){groupDraft.delete(id);b.classList.remove("selected");}else{if(groupDraft.size>=5){toast("한 그룹은 최대 5명입니다.");return;}groupDraft.add(id);b.classList.add("selected");}});
    $("#groupDialog").showModal();
  }
  function saveGroup(){
    if(groupDraft.size<2){toast("같은 팀 고정은 2명 이상 선택해주세요.");return false;}
    state.session.fixedGroups.push([...groupDraft]);save();renderFixedGroups();toast(`${groupDraft.size}명을 같은 팀으로 고정했습니다.`);return true;
  }

  function openResultDialog(idx){ activePlanIndex=idx; $("#resultDialogTitle").textContent=`${idx+1}안 경기 결과`; $("#resultDialogText").textContent="실제로 사용한 안이 맞다면 승리팀만 누르세요."; $("#resultDialog").showModal(); }
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  function recordWinner(winner){
    const c=currentPlans[activePlanIndex]; if(!c)return;
    const before=[...state.model.weights], y=winner==="A"?1:0, p=c.predictedAWin;
    const lr=.055/Math.sqrt(1+state.model.gamesLearned/20), reg=.025;
    for(let i=0;i<4;i++){
      const gradient=(y-p)*c.feature[i]; const pull=reg*(PRIOR[i]-state.model.weights[i]);
      state.model.weights[i]=clamp(state.model.weights[i]+lr*(gradient+pull),.40,1.80);
    }
    state.model.gamesLearned++;
    state.history.push({time:new Date().toISOString(),plan:activePlanIndex+1,winner,predictedAWin:p,feature:[...c.feature],weightsBefore:before,weightsAfter:[...state.model.weights],players:selectedPlayers().map(x=>({id:x.id,name:x.name,tier:x.tier})),assignA:[...c.assignA],assignB:[...c.assignB]});
    save(); $("#resultDialog").close(); renderHistory(); toast(`${activePlanIndex+1}안 · ${winner}팀 승리로 학습했습니다.`);
  }

  function exportData(){
    state.lastBackup=new Date().toISOString();save();
    const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"}); const url=URL.createObjectURL(blob); const a=document.createElement("a");a.href=url;a.download=`내전자동매칭기_백업_${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),500);toast("백업 파일을 만들었습니다.");
  }
  async function importData(file){
    try{const obj=JSON.parse(await file.text());if(!Array.isArray(obj.roster)||!obj.model)throw new Error();state=obj;state.session||={selectedIds:[],fixedGroups:[]};save();currentPlans=[];renderAll();$("#resultSection").classList.add("hidden");toast("백업을 불러왔습니다.");}catch{toast("올바른 백업 파일이 아닙니다.");}
  }

  function bind(){
    $$(".nav-btn").forEach(b=>b.onclick=()=>{$$(".nav-btn").forEach(x=>x.classList.toggle("active",x===b));$$('.tab-panel').forEach(p=>p.classList.remove('active'));$(`#tab-${b.dataset.tab}`).classList.add('active');window.scrollTo({top:0,behavior:'smooth'});});
    $("#clearSelectionBtn").onclick=()=>{state.session={selectedIds:[],fixedGroups:[]};currentPlans=[];save();renderAll();$("#resultSection").classList.add("hidden");};
    $("#addFixedGroupBtn").onclick=openGroupDialog; $("#generateBtn").onclick=generate; $("#addMemberBtn").onclick=()=>openMemberDialog();
    $("#memberForm").addEventListener("submit",e=>{if(e.submitter?.value==="cancel")return;if(!saveMember()){e.preventDefault();return;} });
    $("#groupForm").addEventListener("submit",e=>{if(e.submitter?.value==="cancel")return;if(!saveGroup()){e.preventDefault();return;} });
    $("#winAButton").onclick=()=>recordWinner("A"); $("#winBButton").onclick=()=>recordWinner("B");
    $("#exportBtn").onclick=exportData; $("#importInput").onchange=e=>{const f=e.target.files?.[0];if(f)importData(f);e.target.value="";};
    $("#resetBtn").onclick=()=>{if(confirm("멤버·티어·경기 학습 기록을 모두 초기화할까요?")){state=defaultState();save();currentPlans=[];renderAll();$("#resultSection").classList.add("hidden");toast("초기화했습니다.");}};
    $("#installHelpBtn").onclick=()=>$("#installDialog").showModal();
  }

  async function init(){
    bind(); renderAll();
    if("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(()=>{});
    if(navigator.storage?.persist) { try{await navigator.storage.persist();}catch{} }
  }
  document.addEventListener("DOMContentLoaded",init);
})();
