/*
  내전 자동 매칭기 — 계산 엔진
  ---------------------------------------------
  핵심 철학
  1) 팀 티어 합만 맞추지 않는다.
  2) 같은 역할끼리의 실력차를 별도로 본다.
  3) TOP/JG/MID는 한쪽이 크게 벌어질수록 비선형으로 강하게 벌점.
  4) ADC/SUP는 개인차도 보지만, 바텀 2인 조합의 상호보완도 함께 본다.
  5) 실제 내전 결과가 쌓이면 역할 영향도는 아주 조금씩만 보정된다.

  주의:
  아래 숫자는 Riot이 공개한 공식 매칭 계수가 아니다.
  Riot이 공개한 '역할군 공평성/자동 선택 공평성'이라는 방향을 참고해
  친구 내전에서 설명 가능하고 튜닝 가능한 휴리스틱으로 만든 값이다.
*/

const ROLES = ["TOP", "JG", "MID", "ADC", "SUP"];

// 실제 내전 학습이 없을 때의 출발점.
// 정글만 아주 약간 높게 시작하지만 절대적인 역할 서열을 뜻하지 않는다.
const PRIOR = [1.00, 1.08, 1.00, 0.95]; // TOP, JG, MID, BOT

// TOP/JG/MID의 기본 역할 격차 벌점.
const BASE = [11.0, 12.0, 11.0];

// 1티어 차이를 넘어가면 추가되는 비선형 벌점.
// '2 vs 3'과 '2 vs 5'가 단순히 1과 3만큼 다르다고 보지 않게 한다.
const CLIFF = [38.0, 42.0, 38.0];

// 바텀 듀오 전체 격차 벌점.
const BOT_BASE = 10.0;
const BOT_CLIFF = 28.0;

// ADC/SUP 개인 격차도 완전히 지워버리지는 않는다.
const ADC_INDIV = 2.2;
const SUP_INDIV = 1.8;

// 두 팀 전체 티어 합 차이에 대한 벌점.
const TEAM_TOTAL = 5.0;

// 학습 모델이 한쪽 승률을 50%에서 멀게 볼수록 추가되는 벌점.
const PREDICTION = 350.0;

// 바텀 상호보완: 더 잘하는 선수 60%, 약한 선수 40%.
const BOT_STRONG = 0.60;
const BOT_WEAK = 0.40;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sigmoid = x => x > 30 ? 1 : x < -30 ? 0 : 1 / (1 + Math.exp(-x));
const popcount = n => { let c=0; while(n){ c += n & 1; n >>>= 1; } return c; };

/*
  바텀 듀오 지수
  ----------------
  티어 숫자가 낮을수록 강하므로 min()이 더 잘하는 선수다.
  예) ADC 2 / SUP 6 -> 0.6*2 + 0.4*6 = 3.6
  단순 평균 4.0보다 조금 강하게 평가되지만,
  ADC/SUP 개인 격차 벌점이 별도로 있으므로 완전 상쇄는 아니다.
*/
function botDuoIndex(adc, sup) {
  const strong = Math.min(adc, sup);
  const weak = Math.max(adc, sup);
  return BOT_STRONG * strong + BOT_WEAK * weak;
}

/*
  역할군 격차 벌점
  ----------------
  d <= 1 : 기본 제곱 벌점
  d > 1  : 1티어 초과분에 추가 제곱 벌점

  그래서 큰 역할 격차 하나가 다른 라인의 작은 이득으로 쉽게 묻히지 않는다.
*/
function lanePenalty(gap, baseWeight, cliffWeight, learnedScale) {
  const d = Math.abs(gap);
  let penalty = baseWeight * learnedScale * d * d;
  if (d > 1) penalty += cliffWeight * (d - 1) * (d - 1);
  return penalty;
}

// 실제 내전 학습값이 초기값에서 너무 멀어져 모델이 폭주하지 않게 제한한다.
function learnedScale(model, idx) {
  return clamp(model.weights[idx] / PRIOR[idx], 0.65, 1.45);
}

/*
  A팀 승리확률 모형
  ----------------
  feature가 양수면 A팀이 해당 역할에서 강한 구조다.
  이 확률은 '진짜 승률 예언'이 아니라 후보끼리의 균형을 비교하는 내부 추정치다.
*/
function predictAWin(feature, model) {
  let z = 0;
  for (let i=0; i<4; i++) z += model.weights[i] * feature[i];
  return sigmoid(z);
}

