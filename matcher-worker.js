/* Enumerate feasible assignments; fixed slots and same-team groups are hard constraints. */
import {evaluateMatch as evaluate,prepareFixedRoles,placementLimits,withinPlacementBalance,comparePlacement,roleAllowed} from './match-math.js';
const ROLES=["TOP","JG","MID","ADC","SUP"];
const popcount=n=>{let c=0;while(n){c+=n&1;n>>>=1;}return c;};
function membersFromMask(mask){const out=[];for(let i=0;i<10;i++)if(mask&(1<<i))out.push(i);return out;}
function validAssignments(members,players,locks){const out=[],used=new Array(members.length).fill(false),current=new Array(5);function dfs(role){if(role===5){out.push(current.slice());return;}for(let j=0;j<members.length;j++){if(used[j])continue;const local=members[j];if(!roleAllowed(players[local],ROLES[role])||(locks[role]!==null&&locks[role]!==local))continue;used[j]=true;current[role]=local;dfs(role+1);used[j]=false;}}dfs(0);return out;}
function satisfiesGroups(mask,groupMasks){for(const gm of groupMasks){const inA=gm&mask;if(inA!==0&&inA!==gm)return false;}return true;}
function changedPerTeam(a,b){return popcount(a.teamMaskA^b.teamMaskA)/2;}
function choosePlans(all){all.sort(comparePlacement);const plans=[];if(all.length)plans.push(all[0]);const enough=(c,min)=>plans.every(p=>changedPerTeam(c,p)>=min);for(const c of all){if(plans.length>=3)break;if(plans.some(p=>p.teamMaskA===c.teamMaskA))continue;if(enough(c,2))plans.push(c);}for(const c of all){if(plans.length>=3)break;if(plans.some(p=>p.teamMaskA===c.teamMaskA))continue;if(enough(c,1))plans.push(c);}return plans;}
self.onmessage=e=>{
  const{players,model,fixedGroups,fixedRoles}=e.data;if(!players||players.length!==10){self.postMessage({error:"참가자는 정확히 10명이어야 합니다."});return;}
  let constraints;try{constraints=prepareFixedRoles(players,fixedRoles);}catch(error){self.postMessage({error:error.message});return;}
  const indexById=new Map(players.map((p,i)=>[p.id,i]));const groupMasks=(fixedGroups||[]).map(g=>g.reduce((m,id)=>{const idx=indexById.get(id);return idx===undefined?m:(m|(1<<idx));},0)).filter(Boolean);
  const assignmentCache=new Map();let checked=0;
  function enumerate(visit){for(let mask=0;mask<(1<<10);mask++){
    if((!constraints.hasLocks&&!(mask&1))||popcount(mask)!==5||!satisfiesGroups(mask,groupMasks))continue;
    if(constraints.locks.A.some(i=>i!==null&&!(mask&(1<<i)))||constraints.locks.B.some(i=>i!==null&&(mask&(1<<i))))continue;
    const other=((1<<10)-1)^mask;const getAssignments=(m,side)=>{const key=m+side;if(!assignmentCache.has(key))assignmentCache.set(key,validAssignments(membersFromMask(m),players,constraints.locks[side]));return assignmentCache.get(key);};
    const aa=getAssignments(mask,'A'),bb=getAssignments(other,'B');if(!aa.length||!bb.length)continue;
    for(const a of aa)for(const b of bb)visit(evaluate(a,b,players,model,mask));
    checked++;if(checked%20===0)self.postMessage({progress:checked});
  }}
  let baseline=null;enumerate(c=>{if(!baseline||c.score<baseline.score)baseline=c;});
  if(!baseline){self.postMessage({error:'라인 고정·같은 팀 그룹·가능·거부 역할 조건을 동시에 만족하는 배치가 없습니다. 조건을 수정해 주세요. 조건은 자동으로 풀지 않았습니다.'});return;}
  const limits=placementLimits(baseline),bestByTeam=new Map();
  enumerate(c=>{if(!withinPlacementBalance(c,limits))return;const old=bestByTeam.get(c.teamMaskA);if(!old||comparePlacement(c,old)<0)bestByTeam.set(c.teamMaskA,c);});
  const candidates=[...bestByTeam.values()].map(c=>({...c,placement:{unratedAssignments:c.unratedAssignments,baselineScore:baseline.score,baselineUnrated:baseline.unratedAssignments,scoreIncrease:c.score-baseline.score,limits}}));
  if(!candidates.length){self.postMessage({error:'라인 고정·같은 팀 그룹·가능·거부 역할 조건을 동시에 만족하는 배치가 없습니다. 조건을 수정해 주세요. 조건은 자동으로 풀지 않았습니다.'});return;}
  self.postMessage({plans:choosePlans(candidates),candidateCount:candidates.length,fixedCount:constraints.count});
};
