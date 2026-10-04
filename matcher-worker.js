/*
  내전 자동 매칭기 v4 — 계산 엔진
  ------------------------------------------------------------
  1) 사람이 정한 기준 티어(baseTier)는 임의로 덮어쓰지 않는다.
  2) 실제 경기에서 쌓인 전체 자동 보정(rating)과 역할별 보정(roleRating)을
     적용한 '역할 추정 티어'로 그날의 배치를 계산한다.
  3) TOP/JG/MID의 큰 실력차는 비선형 벌점으로 강하게 억제한다.
  4) ADC/SUP는 개인 격차 + 바텀 듀오 상호보완을 동시에 본다.
  5) 실제 승패와 포지션 우세 기록이 쌓일수록 역할 영향도와 선수 추정치가
     천천히 변한다. 한두 판으로 티어가 급변하지 않게 변화폭을 제한한다.

  주의: 아래 계수는 Riot 공식 수치가 아니다. 공개된 '역할군 공평성' 방향을
  참고한 내전용 휴리스틱이며, 앱 안에서 모든 기준을 공개한다.
*/
import { roleTier } from './role-model.js?v=6-role60-merge-20261004';
const ROLES=["TOP","JG","MID","ADC","SUP"];
const PRIOR=[1.00,1.08,1.00,0.95];
const BASE=[11.0,12.0,11.0];
const CLIFF=[38.0,42.0,38.0];
const BOT_BASE=10.0,BOT_CLIFF=28.0,ADC_INDIV=2.2,SUP_INDIV=1.8,TEAM_TOTAL=5.0,PREDICTION=350.0;
const BOT_STRONG=.60,BOT_WEAK=.40;
const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
const sigmoid=x=>x>30?1:x<-30?0:1/(1+Math.exp(-x));
const popcount=n=>{let c=0;while(n){c+=n&1;n>>>=1;}return c;};
function botDuoIndex(adc,sup){const strong=Math.min(adc,sup),weak=Math.max(adc,sup);return BOT_STRONG*strong+BOT_WEAK*weak;}
function lanePenalty(gap,baseWeight,cliffWeight,learnedScale){const d=Math.abs(gap);let penalty=baseWeight*learnedScale*d*d;if(d>1)penalty+=cliffWeight*(d-1)*(d-1);return penalty;}
function learnedScale(model,idx){return clamp(model.weights[idx]/PRIOR[idx],.65,1.45);}
function predictAWin(feature,model){let z=0;for(let i=0;i<4;i++)z+=model.weights[i]*feature[i];return sigmoid(z);}
function evaluate(assignA,assignB,players,model,teamMaskA){
  const tierA=assignA.map((i,k)=>roleTier(players[i],ROLES[k])),tierB=assignB.map((i,k)=>roleTier(players[i],ROLES[k]));
  const sumA=tierA.reduce((a,b)=>a+b,0),sumB=tierB.reduce((a,b)=>a+b,0),totalGap=Math.abs(sumA-sumB),gaps=tierA.map((t,i)=>Math.abs(t-tierB[i]));
  const botA=botDuoIndex(tierA[3],tierA[4]),botB=botDuoIndex(tierB[3],tierB[4]),botGap=Math.abs(botA-botB);
  const feature=[(tierB[0]-tierA[0])/3,(tierB[1]-tierA[1])/3,(tierB[2]-tierA[2])/3,(botB-botA)/3],predictedAWin=predictAWin(feature,model);
  let score=TEAM_TOTAL*totalGap*totalGap;
  score+=lanePenalty(gaps[0],BASE[0],CLIFF[0],learnedScale(model,0));
  score+=lanePenalty(gaps[1],BASE[1],CLIFF[1],learnedScale(model,1));
  score+=lanePenalty(gaps[2],BASE[2],CLIFF[2],learnedScale(model,2));
  score+=lanePenalty(botGap,BOT_BASE,BOT_CLIFF,learnedScale(model,3));
  score+=ADC_INDIV*gaps[3]*gaps[3]+SUP_INDIV*gaps[4]*gaps[4];
  score+=PREDICTION*Math.pow(predictedAWin-.5,2);
  return{assignA,assignB,teamMaskA,score,predictedAWin,feature,tierSumA:sumA,tierSumB:sumB,totalGap,topGap:gaps[0],jgGap:gaps[1],midGap:gaps[2],adcGap:gaps[3],supGap:gaps[4],botIndexA:botA,botIndexB:botB,botGap};
}
function membersFromMask(mask){const out=[];for(let i=0;i<10;i++)if(mask&(1<<i))out.push(i);return out;}
function validAssignments(members,players){const out=[],used=new Array(members.length).fill(false),current=new Array(5);function dfs(role){if(role===5){out.push(current.slice());return;}for(let j=0;j<members.length;j++){if(used[j])continue;const local=members[j];if(!players[local].possible[ROLES[role]])continue;used[j]=true;current[role]=local;dfs(role+1);used[j]=false;}}dfs(0);return out;}
function satisfiesGroups(mask,groupMasks){for(const gm of groupMasks){const inA=gm&mask;if(inA!==0&&inA!==gm)return false;}return true;}
function changedPerTeam(a,b){return popcount(a.teamMaskA^b.teamMaskA)/2;}
function choosePlans(all){all.sort((a,b)=>a.score-b.score);const plans=[];if(all.length)plans.push(all[0]);const enough=(c,min)=>plans.every(p=>changedPerTeam(c,p)>=min);for(const c of all){if(plans.length>=3)break;if(plans.some(p=>p.teamMaskA===c.teamMaskA))continue;if(enough(c,2))plans.push(c);}for(const c of all){if(plans.length>=3)break;if(plans.some(p=>p.teamMaskA===c.teamMaskA))continue;if(enough(c,1))plans.push(c);}return plans;}
self.onmessage=e=>{
  const{players,model,fixedGroups}=e.data;if(!players||players.length!==10){self.postMessage({error:"참가자는 정확히 10명이어야 합니다."});return;}
  const indexById=new Map(players.map((p,i)=>[p.id,i]));const groupMasks=(fixedGroups||[]).map(g=>g.reduce((m,id)=>{const idx=indexById.get(id);return idx===undefined?m:(m|(1<<idx));},0)).filter(Boolean);
  const candidates=[],assignmentCache=new Map();let checked=0;
  for(let mask=0;mask<(1<<10);mask++){if(!(mask&1)||popcount(mask)!==5||!satisfiesGroups(mask,groupMasks))continue;const other=((1<<10)-1)^mask;const getAssignments=m=>{if(!assignmentCache.has(m))assignmentCache.set(m,validAssignments(membersFromMask(m),players));return assignmentCache.get(m);};const aa=getAssignments(mask),bb=getAssignments(other);if(!aa.length||!bb.length)continue;let best=null;for(const a of aa)for(const b of bb){const c=evaluate(a,b,players,model,mask);if(!best||c.score<best.score)best=c;}if(best)candidates.push(best);checked++;if(checked%20===0)self.postMessage({progress:checked});}
  self.postMessage({plans:choosePlans(candidates),candidateCount:candidates.length});
};
