import { ROLES, ROLE_KR, parseDuration } from './role-model.js?v=6-save-20261003';

const names = new Intl.Collator('ko', { numeric: true, sensitivity: 'variant' });
export const comparePlayerNames = (a, b) => names.compare(a.name.normalize('NFC'), b.name.normalize('NFC')) || String(a.id).localeCompare(String(b.id));

// Store the existing server format; accept normal keyboard and Korean time input.
export function normalizeGameDuration(value) {
  const text = String(value ?? '').normalize('NFKC').trim();
  let match = text.match(/^(\d{1,3})\s*:\s*(\d{1,2})$/);
  if (!match) match = text.match(/^(\d{1,3})\s*분(?:\s*(\d{1,2})\s*초)?$/);
  if (!match && /^\d{1,3}$/.test(text)) match = [text, text, '0'];
  if (!match) return null;
  const canonical = `${Number(match[1])}:${String(Number(match[2] ?? 0)).padStart(2, '0')}`;
  return parseDuration(canonical) ? canonical : null;
}

export function firstStatIssue(stats) {
  const labels = { level: '레벨', k: '킬', d: '데스', a: '어시스트', cs: 'CS', gold: '골드' };
  for (const role of ROLES) for (const side of ['A', 'B']) for (const key of Object.keys(labels)) {
    const value = stats?.[role]?.[side]?.[key];
    const min = key === 'level' ? 1 : 0, max = key === 'level' ? 20 : key === 'gold' ? 1000000 : 10000;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      return { role, side, key, message: `${ROLE_KR[role]} ${side}팀의 ${labels[key]}를 ${min}~${max} 사이 정수로 입력해 주세요.` };
    }
  }
  return null;
}

// A pending record keeps its ID; retries must never silently discard edited inputs.
export function sameGameInput(a,b) {
  if(a.duration!==b.duration||a.winner!==b.winner)return false;
  return ROLES.every(r=>['aId','bId'].every(k=>a.roles?.[r]?.[k]===b.roles?.[r]?.[k])
    &&(a.roleAdv?.[r]==='U')===(b.roleAdv?.[r]==='U')
    &&['A','B'].every(side=>['level','k','d','a','cs','gold'].every(k=>a.stats?.[r]?.[side]?.[k]===b.stats?.[r]?.[side]?.[k])));
}