function evaluate(assignA, assignB, players, model, teamMaskA) {
  const tierA = assignA.map(i => players[i].tier);
  const tierB = assignB.map(i => players[i].tier);
  const sumA = tierA.reduce((a,b)=>a+b,0);
  const sumB = tierB.reduce((a,b)=>a+b,0);
  const totalGap = Math.abs(sumA - sumB);
  const gaps = tierA.map((t,i)=>Math.abs(t - tierB[i]));

  const botA = botDuoIndex(tierA[3], tierA[4]);
  const botB = botDuoIndex(tierB[3], tierB[4]);
  const botGap = Math.abs(botA - botB);

  // B - A로 잡는 이유: 티어는 낮을수록 강하므로 양수면 A가 강하다.
  // 3으로 나누어 0~6 정도의 티어 범위를 학습하기 편한 크기로 정규화한다.
  const feature = [
    (tierB[0] - tierA[0]) / 3,
    (tierB[1] - tierA[1]) / 3,
    (tierB[2] - tierA[2]) / 3,
    (botB - botA) / 3
  ];

  const predictedAWin = predictAWin(feature, model);

  let score = TEAM_TOTAL * totalGap * totalGap;
  score += lanePenalty(gaps[0], BASE[0], CLIFF[0], learnedScale(model,0));
  score += lanePenalty(gaps[1], BASE[1], CLIFF[1], learnedScale(model,1));
  score += lanePenalty(gaps[2], BASE[2], CLIFF[2], learnedScale(model,2));
  score += lanePenalty(botGap, BOT_BASE, BOT_CLIFF, learnedScale(model,3));
  score += ADC_INDIV * gaps[3] * gaps[3];
  score += SUP_INDIV * gaps[4] * gaps[4];
  score += PREDICTION * Math.pow(predictedAWin - 0.5, 2);

  return {
    assignA, assignB, teamMaskA, score, predictedAWin, feature,
    tierSumA:sumA, tierSumB:sumB, totalGap,
    topGap:gaps[0], jgGap:gaps[1], midGap:gaps[2], adcGap:gaps[3], supGap:gaps[4],
    botIndexA:botA, botIndexB:botB, botGap
  };
}

function membersFromMask(mask) {
  const out=[];
  for(let i=0;i<10;i++) if(mask & (1<<i)) out.push(i);
  return out;
}

/*
  특정 5명이 TOP/JG/MID/ADC/SUP를 맡는 모든 합법적 배치를 만든다.
  '불가능'으로 체크된 포지션은 아예 후보에 들어가지 않는다.
*/
function validAssignments(members, players) {
  const out=[];
  const used = new Array(members.length).fill(false);
  const current = new Array(5);

  function dfs(role) {
    if (role===5) { out.push(current.slice()); return; }
    for (let j=0;j<members.length;j++) {
      if (used[j]) continue;
      const local = members[j];
      if (!players[local].possible[ROLES[role]]) continue;
      used[j]=true;
      current[role]=local;
      dfs(role+1);
      used[j]=false;
    }
  }
  dfs(0);
  return out;
}

/* 같은 PC방 등 '반드시 같은 팀' 그룹을 찢지 않는지 검사 */
function satisfiesGroups(mask, groupMasks) {
  for (const gm of groupMasks) {
    const inA = gm & mask;
    if (inA !== 0 && inA !== gm) return false;
  }
  return true;
}

// 두 안 사이에서 팀당 몇 명이 실제로 바뀌었는지 계산.
function changedPerTeam(a,b) {
  return popcount(a.teamMaskA ^ b.teamMaskA) / 2;
}

/*
  후보 3개 고르기
  ----------------
  1안: 순수 밸런스 점수가 가장 좋은 안
  2·3안: 같은 팀원에 포지션만 바꾼 복제안은 제외.
          가능하면 앞선 안과 팀당 최소 2명 이상 달라야 한다.
          조건 때문에 후보가 부족할 때만 최소 1명 차이까지 완화한다.
*/
function choosePlans(all) {
  all.sort((a,b)=>a.score-b.score);
  const plans=[];
  if (all.length) plans.push(all[0]);

  const differentEnough = (c,min) => plans.every(p=>changedPerTeam(c,p)>=min);

  for (const c of all) {
    if (plans.length>=3) break;
    if (plans.some(p=>p.teamMaskA===c.teamMaskA)) continue;
    if (differentEnough(c,2)) plans.push(c);
  }

  for (const c of all) {
    if (plans.length>=3) break;
    if (plans.some(p=>p.teamMaskA===c.teamMaskA)) continue;
    if (differentEnough(c,1)) plans.push(c);
  }
  return plans;
}

self.onmessage = e => {
  const {players, model, fixedGroups} = e.data;
  if (!players || players.length!==10) {
    self.postMessage({error:"참가자는 정확히 10명이어야 합니다."});
    return;
  }

  const indexById = new Map(players.map((p,i)=>[p.id,i]));
  const groupMasks = (fixedGroups||[]).map(g => g.reduce((m,id)=> {
    const idx=indexById.get(id);
    return idx===undefined ? m : (m | (1<<idx));
  },0)).filter(Boolean);

  const candidates=[];
  const assignmentCache=new Map();
  let checked=0;

  // 10명 중 5명을 A팀으로 뽑는 모든 경우를 검사한다.
  for (let mask=0; mask<(1<<10); mask++) {
    if (!(mask & 1)) continue;       // A/B 뒤집기 중복 제거
    if (popcount(mask)!==5) continue;
    if (!satisfiesGroups(mask,groupMasks)) continue;

    const other=((1<<10)-1)^mask;
    const getAssignments = m => {
      if (!assignmentCache.has(m)) {
        assignmentCache.set(m, validAssignments(membersFromMask(m), players));
      }
      return assignmentCache.get(m);
    };

    const aa=getAssignments(mask);
    const bb=getAssignments(other);
    if (!aa.length || !bb.length) continue;

    // 같은 5:5 팀 구성 안에서는 역할 배치가 가장 좋은 하나만 남긴다.
    let best=null;
    for (const a of aa) {
      for (const b of bb) {
        const c=evaluate(a,b,players,model,mask);
        if (!best || c.score<best.score) best=c;
      }
    }
    if (best) candidates.push(best);

    checked++;
    if (checked % 20 === 0) self.postMessage({progress:checked});
  }

  const plans=choosePlans(candidates);
  self.postMessage({plans, candidateCount:candidates.length});
};
