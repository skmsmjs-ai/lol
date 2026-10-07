import {ROLES,roleStrength,roleTier,roleUncertainty,roleEvidence,teamPrediction} from './role-model.js';
export function evaluateMatch(assignA,assignB,players,model,teamMaskA){
 const roles=Object.fromEntries(ROLES.map((r,i)=>[r,{aId:players[assignA[i]].id,bId:players[assignB[i]].id}]));
 const prediction=teamPrediction(players,roles),rawA=assignA.map((i,r)=>-roleStrength(players[i],ROLES[r])),rawB=assignB.map((i,r)=>-roleStrength(players[i],ROLES[r]));
 const gaps=rawA.map((t,i)=>Math.abs(t-rawB[i])),sumA=rawA.reduce((a,b)=>a+b,0),sumB=rawB.reduce((a,b)=>a+b,0),totalGap=Math.abs(sumA-sumB);
 const laneMean=gaps.reduce((s,g)=>s+g*g,0)/5,excess=gaps.reduce((s,g)=>s+Math.max(0,g-1)**2,0)/5;
 const uncertaintyCost=ROLES.reduce((s,r,i)=>{const a=roleUncertainty(players[assignA[i]],r),b=roleUncertainty(players[assignB[i]],r);return s+(a*a+b*b)/10+(a-b)**2/5;},0);
 const unratedAssignments=ROLES.reduce((n,r,i)=>n+Number(roleEvidence(players[assignA[i]],r).games===0)+Number(roleEvidence(players[assignB[i]],r).games===0),0);
 const assignmentNovelty=4*unratedAssignments/10;
 const score=totalGap**2/5+laneMean+excess+.10*(uncertaintyCost+assignmentNovelty),botA=(rawA[3]+rawA[4])/2,botB=(rawB[3]+rawB[4])/2;
 return {assignA,assignB,teamMaskA,score,predictedAWin:prediction.predictedAWin,feature:prediction.feature,predictionScale:prediction.scale,tierSumA:sumA,tierSumB:sumB,totalGap,topGap:gaps[0],jgGap:gaps[1],midGap:gaps[2],adcGap:gaps[3],supGap:gaps[4],botIndexA:botA,botIndexB:botB,botGap:Math.abs(botA-botB),uncertaintyCost,assignmentNovelty,unratedAssignments,laneMean,excess};
}

export function prepareFixedRoles(players,fixedRoles={}){
 const byId=new Map(players.map((p,i)=>[p.id,{p,i}])),seen=new Set(),locks={A:Array(5).fill(null),B:Array(5).fill(null)};
 for(const [r,value]of Object.entries(fixedRoles||{})){
  if(!ROLES.includes(r))throw new Error('고정할 역할을 확인해 주세요.');
  for(const side of ['A','B']){const id=value?.[side];if(!id)continue;const entry=byId.get(id);
   if(!entry)throw new Error('라인 고정 선수가 참가자에 없습니다. 참가자를 다시 선택하거나 고정을 해제해 주세요.');
   if(seen.has(id))throw new Error(`${entry.p.name} 선수를 두 자리에 고정할 수 없습니다.`);
   if(!entry.p.possible[r])throw new Error(`${entry.p.name} 선수는 ${r} 배치 불가로 등록되어 있습니다. 가능 역할을 수정하거나 고정을 해제해 주세요.`);
   seen.add(id);locks[side][ROLES.indexOf(r)]=entry.i;
  }
 }
 return {locks,hasLocks:seen.size>0,count:seen.size};
}
