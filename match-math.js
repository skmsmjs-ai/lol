import {ROLES,ROLE_KR,roleStrength,roleTier,roleUncertainty,roleEvidence,teamPrediction} from './role-model.js';
export const roleAllowed=(p,r)=>p.possible[r]&&!p.refusedRoles?.includes(r);
export function evaluateMatch(assignA,assignB,players,model,teamMaskA){
 const roles=Object.fromEntries(ROLES.map((r,i)=>[r,{aId:players[assignA[i]].id,bId:players[assignB[i]].id}]));
 const prediction=teamPrediction(players,roles),rawA=assignA.map((i,r)=>-roleStrength(players[i],ROLES[r])),rawB=assignB.map((i,r)=>-roleStrength(players[i],ROLES[r]));
 const gaps=rawA.map((t,i)=>Math.abs(t-rawB[i])),sumA=rawA.reduce((a,b)=>a+b,0),sumB=rawB.reduce((a,b)=>a+b,0),totalGap=Math.abs(sumA-sumB);
 const laneMean=gaps.reduce((s,g)=>s+g*g,0)/5,excess=gaps.reduce((s,g)=>s+Math.max(0,g-1)**2,0)/5;
 const uncertaintyCost=ROLES.reduce((s,r,i)=>{const a=roleUncertainty(players[assignA[i]],r),b=roleUncertainty(players[assignB[i]],r);return s+(a*a+b*b)/10+(a-b)**2/5;},0);
 const unratedAssignments=ROLES.reduce((n,r,i)=>n+Number(roleEvidence(players[assignA[i]],r).games===0)+Number(roleEvidence(players[assignB[i]],r).games===0),0);
 const preferredAssignments=ROLES.reduce((n,r,i)=>n+Number(players[assignA[i]].preferredRoles?.includes(r)||false)+Number(players[assignB[i]].preferredRoles?.includes(r)||false),0);
 const score=totalGap**2/5+laneMean+excess+.10*uncertaintyCost,botA=(rawA[3]+rawA[4])/2,botB=(rawB[3]+rawB[4])/2;
 return {assignA,assignB,teamMaskA,score,predictedAWin:prediction.predictedAWin,feature:prediction.feature,predictionScale:prediction.scale,tierSumA:sumA,tierSumB:sumB,totalGap,topGap:gaps[0],jgGap:gaps[1],midGap:gaps[2],adcGap:gaps[3],supGap:gaps[4],botIndexA:botA,botIndexB:botB,botGap:Math.abs(botA-botB),uncertaintyCost,preferredAssignments,unratedAssignments,maxLaneGap:Math.max(...gaps),laneMean,excess};
}

export function prepareFixedRoles(players,fixedRoles={}){
 const byId=new Map(players.map((p,i)=>[p.id,{p,i}])),seen=new Set(),locks={A:Array(5).fill(null),B:Array(5).fill(null)};
 for(const [r,value]of Object.entries(fixedRoles||{})){
  if(!ROLES.includes(r))throw new Error('고정할 역할을 확인해 주세요.');
  for(const side of ['A','B']){const id=value?.[side];if(!id)continue;const entry=byId.get(id);
   if(!entry)throw new Error('라인 고정 선수가 참가자에 없습니다. 참가자를 다시 선택하거나 고정을 해제해 주세요.');
   if(seen.has(id))throw new Error(`${entry.p.name} 선수를 두 자리에 고정할 수 없습니다.`);
   if(!roleAllowed(entry.p,r))throw new Error(`${entry.p.name} 선수는 ${ROLE_KR[r]}에 배정할 수 없습니다. 선수의 가능 역할이나 이번 편성의 거부라인을 확인하거나 고정을 해제해 주세요.`);
   seen.add(id);locks[side][ROLES.indexOf(r)]=entry.i;
  }
 }
 return {locks,hasLocks:seen.size>0,count:seen.size};
}

// Epsilon constraints protect the balance baseline before maximizing placement coverage.
export const PLACEMENT_POLICY=Object.freeze({scoreSlack:.15,scoreRelativeSlack:.10,totalGapSlack:.5,laneGapSlack:.25,laneFloor:1,probabilitySlack:.03});
export function placementLimits(b){return {score:b.score+Math.max(PLACEMENT_POLICY.scoreSlack,PLACEMENT_POLICY.scoreRelativeSlack*b.score),totalGap:b.totalGap+PLACEMENT_POLICY.totalGapSlack,maxLaneGap:Math.max(PLACEMENT_POLICY.laneFloor,b.maxLaneGap)+PLACEMENT_POLICY.laneGapSlack,winSkew:Math.abs(b.predictedAWin-.5)+PLACEMENT_POLICY.probabilitySlack};}
export function withinPlacementBalance(c,limits){const eps=1e-9;return c.score<=limits.score+eps&&c.totalGap<=limits.totalGap+eps&&c.maxLaneGap<=limits.maxLaneGap+eps&&Math.abs(c.predictedAWin-.5)<=limits.winSkew+eps;}
export function comparePlacement(a,b){return (b.preferredAssignments||0)-(a.preferredAssignments||0)||b.unratedAssignments-a.unratedAssignments||a.score-b.score;}

// Round preferences belong to the open matching screen, never to saved player profiles.
export function playersForRound(players,preferences={}){return players.map(p=>({...p,preferredRoles:preferences[p.id]?.preferredRoles||[],refusedRoles:preferences[p.id]?.refusedRoles||[]}));}
export function setRoundPreference(preferences,p,r,value){if(!ROLES.includes(r)||!['','P','D'].includes(value)||!p.possible[r])throw new Error('이번 내전의 가능한 역할을 선택해 주세요.');const current=preferences[p.id]||{preferredRoles:[],refusedRoles:[]},next={preferredRoles:current.preferredRoles.filter(x=>x!==r),refusedRoles:current.refusedRoles.filter(x=>x!==r)};if(value==='P')next.preferredRoles.push(r);if(value==='D')next.refusedRoles.push(r);if(!ROLES.some(x=>p.possible[x]&&!next.refusedRoles.includes(x)))throw new Error('이번 내전에 배정할 역할을 하나 이상 남겨 주세요.');return {...preferences,[p.id]:next};}
