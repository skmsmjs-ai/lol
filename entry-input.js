import { ROLES, ROLE_KR, parseDuration } from './role-model.js?v=7-role-evidence-20261007';

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

export function firstStatIssue(stats, allowMissing=false) {
  const labels = { level: '레벨', k: '킬', d: '데스', a: '어시스트', cs: 'CS', gold: '골드', damage: '챔피언 피해량' };
  for (const role of ROLES) for (const side of ['A', 'B']) for (const key of Object.keys(labels)) {
    const value = stats?.[role]?.[side]?.[key];
    if((allowMissing||key==='damage') && value==null)continue;
    const min = key === 'level' ? 1 : 0, max = key === 'level' ? 20 : ['gold','damage'].includes(key) ? 1000000 : 10000;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      return { role, side, key, message: `${ROLE_KR[role]} ${side}팀의 ${labels[key]}를 ${min}~${max} 사이 정수로 입력해 주세요.` };
    }
  }
  return null;
}

// A pending record keeps its ID; retries must never silently discard edited inputs.
export function sameGameInput(a,b) {
  if(a.duration!==b.duration||a.winner!==b.winner||(a.source==='past'&&a.time!==b.time)||(a.rolesConfirmed===false)!==(b.rolesConfirmed===false))return false;
  return ROLES.every(r=>['aId','bId'].every(k=>a.roles?.[r]?.[k]===b.roles?.[r]?.[k])
    &&(a.roleAdv?.[r]==='U')===(b.roleAdv?.[r]==='U')
    &&['A','B'].every(side=>['level','k','d','a','cs','gold','damage'].every(k=>(a.stats?.[r]?.[side]?.[k]??null)===(b.stats?.[r]?.[side]?.[k]??null))));
}

export function parseQuickStats(text){
 const m=String(text).trim().match(/^(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)(.*)$/);if(!m)throw new Error('K/D/A를 6/2/20처럼 입력해 주세요.');
 const keys=['damage','cs','gold','level'],tail=m[4].trim().replace(/^[:,]\s*/,'').split(/[\s,]+/).filter(Boolean);if(tail.length>4)throw new Error('K/D/A 뒤에는 피해량, CS, 골드, 레벨 순서로 입력해 주세요.');
 const values={k:Number(m[1]),d:Number(m[2]),a:Number(m[3])};tail.forEach((v,i)=>{if(v!=='-'&&!/^\d+$/.test(v))throw new Error('수치는 정수로, 모르는 값은 -로 입력해 주세요.');values[keys[i]]=v==='-'?null:Number(v);});
 for(const[k,v]of Object.entries(values)){if(v==null)continue;const min=k==='level'?1:0,max=k==='level'?20:['gold','damage'].includes(k)?1000000:10000;if(!Number.isSafeInteger(v)||v<min||v>max)throw new Error('레벨은 1~20, 킬·데스·어시스트·CS는 0~10000, 골드·피해량은 0~1000000의 정수로 입력해 주세요.');}return values;
}
export function requiredRoleIssue(stats){
 const required={TOP:['gold','level'],JG:['gold','level'],MID:['gold'],ADC:['gold'],SUP:[]};
 for(const role of ROLES)for(const side of ['A','B'])for(const key of required[role])if(stats?.[role]?.[side]?.[key]==null)return {role,side,key,message:`${ROLE_KR[role]} ${side}팀의 ${key==='gold'?'골드':'레벨'}가 필요합니다. 확인하기 어렵다면 '필수 수치를 확인하기 어려우면 비워 두고 저장'을 선택해 주세요.`};return null;
}
