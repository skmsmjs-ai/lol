import { cloudEndpoint } from './cloud-config.js?v=7-role-fixed-20261007';
const $ = selector => document.querySelector(selector);
const clone = value => value===undefined?undefined:JSON.parse(JSON.stringify(value));
const shared = state => { const value=clone(state); delete value.session; return value; };
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
// Merge independent edits. Conflicting edits never silently overwrite one another.
export function mergeDocuments(base, local, remote) {
  function merge(b,l,r,path) {
    if(same(l,b)) return clone(r);
    if(same(r,b)||same(l,r)) return clone(l);
    if(Array.isArray(b)&&Array.isArray(l)&&Array.isArray(r)&&[...b,...l,...r].every(x=>x&&typeof x.id==='string')) {
      const bm=new Map(b.map(x=>[x.id,x])),lm=new Map(l.map(x=>[x.id,x])),rm=new Map(r.map(x=>[x.id,x]));
      return [...new Set([...r.map(x=>x.id),...l.map(x=>x.id)])].flatMap(id=>{
        const old=bm.get(id),left=lm.get(id),right=rm.get(id);
        if(!old){if(left&&right&&!same(left,right))throw new Error(path);return [clone(left||right)];}
        if(!left||!right){if(same(left||right,old))return [];throw new Error(path);}
        return [merge(old,left,right,`${path}.${id}`)];
      });
    }
    if(b&&l&&r&&!Array.isArray(b)&&typeof b==='object'&&typeof l==='object'&&typeof r==='object') {
      const result={};for(const key of new Set([...Object.keys(b),...Object.keys(l),...Object.keys(r)])) {
        // Derived ratings are recalculated on the server from accepted records.
        if((path==='자료'&&['model','lastBackup'].includes(key))||(path.startsWith('자료.roster.')&&['rating','roleRating','stats','timeline'].includes(key))){result[key]=clone(r[key]??l[key]);continue;}
        if(l[key]===undefined||r[key]===undefined){if(same(l[key],b[key])){if(r[key]!==undefined)result[key]=clone(r[key]);}else if(same(r[key],b[key])){if(l[key]!==undefined)result[key]=clone(l[key]);}else throw new Error(`${path}.${key}`);}
        else result[key]=merge(b[key],l[key],r[key],`${path}.${key}`);
      }return result;
    }
    throw new Error(path);
  }
  return merge(base,local,remote,'자료');
}
export class SharedStore {
  constructor(options) {Object.assign(this,options);this.enabled=false;this.pending=null;this.base=null;this.revision=0;this.saving=false;this.role=null;this.blocked=false;this.conflicted=false;this.saveWaiters=[];this.lastSaveError=null;this.endpoint=options.endpoint??cloudEndpoint;if(this.endpoint&&!/^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/lol-room$/.test(this.endpoint))throw new Error('Supabase 연결 주소를 확인해 주세요.');this.cacheKey=this.endpoint?`naejun_shared_pending_v6:${this.endpoint}`:'naejun_shared_pending_v6';this.tokenKey=`naejun_cloud_session_v6:${this.endpoint}`;}
  status(message) {$('#saveStatus').textContent=message;}
  async request(path,method='GET',body) {
    const headers=body?{'Content-Type':'application/json','X-Requested-With':'Naejun'}:{};
    if(this.endpoint){const token=localStorage.getItem(this.tokenKey);if(token)headers.Authorization=`Bearer ${token}`;}
    const response=await fetch(this.endpoint?`${this.endpoint}/${path}`:`api/${path}`,{method,credentials:this.endpoint?'omit':'same-origin',headers,body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(15000)});
    const data=await response.json().catch(()=>({error:'서버 응답을 확인하지 못했습니다.'}));
    if(!response.ok)throw Object.assign(new Error(data.error||'요청을 처리하지 못했습니다.'),{status:response.status,data});if(this.endpoint&&data.sessionToken)localStorage.setItem(this.tokenKey,data.sessionToken);if(this.endpoint&&path==='logout')localStorage.removeItem(this.tokenKey);return data;
  }
  cache() {try{localStorage.setItem(this.cacheKey,JSON.stringify({base:this.base,pending:this.pending,revision:this.revision}));return true;}catch{this.status('기기 백업을 저장하지 못했습니다 · 서버 저장 상태를 확인해 주세요');}}
  bind() {
    $('#entryDialog').addEventListener('cancel',event=>event.preventDefault());
    $('#entryForm').onsubmit=async event=>{event.preventDefault();try{await this.request('enter','POST',{pin:$('#entryPin').value.trim()});$('#entryPin').value='';$('#entryError').textContent='';await this.connected();}catch(error){$('#entryError').textContent=error.status===401?'입장 번호가 맞지 않습니다. 공유받은 4자리 번호를 확인해 주세요.':error.message;}};
    $('#entryAdminBtn').onclick=()=>$('#adminDialog').showModal();
    $('#adminOpenBtn').onclick=()=>{if(!this.enabled){this.toast('관리자 옵션은 공유 서버에서 사용할 수 있습니다.');return;}$('#adminDialog').showModal();};
    $('#adminLoginForm').onsubmit=async event=>{event.preventDefault();try{await this.request('admin/login','POST',{username:$('#adminUsername').value,password:$('#adminPassword').value});$('#adminPassword').value='';await this.connected();}catch(error){$('#adminError').textContent=error.message;}};
    $('#pinForm').onsubmit=async event=>{event.preventDefault();try{await this.request('admin/pin','POST',{pin:$('#newPin').value});$('#newPin').value='';this.toast('입장 비밀번호를 변경했습니다. 참가자는 다시 입장합니다.');}catch(error){$('#adminError').textContent=error.message;}};
    $('#passwordForm').onsubmit=async event=>{event.preventDefault();try{await this.request('admin/password','POST',{current:$('#currentAdminPassword').value,password:$('#newAdminPassword').value,...($('#newAdminUsername').value.trim()?{username:$('#newAdminUsername').value.trim()}:{})});$('#newAdminUsername').value='';$('#currentAdminPassword').value='';$('#newAdminPassword').value='';this.toast('관리자 로그인 정보를 변경했습니다. 다른 관리자 접속은 해제했습니다.');}catch(error){$('#adminError').textContent=error.message;}};
    $('#toggleEntryBtn').onclick=async()=>{try{const result=await this.request('admin/entry','POST',{enabled:!this.entryEnabled});this.entryEnabled=result.enabled;$('#toggleEntryBtn').textContent=this.entryEnabled?'참가자 입장 중단':'참가자 입장 허용';}catch(error){$('#adminError').textContent=error.message;}};
    $('#cancelSharedDraftBtn').onclick=async()=>{if(!this.base?.activeDraft){this.toast('입력 중인 공유 경기가 없습니다.');return;}if(this.pending){this.toast('미전송 기록을 먼저 저장해 주세요.');return;}if(!confirm('입력 중인 공유 경기를 보관한 뒤 닫을까요?'))return;try{this.download(this.base.activeDraft,'취소한_경기초안');const data=await this.request('admin/draft/cancel','POST',{revision:this.revision});this.base=data.state;this.revision=data.revision;this.setState(data.state);this.cache();this.toast('공유 경기 초안을 보관하고 닫았습니다.');}catch(error){this.toast(error.message);}};
    $('#legacyImportBtn').onclick=()=>this.importLegacy();
    $('#logoutBtn').onclick=async()=>{if(this.pending){this.toast('미전송 기록을 먼저 저장하거나 백업해 주세요.');return;}await this.request('logout','POST',{});location.reload();};
    $('#syncRetryBtn').onclick=()=>{this.blocked=false;this.flush();};
    $('#cloudReloadBtn').onclick=async()=>{try{if(this.pending&&!confirm('미전송 입력을 백업한 뒤 서버 최신 자료를 불러올까요?'))return;if(this.pending)this.download(this.pending,'미전송_기록');const data=await this.request('state');this.pending=null;this.base=data.state;this.revision=data.revision;this.blocked=false;this.conflicted=false;this.setState(data.state);this.cache();this.status('서버 최신 자료를 불러왔습니다');$('#cloudReloadBtn').hidden=true;$('#syncRetryBtn').hidden=true;}catch(error){this.status(error.message);}};
    $('#entryRetryBtn').onclick=()=>this.start(false);
    window.addEventListener('online',()=>{this.blocked=false;this.flush();});
    window.addEventListener('beforeunload',event=>{if(this.pending){event.preventDefault();event.returnValue='';}});
  }
  async start(bind=true) {
    if(bind)this.bind();
    try {
      let info;try{info=await this.request('session');}catch(error){if(!this.endpoint&&error.status===404){this.status('이 기기에 저장됨');return;}throw error;}
      this.enabled=true;
      if(info.authenticated)await this.connected();else this.gate();
    }catch(error){this.enabled=true;this.gate();$('#entryError').textContent='서버에 연결하지 못했습니다. 기존 입력은 보존되어 있습니다.';$('#entryRetryBtn').hidden=false;}
  }
  gate() {document.querySelector('.app-shell').inert=true;$('#adminDialog').close();if(!$('#entryDialog').open)$('#entryDialog').showModal();this.role=null;this.status('입장 비밀번호를 입력해 주세요');}
  async connected() {
    const info=await this.request('session');this.role=info.role;this.entryEnabled=info.entryEnabled;
    $('#adminLoginForm').hidden=this.role==='admin';$('#adminOptions').hidden=this.role!=='admin';
    $('#toggleEntryBtn').textContent=this.entryEnabled?'참가자 입장 중단':'참가자 입장 허용';
    const data=await this.request('state');
    this.base=data.state;this.revision=data.revision;
    let pending;try{pending=JSON.parse(localStorage.getItem(this.cacheKey)||'null');}catch{}
    if(pending?.pending&&pending.base){
      try{this.pending=mergeDocuments(pending.base,pending.pending,data.state);}
      catch{this.pending=pending.pending;this.blocked=true;this.conflicted=true;this.status('다른 사람의 수정과 겹칩니다 · 미전송 기록을 백업하고 최신 자료를 확인해 주세요');$('#cloudReloadBtn').hidden=false;}
    }
    $('#resetBtn').hidden=this.role!=='admin';this.setState(this.pending||data.state);document.querySelector('.app-shell').inert=false;$('#entryDialog').close();
    if(!this.blocked)this.status('서버에 저장됨 · 다른 기기에서도 불러옵니다');
    if(this.pending&&!this.blocked)this.flush();
    clearInterval(this.poll);this.poll=setInterval(()=>this.refresh(),8000);
  }
  save(state) {
    if(!this.role){this.status('다시 입장해 주세요. 입력은 기기에 보존합니다.');return;}
    const next=shared(state);if(same(next,this.base)&&!this.pending)return;
    this.pending=next;const cached=this.cache();this.status(cached?'서버에 저장 중':'기기 백업 실패 · 서버에 저장 중');this.flush();return cached;
  }
  async saveConfirmed(state) {
    if(this.blocked&&!this.conflicted)this.blocked=false;
    this.lastSaveError=null;
    this.save(state);
    for(let attempt=0;attempt<3;attempt++){
      if(this.saving)await new Promise(resolve=>this.saveWaiters.push(resolve));
      if(!this.pending&&this.role)return this.base;
      if(this.blocked||!this.role)break;
      await this.flush();
    }
    throw new Error(this.lastSaveError||'서버에 저장하지 못했습니다. 입력은 보존했습니다. 저장을 다시 시도해 주세요.');
  }
  async flush() {
    if(!this.pending||this.saving||this.blocked||!this.role)return;
    this.saving=true;const sent=clone(this.pending);
    try {
      const data=await this.request('state','PUT',{revision:this.revision,state:sent});
      if(same(this.pending,sent)){this.pending=null;this.setState(data.state);}
      else {this.pending=mergeDocuments(sent,this.pending,data.state);this.setState(this.pending);}
      this.base=data.state;this.revision=data.revision;this.status(this.pending?'서버에 저장 중':'서버에 저장됨 · 다른 기기에서도 불러옵니다');$('#syncRetryBtn').hidden=true;$('#cloudReloadBtn').hidden=true;this.cache();
    }catch(error){
      this.lastSaveError=error.message;
      if(error.status===409&&error.data?.state){
        try{this.pending=mergeDocuments(this.base,this.pending,error.data.state);this.base=error.data.state;this.revision=error.data.revision;this.cache();}
        catch{this.blocked=true;this.conflicted=true;this.status('다른 사람의 수정과 겹칩니다 · 입력을 보존했습니다');$('#cloudReloadBtn').hidden=false;}
      }else if(error.status===401){this.cache();this.gate();$('#entryError').textContent='입장이 만료되었습니다. 새 비밀번호로 다시 입장해 주세요.';}
      else {this.blocked=true;this.status('서버에 저장하지 못했습니다 · 입력은 기기에 보관했습니다');$('#syncRetryBtn').hidden=false;this.toast(error.message);}
    }finally {this.saving=false;this.saveWaiters.splice(0).forEach(resolve=>resolve());if(this.pending&&!this.blocked&&this.role)setTimeout(()=>this.flush(),0);}
  }
  async refresh() {
    if(!this.role||this.pending||this.saving||document.querySelector('dialog[open]')||document.activeElement?.matches('input,textarea,select'))return;
    try{const data=await this.request('state');if(data.revision!==this.revision){this.base=data.state;this.revision=data.revision;this.setState(data.state);this.status('다른 사람의 새 기록을 불러왔습니다');}}catch(error){if(error.status===401)this.gate();}
  }
  async editRecord(edit){
    if(this.pending||this.saving)throw new Error('상단의 기존 입력 저장이 끝난 뒤 수정해 주세요. 수정 초안은 보존했습니다.');
    if(!this.role)throw new Error('다시 입장한 뒤 수정 내용을 저장해 주세요.');
    this.saving=true;this.status('전적 수정과 티어를 저장 중');
    try{
      let data;
      for(let attempt=0;attempt<3;attempt++){
        const current=await this.request('state');
        try{data=await this.request('records/edit','POST',{...edit,revision:current.revision});break;}
        catch(error){if(error.status===409&&error.data?.state&&!error.data?.conflicts&&attempt<2)continue;throw error;}
      }
      this.base=data.state;this.revision=data.revision;this.setState(data.state);this.cache();this.status('전적 수정이 서버에 저장됨 · 다른 기기에서도 불러옵니다');return data.state;
    }catch(error){this.status('전적 수정을 저장하지 못했습니다 · 수정 초안은 기기에 보관했습니다');throw error;}
    finally{this.saving=false;this.saveWaiters.splice(0).forEach(resolve=>resolve());}
  }
  download(value,name){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));a.href=url;a.download=`내전_${name}_${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async reset(){
    if(this.role!=='admin'){this.toast('관리자만 초기화할 수 있습니다.');return;}
    if(this.pending){this.toast('미전송 기록을 먼저 저장해 주세요.');return;}
    if(!confirm('현재 자료를 백업한 뒤 초기화할까요? 서버에도 이전 자료를 보존합니다.'))return;
    this.download(this.base,'초기화전_원본');
    try{const data=await this.request('admin/reset','POST',{revision:this.revision});this.base=data.state;this.revision=data.revision;this.setState(data.state);this.cache();this.toast('백업을 보존하고 초기화했습니다.');}catch(error){this.toast(error.message);}
  }
  async importFile(file){
    if(this.role!=='admin'){this.toast('공유 서버의 자료 가져오기는 관리자만 할 수 있습니다.');return;}
    if(this.pending){this.toast('미전송 기록을 먼저 저장해 주세요.');return;}
    try{const incoming=this.migrate(JSON.parse(await file.text()));if(!confirm('선택한 백업을 서버에 가져올까요? 다른 경기 기록이 있으면 중단합니다.'))return;this.download(this.base,'가져오기전_원본');const data=await this.request('admin/import','POST',{revision:this.revision,state:shared(incoming)});this.base=data.state;this.revision=data.revision;this.setState(data.state);this.cache();this.toast('백업을 가져왔습니다.');}catch(error){this.toast(error.message);}
  }
  async importLegacy() {
    if(this.role!=='admin')return;
    if(!this.legacy){this.toast('기존 자료를 읽지 못했습니다. 원본 백업 파일을 확인해 주세요.');return;}
    if(this.pending){this.toast('미전송 기록을 먼저 저장해 주세요.');return;}
    if(!confirm('이 기기에 있던 기존 기록을 백업하고 공유 서버로 가져올까요?'))return;
    this.download(this.legacy,'기존자료_원본');
    try{const data=await this.request('admin/import','POST',{revision:this.revision,state:shared(this.legacy)});this.base=data.state;this.revision=data.revision;this.setState(data.state);this.cache();this.toast('기존 자료를 가져왔습니다. 원본 백업과 서버 이전 자료를 보존했습니다.');}catch(error){$('#adminError').textContent=error.message;}
  }
}
