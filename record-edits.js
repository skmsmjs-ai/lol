import {ROLES,applyRatingUpdate} from './role-model.js';
import {HttpError,acceptChanges} from './room-rules.js';
const clone=x=>JSON.parse(JSON.stringify(x));
const ordered=x=>Array.isArray(x)?x.map(ordered):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,ordered(x[k])])):x;
export const sameEditInput=(a,b)=>JSON.stringify(ordered(a))===JSON.stringify(ordered(b));
const same=sameEditInput;
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const derived=p=>({rating:p.rating,roleRating:clone(p.roleRating),stats:clone(p.stats),skillRating:clone(p.skillRating||null)});
// Three-way merge user-entered fields only. Calculation metadata and names
// may change during replay without changing the user's original input.
export function editableRecord(h){
  const statsByPlayer={},roles={},roleAdv={};
  for(const r of ROLES){roles[r]={aId:h.roles?.[r]?.aId,bId:h.roles?.[r]?.bId};roleAdv[r]=h.roleAdv?.[r]==='U'?'U':'S';for(const side of ['A','B']){const id=roles[r][side==='A'?'aId':'bId'];statsByPlayer[id]=Object.fromEntries(['level','k','d','a','cs','gold','damage'].map(k=>[k,h.stats?.[r]?.[side]?.[k]??null]));}}
  return {id:h.id,time:h.time??null,winner:h.winner??null,duration:h.duration||'',rolesConfirmed:h.rolesConfirmed!==false,roles,statsByPlayer,roleAdv};
}
export function rebaseRecordEdit(base,input,current,resolutions={}){
  if(!base||base.id!==current.id||input?.id!==current.id)throw new HttpError(422,'수정할 경기 정보를 확인해 주세요.');
  const b=editableRecord(base),l=editableRecord(input),r=editableRecord(current),conflicts=[];
  if(!same(Object.keys(b.statsByPlayer).sort(),Object.keys(l.statsByPlayer).sort())||!same(Object.keys(b.statsByPlayer).sort(),Object.keys(r.statsByPlayer).sort()))throw new HttpError(422,'각 팀의 기존 선수 5명을 한 번씩 배정해 주세요.');
  function merge(b,l,r,path){if(same(l,b))return clone(r);if(same(r,b)||same(l,r))return clone(l);if(b&&l&&r&&typeof b==='object'&&typeof l==='object'&&typeof r==='object'){return Object.fromEntries(Object.keys(b).map(k=>[k,merge(b[k],l[k],r[k],path?path+'.'+k:k)]));}if(resolutions[path]==='local')return clone(l);if(resolutions[path]==='remote')return clone(r);conflicts.push({field:path,base:b,local:l,remote:r});return clone(l);}
  const m=merge(b,l,r,'');
  if(conflicts.length)throw new HttpError(409,'같은 항목에 서로 다른 수정이 있습니다. 아래 값을 비교해 사용할 값을 선택해 주세요. 수정 초안은 남아 있습니다.',{latestRecord:clone(current),conflicts});
  const {statsByPlayer,...out}=m;out.stats=Object.fromEntries(ROLES.map(role=>[role,Object.fromEntries(['A','B'].map(side=>[side,statsByPlayer[m.roles[role][side==='A'?'aId':'bId']]]))]));return out;
}
const safeFailure=()=>new HttpError(422,'이 경기의 이전 계산을 확인하지 못해 수정을 중단했습니다. 원본은 유지했습니다. 관리자에게 확인해 주세요.');
function decrement(obj,key){if(!Number.isSafeInteger(obj[key])||obj[key]<1)throw safeFailure();obj[key]--;}
// Older records have no checkpoint. Reverse only their documented five-input
// updates, then verify by replaying the original updates before any edit.
function undo(next,h){
  if(h.ratingApplied===false)return;
  if(h.ratingBefore){
    for(const [id,value] of Object.entries(h.ratingBefore.players)){const p=next.roster.find(p=>p.id===id);if(!p)throw safeFailure();if(!Object.hasOwn(value,'skillRating'))delete p.skillRating;Object.assign(p,clone(value));}
    next.model=clone(h.ratingBefore.model);return;
  }
  if(!['role-five-inputs-2026-10-01-v1','role-available-inputs-2026-10-03-v2','role-cs-optional-2026-10-04-v3'].includes(h.modelVersion)||!Array.isArray(h.weightsBefore)||!Number.isFinite(h.predictedAWin))throw safeFailure();
  const players=new Map(next.roster.map(p=>[p.id,p])),known=['A','B'].includes(h.winner),y=h.winner==='A'?1:0;
  for(const r of ROLES){
    const m=h.roles[r],a=players.get(m.aId),b=players.get(m.bId);if(!a||!b)throw safeFailure();
    const actual=h.roleObserved?.[r],evidence=h.roleEvidenceWeight?.[r]||0;
    if(actual!==null&&actual!==undefined&&evidence>0){
      const sa=a.stats.role[r],sb=b.stats.role[r];decrement(sa,'games');decrement(sb,'games');
      if(h.roleAdv[r]==='A'){decrement(sa,'better');decrement(sb,'worse');}
      else if(h.roleAdv[r]==='B'){decrement(sa,'worse');decrement(sb,'better');}
      else{decrement(sa,'even');decrement(sb,'even');}
      const expected=1/(1+Math.exp(-clamp((m.bTier-m.aTier)/1.2,-30,30)));
      const delta=clamp(.12*evidence*(actual-expected)/Math.sqrt(1+(sa.games+sb.games)/2/18),-.04,.04);
      if(Math.abs(a.roleRating[r])>=1.35-1e-10||Math.abs(b.roleRating[r])>=1.35-1e-10)throw safeFailure();
      a.roleRating[r]-=delta;b.roleRating[r]+=delta;
    }
    for(const [p,side] of [[a,'A'],[b,'B']]){
      decrement(p.stats,'games');
      if(known){if(Math.abs(p.rating)>=1.5-1e-10)throw safeFailure();decrement(p.stats,h.winner===side?'wins':'losses');p.rating-=.075/Math.sqrt(1+p.stats.games/20)*(side==='A'?1:-1)*(y-h.predictedAWin);}
    }
  }
  decrement(next.model,'gamesLearned');next.model.weights=clone(h.weightsBefore);
}
function close(a,b){
  if(typeof a==='number'&&typeof b==='number')return Math.abs(a-b)<1e-8;
  if(a&&b&&typeof a==='object'&&typeof b==='object')return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>close(a[k],b[k]));
  return a===b;
}
export function editRecord(current,request,actor='member'){
  if(!['member','participant','admin'].includes(actor))throw new HttpError(403,'입장한 뒤 전적을 수정해 주세요.');
  if(typeof request.editId!=='string'||request.editId.length>150||!request.editId)throw new HttpError(422,'수정 요청을 확인해 주세요.');
  const index=current.history.findIndex(h=>h.id===request.recordId);let input=request.input;
  if(index<0)throw new HttpError(404,'수정할 경기를 찾지 못했습니다.');
  const original=current.history[index];
  if(!same(original,request.expectedRecord))input=rebaseRecordEdit(request.expectedRecord,input,original);
  if(!input||input.id!==original.id||(input.time!==null&&!Number.isFinite(Date.parse(input.time))))throw new HttpError(422,'경기 시각과 기록을 확인해 주세요.');
  // Ordinary role edits keep each original team. An explicit administrator
  // correction may fix teams, but must keep exactly the same ten player IDs.
  const correctTeams=request.correctTeams===true;
  if(correctTeams&&actor!=='admin')throw new HttpError(403,'팀 정정은 관리자만 할 수 있습니다.');
  if(correctTeams){
    const before=ROLES.flatMap(r=>[original.roles[r].aId,original.roles[r].bId]).sort();
    const after=ROLES.flatMap(r=>[input.roles?.[r]?.aId,input.roles?.[r]?.bId]).sort();
    if(!same(before,after)||new Set(after).size!==10)throw new HttpError(422,'기존 선수 10명을 한 번씩 배정해 주세요.');
  }else for(const side of ['aId','bId']){
    const before=ROLES.map(r=>original.roles[r][side]).sort(),after=ROLES.map(r=>input.roles?.[r]?.[side]).sort();
    if(!same(before,after)||new Set(after).size!==5)throw new HttpError(422,'각 팀의 기존 선수 5명을 한 번씩 배정해 주세요.');
  }
  const suffix=clone(current.history.slice(index)),next=clone(current);
  for(const h of [...suffix].reverse())undo(next,h);
  const verify=clone(next);verify.history=[];
  for(const h of suffix)applyRatingUpdate(verify,clone(h));
  if(!close(verify.model,current.model)||current.roster.some(p=>!close(derived(p),derived(verify.roster.find(q=>q.id===p.id)))))throw safeFailure();
  next.history=clone(current.history.slice(0,index));
  const affected=new Set(suffix.map(h=>h.id));for(const p of next.roster)p.timeline=p.timeline.filter(point=>!affected.has(point.gameId));
  const revisions=clone(current.recordEdits||[]);
  const before={history:suffix,model:clone(current.model),players:Object.fromEntries(current.roster.map(p=>[p.id,{...derived(p),timeline:clone(p.timeline)}]))};
  let rebuilt=next;
  for(let i=0;i<suffix.length;i++){
    const raw=i===0?{...suffix[i],...clone(input)}:suffix[i];
    if(raw.ratingApplied===false&&(i!==0||!input.roleAdv))delete raw.roleAdv;
    const proposed=clone(rebuilt);proposed.history.push(raw);
    // Preserve the active draft while calculating the corrected history.
    rebuilt=acceptChanges(rebuilt,proposed,actor);
    const computed=rebuilt.history.at(-1);rebuilt.history[rebuilt.history.length-1]={...raw,...computed};
  }
  revisions.push({id:request.editId,recordId:original.id,time:new Date().toISOString(),actor,...(correctTeams?{correctTeams:true}:{}),input:clone(request.input),appliedInput:clone(input),before});
  rebuilt.recordEdits=revisions;if(Object.hasOwn(current,'activeDraft'))rebuilt.activeDraft=clone(current.activeDraft);return rebuilt;
}
