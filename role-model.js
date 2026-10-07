// Team-outcome core: Weng & Lin (JMLR 2011), two-team Bradley–Terry update.
// Role-stat comparison and its bounded auxiliary shift are disclosed app heuristics.
import * as legacy from './legacy-role-model.js';
export const ROLES=legacy.ROLES,ROLE_KR=legacy.ROLE_KR,PRIOR=[1,1,1,1];
export const MODEL_VERSION='role-evidence-2026-10-07-v4';
export const RATING_VERSION='weng-lin-roles-2026-10-07-v7';
export const TIER_SENSITIVITY=1,ROLE_TIER_SENSITIVITY=1;
export const RATING_POLICY={roleVariance:4,generalVariance:1,teamNoiseVariance:3.2,performanceCap:.75,performancePrior:1,gamma:.5};
export const ROLE_RULES={
 TOP:{growth:.65,participation:.10,efficiency:.10,damage:.15,economy:{gold:.50,cs:.25,level:.25},evidence:.55,required:['gold','level'],definition:'골드·레벨로 성장 유지, 피해량·교전 관여로 확인 가능한 압박을 비교합니다.'},
 JG:{growth:.30,participation:.45,efficiency:.15,damage:.10,economy:{gold:.55,cs:.20,level:.25},evidence:.40,required:['gold','level'],definition:'팀 교전 관여와 골드·레벨 성장을 비교합니다. 오브젝트·갱킹의 질은 이 수치만으로 확정하지 않습니다.'},
 MID:{growth:.35,participation:.25,efficiency:.10,damage:.30,economy:{gold:.65,cs:.25,level:.10},evidence:.55,required:['gold'],definition:'챔피언 피해량·교전 관여와 골드 성장을 비교합니다. 로밍의 질은 별도로 알 수 없습니다.'},
 ADC:{growth:.40,participation:.10,efficiency:.10,damage:.40,economy:{gold:.65,cs:.30,level:.05},evidence:.55,required:['gold'],definition:'챔피언 피해량과 골드·CS 성장을 중심으로 봅니다. 챔피언·게임 흐름 차이까지 설명하는 지표는 아닙니다.'},
 SUP:{growth:0,participation:.70,efficiency:.30,damage:0,economy:{gold:0,cs:0,level:0},evidence:.35,required:[],definition:'어시스트 관여와 데스 대비 어시스트 효율을 비교합니다. 골드·CS·피해량·킬 수 자체로 서포터를 평가하지 않습니다.'}
};
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x)),sigmoid=x=>1/(1+Math.exp(-clamp(x,-30,30))),base=p=>Number(p.baseTier??p.tier??3);
const clone=x=>JSON.parse(JSON.stringify(x));
export const parseDuration=legacy.parseDuration,validStat=legacy.validStat,validateGameStats=legacy.validateGameStats,recordPendingReasons=legacy.recordPendingReasons;
const fresh=(variance)=>({delta:0,variance,games:0,performanceSum:0,performanceWeight:0});
export function ensureSkill(p){if(p.skillRating?.version!==RATING_VERSION)p.skillRating={version:RATING_VERSION,general:fresh(RATING_POLICY.generalVariance),roles:Object.fromEntries(ROLES.map(r=>[r,fresh(RATING_POLICY.roleVariance)]))};return p.skillRating;}
const newSkill=p=>p.skillRating?.version===RATING_VERSION;
export function performanceShift(p,r){const s=p.skillRating?.roles?.[r];return newSkill(p)&&s?RATING_POLICY.performanceCap*s.performanceSum/(RATING_POLICY.performancePrior+s.performanceWeight):0;}
export function roleStrength(p,r){if(!newSkill(p))return -legacy.roleTier(p,r);return -base(p)+p.skillRating.general.delta+(p.skillRating.roles[r]?.delta||0)+performanceShift(p,r);}
export function roleTier(p,r){return r&&ROLES.includes(r)?clamp(-roleStrength(p,r),-.5,10):estimatedTier(p);}
export function estimatedTier(p){if(!newSkill(p))return legacy.estimatedTier(p);const s=p.skillRating,n=ROLES.reduce((n,r)=>n+s.roles[r].games,0),delta=n?ROLES.reduce((v,r)=>v+s.roles[r].delta*s.roles[r].games,0)/n:0;return clamp(base(p)-s.general.delta-delta,-.5,10);}
export const tierCorrection=p=>estimatedTier(p)-base(p);
export function roleUncertainty(p,r){if(!newSkill(p))return Math.sqrt(RATING_POLICY.roleVariance);return Math.sqrt(p.skillRating.roles[r].variance+(p.skillRating.general.games?p.skillRating.general.variance:0));}
export function roleEvidence(p,r){const s=p.skillRating?.roles?.[r];return newSkill(p)?{games:s.games,observations:s.performanceWeight,uncertainty:roleUncertainty(p,r)}:{games:p.stats?.role?.[r]?.games||0,observations:0,uncertainty:Math.sqrt(RATING_POLICY.roleVariance)};}
export function tierTrendPoints(p){const points=(p.timeline||[]).filter(x=>Number.isFinite(Number(x.tier))).map(x=>({...x})).sort((a,b)=>new Date(a.time)-new Date(b.time)),last=points.at(-1),current=Number(estimatedTier(p).toFixed(4));if(last&&Math.abs(last.tier-current)>.0001)points.push({time:last.time,tier:current,source:'current-model',derived:true});return points.slice(-40);}
const contrast=(a,b,prior)=>Math.tanh(Math.log((a+prior)/(b+prior))/Math.log(2));
export function assessRole(role,stats,duration){
 const rule=ROLE_RULES[role],a=stats?.[role]?.A,b=stats?.[role]?.B;if(!rule||!a||!b)return null;
 const seconds=parseDuration(duration),minutes=seconds?seconds/60:null,scale=minutes||30;
 const known=(s,k)=>Number.isSafeInteger(s?.[k])&&s[k]>=(k==='level'?1:0)&&s[k]<=(k==='level'?20:['gold','damage'].includes(k)?1000000:10000),paired=k=>known(a,k)&&known(b,k);
 const total=(side,key,rs=ROLES)=>rs.every(r=>known(stats?.[r]?.[side],key))?rs.reduce((sum,r)=>sum+stats[r][side][key],0):null;
 // Team shares reduce the common rich/winning-team effect. If a whole team total
 // is unavailable, compare the observed pair with lower evidence, never fill zeros.
 const normalized=(key,prior,rs=ROLES)=>{if(!paired(key))return null;const ta=total('A',key,rs),tb=total('B',key,rs);return ta>0&&tb>0?contrast(a[key]/ta,b[key]/tb,prior):contrast(a[key]/scale,b[key]/scale,key==='damage'?500:key==='gold'?100:1);};
 const ka=total('A','k'),kb=total('B','k'),support=role==='SUP';
 const kp=support?(paired('a')&&ka>0&&kb>0?a.a/ka-b.a/kb:paired('a')?contrast(a.a/scale,b.a/scale,.25):null):(paired('k')&&paired('a')&&ka>0&&kb>0?(a.k+a.a)/ka-(b.k+b.a)/kb:null);
 const efficiency=support?(paired('a')&&paired('d')?contrast(Math.log1p(a.a/(a.d+3)),Math.log1p(b.a/(b.d+3)),.5):null):['k','d','a'].every(paired)?contrast(Math.log1p((a.k+a.a)/(a.d+3)),Math.log1p((b.k+b.a)/(b.d+3)),.5):null;
 const values={gold:normalized('gold',.03,ROLES.filter(r=>r!=='SUP')),cs:normalized('cs',.025,ROLES.filter(r=>r!=='SUP')),level:paired('level')?Math.tanh((a.level-b.level)/3):null,participation:kp,efficiency,damage:normalized('damage',.03,ROLES.filter(r=>r!=='SUP'))};
 if(support){values.gold=values.cs=values.level=values.damage=null;if(paired('a')&&a.a===0&&b.a===0)values.participation=values.efficiency=null;}
 const weights={...Object.fromEntries(Object.entries(rule.economy).map(([k,w])=>[k,w*rule.growth])),participation:rule.participation,efficiency:rule.efficiency,damage:rule.damage};
 const observed=Object.keys(weights).filter(k=>weights[k]>0&&values[k]!==null),coverage=observed.reduce((s,k)=>s+weights[k],0);if(!coverage)return null;
 const score=clamp(observed.reduce((s,k)=>s+weights[k]*values[k],0)/coverage,-1,1),eligible=1-weights.cs;
 let completeness=clamp((coverage-(values.cs!==null?weights.cs:0))/eligible,0,1),contextComplete=ka!==null&&kb!==null&&['gold','damage'].every(k=>weights[k]===0||values[k]===null||total('A',k,ROLES.filter(r=>r!=='SUP'))>0&&total('B',k,ROLES.filter(r=>r!=='SUP'))>0);
 if(!contextComplete)completeness*=.75;
 const evidence=rule.evidence*completeness*(minutes?Math.min(1,minutes/20):.75),adv=score>=.10?'A':score<=-.10?'B':'E';
 const labels={gold:'팀 내 골드 비중',cs:'팀 내 CS 비중',level:'레벨',participation:support?'어시스트 관여':'킬 관여',efficiency:support?'어시·데스 효율':'교전 효율',damage:'팀 내 피해량 비중'};
 return {modelVersion:MODEL_VERSION,score,adv,label:adv==='E'?'수치상 비슷':`${adv}팀 수치상 우세`,completeness,observedWeight:coverage,eligibleWeight:eligible,evidence,parts:observed.map(k=>({metric:k,label:labels[k],diff:values[k],weight:weights[k]/coverage})),growthParts:values,minutes,definition:rule.definition,observedMetrics:observed,contextComplete,rates:Object.fromEntries([['A',a],['B',b]].map(([side,s])=>[side,Object.fromEntries(['cs','gold','damage'].map(k=>[k,minutes&&known(s,k)?s[k]/minutes:null]))]))};
}
export function deriveResult(stats,duration,modes={}){const roleAdv={},roleObserved={},roleEvidenceWeight={},roleAdvSource={},statAssessment={};for(const r of ROLES){const x=assessRole(r,stats,duration);if(x)statAssessment[r]=x;if(!x||modes[r]==='U'){roleAdv[r]='U';roleObserved[r]=null;roleEvidenceWeight[r]=0;roleAdvSource[r]='unknown';}else{roleAdv[r]=x.adv;roleObserved[r]=x.score;roleEvidenceWeight[r]=x.evidence;roleAdvSource[r]='role-proxy';}}return {modelVersion:MODEL_VERSION,roleAdv,roleObserved,roleEvidenceWeight,roleAdvSource,statAssessment};}
export function teamPrediction(roster,roles,confirmed=true){const players=new Map(roster.map(p=>[p.id,p]));const teams=Object.fromEntries(['A','B'].map(side=>[side,ROLES.map(r=>{const p=players.get(roles[r]?.[side==='A'?'aId':'bId']);if(!p)throw new Error('선수 정보를 확인해 주세요.');const skill=confirmed?{mean:roleStrength(p,r),variance:roleUncertainty(p,r)**2}:{mean:-estimatedTier(p),variance:newSkill(p)?p.skillRating.general.variance:RATING_POLICY.generalVariance};return {id:p.id,role:r,...skill};})]));const means=Object.fromEntries(['A','B'].map(s=>[s,teams[s].reduce((n,p)=>n+p.mean,0)])),vars=Object.fromEntries(['A','B'].map(s=>[s,teams[s].reduce((n,p)=>n+p.variance,0)])),c=Math.sqrt(vars.A+vars.B+2*RATING_POLICY.teamNoiseVariance),gap=means.A-means.B;return {predictedAWin:sigmoid(gap/c),scale:c,strengthGap:gap,teams,teamMeans:means,teamVariances:vars,feature:ROLES.slice(0,3).map((r,i)=>teams.A[i].mean-teams.B[i].mean).concat((teams.A[3].mean+teams.A[4].mean)-(teams.B[3].mean+teams.B[4].mean))};}
export function applyRatingUpdate(state,record){
 if(record.modelVersion!==MODEL_VERSION)return legacy.applyRatingUpdate(state,record);
 const winnerKnown=['A','B'].includes(record.winner),confirmed=record.rolesConfirmed!==false,hasStats=confirmed&&ROLES.some(r=>(record.roleEvidenceWeight?.[r]||0)>0);
 if(!winnerKnown&&!hasStats){record.ratingApplied=false;record.loggedAt||=new Date().toISOString();state.history.push(record);return;}
 const players=new Map(state.roster.map(p=>[p.id,p]));for(const id of new Set(ROLES.flatMap(r=>[record.roles[r].aId,record.roles[r].bId])))ensureSkill(players.get(id));
 const prediction=teamPrediction(state.roster,record.roles,confirmed);record.predictedAWin=prediction.predictedAWin;record.feature=prediction.feature;record.predictionScale=prediction.scale;
 if(winnerKnown){const residual=(record.winner==='A'?1:0)-prediction.predictedAWin,curvature=prediction.predictedAWin*(1-prediction.predictedAWin);for(const side of ['A','B'])for(const entry of prediction.teams[side]){const p=players.get(entry.id),q=confirmed?p.skillRating.roles[entry.role]:p.skillRating.general,v=q.variance;q.delta+=v/prediction.scale*(side==='A'?1:-1)*residual;q.variance=Math.max(.05,v*(1-RATING_POLICY.gamma*v/(prediction.scale**2)*curvature));q.games++;}}
 for(const r of ROLES){const a=players.get(record.roles[r].aId),b=players.get(record.roles[r].bId);for(const[p,side]of[[a,'A'],[b,'B']]){p.stats.games++;if(winnerKnown)p.stats[record.winner===side?'wins':'losses']++;}
  const evidence=record.roleEvidenceWeight?.[r]||0,observed=record.roleObserved?.[r];if(!confirmed||evidence<=0||observed==null)continue;
  for(const[p,sign]of[[a,1],[b,-1]]){const q=p.skillRating.roles[r];q.performanceSum+=sign*evidence*observed;q.performanceWeight+=evidence;const st=p.stats.role[r];st.games++;st[record.roleAdv[r]==='E'?'even':record.roleAdv[r]===(sign===1?'A':'B')?'better':'worse']++;}
 }
 state.model.algorithm=RATING_VERSION;state.model.weights=[1,1,1,1];state.model.gamesLearned++;record.weightsBefore=record.ratingBefore?.model?.weights||[1,1,1,1];record.weightsAfter=[1,1,1,1];record.ratingVersion=RATING_VERSION;record.tierSensitivity=1;record.roleTierSensitivity=1;record.ratingApplied=true;record.roleAssessmentProvisional=!confirmed;record.loggedAt||=new Date().toISOString();
 for(const id of new Set(ROLES.flatMap(r=>[record.roles[r].aId,record.roles[r].bId]))){const p=players.get(id);p.timeline||=[];p.timeline.push({time:record.loggedAt,tier:Number(estimatedTier(p).toFixed(4)),source:record.source||'live',gameId:record.id,ratingVersion:RATING_VERSION});}
 state.history.push(record);
}
