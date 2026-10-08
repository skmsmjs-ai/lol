import { ROLES, validateGameStats, deriveResult, applyRatingUpdate, roleTier, estimatedTier, recordPendingReasons, ensureSkill, teamPrediction, RATING_VERSION } from './role-model.js';
const copy=value=>JSON.parse(JSON.stringify(value));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export class HttpError extends Error {constructor(status,message,data={}){super(message);this.status=status;this.data=data;}}
export function normalizePlayer(p){
  if(!p||typeof p.id!=='string'||p.id.length>150||!p.id||typeof p.name!=='string'||!p.name.trim()||p.name.length>80||!Number.isFinite(p.baseTier)||p.baseTier<0||p.baseTier>10)throw new HttpError(422,'선수 이름과 기준 티어를 확인해 주세요.');
  if(!p.possible||!ROLES.some(r=>p.possible[r]===true)||ROLES.some(r=>typeof p.possible[r]!=='boolean'))throw new HttpError(422,'가능한 역할을 하나 이상 선택해 주세요.');
  return {...p,rating:Number.isFinite(p.rating)?p.rating:0,roleRating:Object.fromEntries(ROLES.map(r=>[r,Number.isFinite(p.roleRating?.[r])?p.roleRating[r]:0])),stats:p.stats||{games:0,wins:0,losses:0,role:Object.fromEntries(ROLES.map(r=>[r,{games:0,better:0,even:0,worse:0}]))},timeline:Array.isArray(p.timeline)?p.timeline:[]};
}
export function validateDocument(value){
  if(!value||!Array.isArray(value.roster)||!Array.isArray(value.history)||!value.model||!Array.isArray(value.model.weights)||value.model.weights.length!==4||value.model.weights.some(n=>!Number.isFinite(n))||!Number.isSafeInteger(value.model.gamesLearned)||value.model.gamesLearned<0)throw new HttpError(422,'이 자료를 불러올 수 없습니다. 앱에서 내보낸 백업인지 확인해 주세요.');
  const ids=value.roster.map(p=>p.id);if(new Set(ids).size!==ids.length)throw new HttpError(422,'선수 식별 정보가 중복되어 저장할 수 없습니다.');
  value.roster=value.roster.map(normalizePlayer);
  if(value.history.some(h=>!h||typeof h.id!=='string')||new Set(value.history.map(h=>h.id)).size!==value.history.length)throw new HttpError(422,'경기 식별 정보가 없거나 중복되어 저장할 수 없습니다.');
  // Arbitrary nested keys cannot alter Object.prototype in later merges.
  const walk=x=>{if(!x||typeof x!=='object')return;for(const k of Object.keys(x)){if(['__proto__','constructor','prototype'].includes(k))throw new HttpError(422,'허용되지 않는 저장 항목입니다.');walk(x[k]);}};walk(value);
  return value;
}
export function acceptChanges(current,incoming,role){
  validateDocument(incoming);
  const oldHistory=new Map(current.history.map(h=>[h.id,h])),newHistory=new Map(incoming.history.map(h=>[h.id,h]));
  for(const [id,h] of oldHistory)if(!same(newHistory.get(id),h))throw new HttpError(403,'기존 경기 기록은 유지해야 합니다. 기록을 바꾸려면 기록 수정에서 저장해 주세요.');
  const oldRoster=new Map(current.roster.map(p=>[p.id,p]));
  if(current.roster.some(p=>!incoming.roster.some(q=>p.id===q.id)))throw new HttpError(403,'기존 선수 자료는 백업 없이 삭제할 수 없습니다.');
  const next=copy(current);next.version=6;
  if(incoming.history.length>current.history.length&&current.history.length&&current.model.algorithm!==RATING_VERSION)throw new HttpError(422,'계산 모델 업데이트 중입니다. 입력은 보존했습니다. 잠시 뒤 다시 저장해 주세요.');next.lastBackup=incoming.lastBackup??next.lastBackup;
  next.roster=incoming.roster.map(p=>{
    const old=oldRoster.get(p.id);
    if(old)return {...copy(old),name:p.name,baseTier:p.baseTier,possible:copy(p.possible)};
    return normalizePlayer({id:p.id,name:p.name,baseTier:p.baseTier,possible:copy(p.possible)});
  });
  for(const raw of incoming.history.filter(h=>!oldHistory.has(h.id))){
    const error=validateGameStats(raw.stats,raw.duration,true);if(error)throw new HttpError(422,error==='게임시간'?'경기 시간을 31:42처럼 입력해 주세요.':error);
    const idSet=new Set(),roles={},players=new Map(next.roster.map(p=>[p.id,p]));
    const preSkill=new Map(next.roster.map(p=>[p.id,copy(p.skillRating||null)]));
    for(const id of new Set(ROLES.flatMap(r=>[raw.roles?.[r]?.aId,raw.roles?.[r]?.bId])))if(players.has(id))ensureSkill(players.get(id));
    const tier=roleTier;
    for(const r of ROLES){const m=raw.roles?.[r],a=players.get(m?.aId),b=players.get(m?.bId);if(!a||!b)throw new HttpError(422,'경기의 선수 정보를 확인해 주세요.');idSet.add(a.id);idSet.add(b.id);roles[r]={aId:a.id,bId:b.id,aName:a.name,bName:b.name,aTier:tier(a,r),bTier:tier(b,r)};}
    if(idSet.size!==10)throw new HttpError(422,'한 경기에는 서로 다른 선수 10명이 필요합니다.');
    const bot=(adc,sup)=>.6*Math.min(adc,sup)+.4*Math.max(adc,sup);
    const feature=['TOP','JG','MID'].map(r=>(roles[r].bTier-roles[r].aTier)/3);feature.push((bot(roles.ADC.bTier,roles.SUP.bTier)-bot(roles.ADC.aTier,roles.SUP.aTier))/3);
    let predictedAWin=teamPrediction(next.roster,roles,raw.rolesConfirmed!==false).predictedAWin;
    const modes=Object.fromEntries(ROLES.map(r=>[r,raw.roleAdv?.[r]==='U'?'U':'S']));
    const record={id:raw.id,time:raw.source==='past'&&raw.time===null?null:typeof raw.time==='string'&&Number.isFinite(Date.parse(raw.time))?raw.time:new Date().toISOString(),loggedAt:raw.loggedAt&&Number.isFinite(Date.parse(raw.loggedAt))?raw.loggedAt:new Date().toISOString(),source:raw.source==='past'?'past':'live',plan:Number.isSafeInteger(raw.plan)?raw.plan:null,winner:['A','B'].includes(raw.winner)?raw.winner:null,duration:raw.duration,roles,stats:copy(raw.stats),feature,predictedAWin,...deriveResult(raw.stats,raw.duration,modes)};
    if(raw.sourcePhoto&&Number.isSafeInteger(raw.sourcePhoto.photo)&&/^[0-9a-f]{64}$/.test(raw.sourcePhoto.sha256))record.sourcePhoto=copy(raw.sourcePhoto);
    record.rolesConfirmed=raw.rolesConfirmed!==false;
    record.pendingReasons=recordPendingReasons(record);
    record.roleAssessmentProvisional=record.rolesConfirmed===false;
    record.ratingBefore={model:copy(next.model),players:Object.fromEntries([...idSet].map(id=>{const p=players.get(id);return [id,{rating:p.rating,roleRating:copy(p.roleRating),stats:copy(p.stats),skillRating:copy(preSkill.get(id)||null)}];}))};
    applyRatingUpdate(next,record);
  }
  if(incoming.activeDraft){
    const d=incoming.activeDraft,ids=new Set(),players=new Map(next.roster.map(p=>[p.id,p]));
    if(typeof d.id!=='string'||d.id.length>150)throw new HttpError(422,'공유 경기 ID를 확인해 주세요.');
    if(current.activeDraft&&current.activeDraft.id!==d.id)throw new HttpError(409,'다른 경기를 입력 중입니다. 공유 경기 입력에서 저장하거나 닫아 주세요.',{state:current});
    const roles={},stats={};for(const r of ROLES){const m=d.roles?.[r];if(!players.has(m?.aId)||!players.has(m?.bId))throw new HttpError(422,'공유 경기 선수를 확인해 주세요.');ids.add(m.aId);ids.add(m.bId);roles[r]=copy(m);stats[r]={};for(const side of ['A','B']){stats[r][side]={};for(const key of ['level','k','d','a','cs','gold','damage']){const v=d.stats?.[r]?.[side]?.[key]??null;if(v!==null&&(!Number.isSafeInteger(v)||v<(key==='level'?1:0)||v>(key==='level'?20:['gold','damage'].includes(key)?1000000:10000)))throw new HttpError(422,'공유 경기 수치를 확인해 주세요.');stats[r][side][key]=v;}}}
    if(ids.size!==10)throw new HttpError(422,'공유 경기에는 서로 다른 선수 10명이 필요합니다.');
    if(current.activeDraft&&ROLES.some(r=>current.activeDraft.roles[r].aId!==roles[r].aId||current.activeDraft.roles[r].bId!==roles[r].bId))throw new HttpError(403,'입력 중인 경기의 선수 배정은 바꿀 수 없습니다. 기록을 저장한 뒤 수정해 주세요.');
    if(typeof d.duration!=='string'||d.duration.length>12)throw new HttpError(422,'경기 시간을 확인해 주세요.');
    next.activeDraft={id:d.id,roles,stats,duration:d.duration,winner:['A','B'].includes(d.winner)?d.winner:null,mode:Object.fromEntries(ROLES.map(r=>[r,d.mode?.[r]==='U'?'U':'S']))};
  }else if(current.activeDraft){
    if(!next.history.some(h=>h.id===current.activeDraft.id))throw new HttpError(403,'입력 중인 경기는 기록 저장 전에 지울 수 없습니다.');
    next.activeDraft=null;
  }
  return next;
}
