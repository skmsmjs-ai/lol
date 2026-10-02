// Inner-room comparison heuristic, not Riot MMR or an empirically calibrated skill scale.
export const MODEL_VERSION = 'role-five-inputs-2026-10-01-v1';
export const RATING_VERSION = 'tier-sensitivity-2026-10-03-v4';
// Apply the gain when interpreting stored corrections, so old originals need no replay.
export const TIER_SENSITIVITY = 7;
export const ROLES = ['TOP', 'JG', 'MID', 'ADC', 'SUP'];
export const ROLE_KR = { TOP: '탑', JG: '정글', MID: '미드', ADC: '원딜', SUP: '서포터' };
export const PRIOR = [1, 1.08, 1, .95];
export const ROLE_RULES = {
  TOP: { growth: .60, participation: .15, efficiency: .25, economy: { gold: .40, cs: .30, level: .30 }, evidence: .45, definition: '상대 탑보다 골드·CS·레벨 성장을 유지하면서 교전에 기여합니다.' },
  JG: { growth: .40, participation: .35, efficiency: .25, economy: { gold: .45, cs: .30, level: .25 }, evidence: .35, definition: '정글 성장을 유지하면서 팀의 킬에 참여합니다.' },
  MID: { growth: .50, participation: .25, efficiency: .25, economy: { gold: .45, cs: .30, level: .25 }, evidence: .45, definition: '골드·CS·레벨 성장과 교전 참여를 함께 확보합니다.' },
  ADC: { growth: .65, participation: .15, efficiency: .20, economy: { gold: .50, cs: .35, level: .15 }, evidence: .40, definition: 'CS와 골드를 꾸준히 확보하고 교전에서 KDA 효율을 유지합니다.' },
  SUP: { growth: .10, participation: .60, efficiency: .30, economy: { gold: .60, cs: 0, level: .40 }, evidence: .25, definition: '팀의 킬에 함께 참여하고 KDA 효율을 유지합니다. CS는 평가하지 않습니다.' }
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
export function estimatedTier(player) {
  return clamp(Number(player.baseTier ?? player.tier ?? 3) - TIER_SENSITIVITY * Number(player.rating || 0), -.5, 10);
}
export function roleTier(player, role) {
  return clamp(Number(player.baseTier ?? player.tier ?? 3) - TIER_SENSITIVITY * (Number(player.rating || 0) + Number(player.roleRating?.[role] || 0)), -.5, 10);
}
export function tierCorrection(player) { return estimatedTier(player) - Number(player.baseTier ?? player.tier ?? 3); }
// Historical points retain their original meaning. Add a display-only current point
// if a sensitivity change makes the stored last estimate differ from today's estimate.
export function tierTrendPoints(player) {
  const points = (player.timeline || []).filter(x => Number.isFinite(Number(x.tier))).map(x => ({...x})).sort((a,b) => new Date(a.time) - new Date(b.time));
  const last = points.at(-1), current = Number(estimatedTier(player).toFixed(4));
  if (last && Math.abs(Number(last.tier) - current) > .0001) points.push({time:last.time,tier:current,source:'current-sensitivity',derived:true});
  return points.slice(-40);
}
const sigmoid = x => 1 / (1 + Math.exp(-clamp(x, -30, 30)));
export function parseDuration(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{1,3}):([0-5]\d)$/);
  if (!m) return null;
  const seconds = Number(m[1]) * 60 + Number(m[2]);
  return seconds > 0 && seconds <= 180 * 60 ? seconds : null;
}
export function validStat(s) {
  if (!s || !['k', 'd', 'a', 'cs', 'gold', 'level'].every(k => typeof s[k] === 'number' && Number.isSafeInteger(s[k]))) return false;
  return ['k', 'd', 'a', 'cs', 'gold'].every(k => s[k] >= 0 && s[k] <= (k === 'gold' ? 1000000 : 10000)) && s.level >= 1 && s.level <= 20;
}
export function validateGameStats(stats, duration) {
  if (!parseDuration(duration)) return '게임시간';
  for (const r of ROLES) for (const side of ['A', 'B']) if (!validStat(stats?.[r]?.[side])) return `${ROLE_KR[r]} ${side}팀: 레벨(1~20)·K/D/A·CS·골드를 정수로 입력해 주세요.`;
  for (const side of ['A', 'B']) {
    const total = ROLES.reduce((n, r) => n + stats[r][side].k, 0);
    if (ROLES.some(r => stats[r][side].k + stats[r][side].a > total)) return `${side}팀의 K+A가 팀 전체 킬보다 큽니다. 킬·어시스트를 확인해 주세요.`;
  }
  return null;
}
// Signed bounded contrast. Pseudocounts tame tiny counts; no missing value becomes zero.
const contrast = (a, b, prior) => Math.tanh(Math.log((a + prior) / (b + prior)) / Math.log(2));
export function assessRole(role, stats, duration) {
  const rule = ROLE_RULES[role], seconds = parseDuration(duration);
  const a = stats?.[role]?.A, b = stats?.[role]?.B;
  if (!rule || !seconds || !validStat(a) || !validStat(b)) return null;
  const minutes = seconds / 60;
  const teamKills = side => ROLES.every(r => validStat(stats?.[r]?.[side])) ? ROLES.reduce((n, r) => n + stats[r][side].k, 0) : null;
  const ka = teamKills('A'), kb = teamKills('B');
  const kpKnown = ka > 0 && kb > 0 && a.k + a.a <= ka && b.k + b.a <= kb;
  const values = {
    gold: contrast(a.gold / minutes, b.gold / minutes, 100),
    cs: contrast(a.cs / minutes, b.cs / minutes, 1),
    level: Math.tanh((a.level - b.level) / 3),
    efficiency: contrast(Math.log1p((a.k + a.a) / Math.max(1, a.d)), Math.log1p((b.k + b.a) / Math.max(1, b.d)), .5),
    participation: kpKnown ? (a.k + a.a) / ka - (b.k + b.a) / kb : null
  };
  const growth = Object.entries(rule.economy).reduce((n, [k, w]) => n + w * values[k], 0);
  // Do not redistribute unknown kill participation to unrelated growth metrics.
  const score = rule.growth * growth + rule.efficiency * values.efficiency + (kpKnown ? rule.participation * values.participation : 0);
  const coverage = 1 - (kpKnown ? 0 : rule.participation);
  const durationFactor = Math.min(1, minutes / 20);
  const evidence = rule.evidence * coverage * durationFactor;
  const adv = score >= .10 ? 'A' : score <= -.10 ? 'B' : 'E';
  const parts = [
    { metric: 'growth', label: '성장', diff: growth, weight: rule.growth },
    { metric: 'participation', label: '킬 관여', diff: values.participation, weight: rule.participation },
    { metric: 'efficiency', label: 'KDA 효율', diff: values.efficiency, weight: rule.efficiency }
  ];
  return { modelVersion: MODEL_VERSION, score, adv, label: adv === 'E' ? '수치상 비슷' : `${adv}팀 수치상 우세`, completeness: coverage, evidence, parts, growthParts: values, minutes, definition: rule.definition, rates: { A: { cs: a.cs / minutes, gold: a.gold / minutes }, B: { cs: b.cs / minutes, gold: b.gold / minutes } } };
}
export function deriveResult(stats, duration, modes = {}) {
  const roleAdv = {}, roleObserved = {}, roleEvidenceWeight = {}, roleAdvSource = {}, statAssessment = {};
  for (const r of ROLES) {
    const x = assessRole(r, stats, duration);
    if (x) statAssessment[r] = x;
    // Historical manual choices remain readable. New inputs only offer automatic or exclude.
    if (!x || modes[r] === 'U') {
      roleAdv[r] = 'U'; roleObserved[r] = null; roleEvidenceWeight[r] = 0; roleAdvSource[r] = 'unknown';
    } else {
      roleAdv[r] = x.adv; roleObserved[r] = clamp(.5 + .5 * x.score, .15, .85); roleEvidenceWeight[r] = x.evidence; roleAdvSource[r] = 'five-inputs';
    }
  }
  return { modelVersion: MODEL_VERSION, roleAdv, roleObserved, roleEvidenceWeight, roleAdvSource, statAssessment };
}
export function applyRatingUpdate(state, record) {
  record.ratingVersion = RATING_VERSION;
  record.tierSensitivity = TIER_SENSITIVITY;
  const winnerKnown = record.winner === 'A' || record.winner === 'B';
  const before = [...state.model.weights];
  const y = record.winner === 'A' ? 1 : 0;
  if (winnerKnown) {
    const lr = .045 / Math.sqrt(1 + state.model.gamesLearned / 20);
    for (let i = 0; i < 4; i++) state.model.weights[i] = clamp(before[i] + lr * ((y - record.predictedAWin) * record.feature[i] + .025 * (PRIOR[i] - before[i])), .40, 1.80);
  }
  const players = new Map(state.roster.map(p => [p.id, p]));
  for (const r of ROLES) {
    const m = record.roles[r], pa = players.get(m.aId), pb = players.get(m.bId);
    if (!pa || !pb) throw new Error('선수를 찾을 수 없습니다.');
    for (const [p, side] of [[pa, 'A'], [pb, 'B']]) {
      if (winnerKnown) {
        const k = .075 / Math.sqrt(1 + p.stats.games / 20);
        p.rating = clamp(p.rating + k * (side === 'A' ? 1 : -1) * (y - record.predictedAWin), -1.5, 1.5);
        if (record.winner === side) p.stats.wins++; else p.stats.losses++;
      }
      p.stats.games++;
    }
    const actual = record.roleObserved?.[r], evidence = record.roleEvidenceWeight?.[r] || 0;
    if (actual === null || actual === undefined || evidence <= 0) continue;
    const expected = sigmoid((m.bTier - m.aTier) / 1.2);
    const count = (pa.stats.role[r].games + pb.stats.role[r].games) / 2;
    // Never transfer a role-stat proxy into the player's global skill estimate.
    const delta = clamp(.12 * evidence * (actual - expected) / Math.sqrt(1 + count / 18), -.04, .04);
    pa.roleRating[r] = clamp(pa.roleRating[r] + delta, -1.35, 1.35);
    pb.roleRating[r] = clamp(pb.roleRating[r] - delta, -1.35, 1.35);
    const sa = pa.stats.role[r], sb = pb.stats.role[r]; sa.games++; sb.games++;
    if (record.roleAdv[r] === 'A') { sa.better++; sb.worse++; }
    else if (record.roleAdv[r] === 'B') { sa.worse++; sb.better++; }
    else { sa.even++; sb.even++; }
  }
  state.model.gamesLearned++;
  record.weightsBefore = before; record.weightsAfter = [...state.model.weights];
  record.loggedAt ||= new Date().toISOString();
  for (const id of new Set(ROLES.flatMap(r => [record.roles[r].aId, record.roles[r].bId]))) {
    const p = players.get(id); p.timeline ||= [];
    p.timeline.push({ time: record.loggedAt, tier: Number(estimatedTier(p).toFixed(4)), source: record.source || 'live', gameId: record.id, tierSensitivity: TIER_SENSITIVITY });
  }
  state.history.push(record);
}
