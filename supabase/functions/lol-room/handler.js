import { HttpError, validateDocument, acceptChanges } from '../../../room-rules.js';
import { RATING_VERSION, TIER_SENSITIVITY, ROLE_TIER_SENSITIVITY } from '../../../role-model.js';
import { editRecord, sameEditInput } from '../../../record-edits.js';
const clone=value=>JSON.parse(JSON.stringify(value));
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('');
const makeToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32))).map(x=>x.toString(16).padStart(2,'0')).join('');

// Dependency injection keeps the HTTP flow testable against real isolated Postgres.
export function createHandler({rpc,allowedOrigins}) {
  const allowed=new Set(allowedOrigins);
  return async request=>{
    const origin=request.headers.get('Origin'),cors={
      'Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers':'authorization, content-type, x-requested-with',
      'Access-Control-Max-Age':'600','Vary':'Origin',
    };
    if(origin&&allowed.has(origin))cors['Access-Control-Allow-Origin']=origin;
    const json=(status,data)=>new Response(JSON.stringify(data),{status,headers:{...cors,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    try {
      if(origin&&!allowed.has(origin))throw new HttpError(403,'내전 앱의 공유 링크로 다시 접속해 주세요.');
      if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
      const pathname=new URL(request.url).pathname;
      const marker='/lol-room/';const offset=pathname.indexOf(marker);
      const path=offset<0?'':pathname.slice(offset+marker.length);
      const auth=request.headers.get('Authorization')?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
      const token=auth?await digest(auth):null;
      const call=async(operation,args={})=>{
        const result=await rpc(operation,{...args,token});
        if(!result||!Number.isInteger(result.status)||!result.data)throw new Error('Invalid database response');
        if(result.status!==200)throw new HttpError(result.status,result.data.error,result.data);
        return result.data;
      };
      const write=['POST','PUT'].includes(request.method);
      let body={};
      if(write){
        if(!request.headers.get('Content-Type')?.startsWith('application/json')||request.headers.get('X-Requested-With')!=='Naejun')throw new HttpError(403,'내전 앱에서 다시 시도해 주세요.');
        const reader=request.body?.getReader(),chunks=[];let size=0;
        if(reader)for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>20*1024*1024){await reader.cancel();throw new HttpError(413,'자료가 20MB를 넘습니다. 먼저 백업을 내보낸 뒤 관리자에게 저장 한도를 확인해 주세요.');}chunks.push(value);}
        const bytes=new Uint8Array(size);let pos=0;for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.length;}
        try{body=JSON.parse(new TextDecoder().decode(bytes)||'{}');}catch{throw new HttpError(400,'입력 자료를 읽지 못했습니다. 앱에서 다시 시도해 주세요.');}
        if(!body||Array.isArray(body)||typeof body!=='object')throw new HttpError(400,'입력 자료를 확인해 주세요.');
      }
      if(path==='session'&&request.method==='GET')return json(200,await call('session'));
      if((path==='enter'||path==='admin/login')&&request.method==='POST'){
        const raw=makeToken();
        // The global database cap remains effective if a caller spoofs address headers.
        const address=(request.headers.get('x-forwarded-for')||'unknown').split(',')[0].trim();
        const data=await call('authenticate',{kind:path==='enter'?'member':'admin',username:body.username,password:path==='enter'?body.pin:body.password,newToken:await digest(raw),bucket:await digest(address)});
        return json(200,{...data,sessionToken:raw});
      }
      if(path==='logout'&&request.method==='POST')return json(200,await call('logout'));
      if(path==='state'&&request.method==='GET'){const data=await call('read');delete data.role;return json(200,{...data,ratingVersion:RATING_VERSION,tierSensitivity:TIER_SENSITIVITY,roleTierSensitivity:ROLE_TIER_SENSITIVITY});}
      if(path==='state'&&request.method==='PUT'){
        const current=await call('read');
        if(body.revision!==current.revision)throw new HttpError(409,'다른 기기에서 기록이 바뀌었습니다. 최신 기록을 확인해 주세요.',{state:current.state,revision:current.revision});
        const next=acceptChanges(current.state,clone(body.state),current.role);
        return json(200,await call('commit',{revision:body.revision,state:next,action:'save'}));
      }
      if(path==='records/edit'&&request.method==='POST'){
        const current=await call('read');
        const existing=current.state.recordEdits?.find(e=>e.id===body.editId);
        if(existing){if(existing.recordId!==body.recordId||!sameEditInput(existing.input,body.input))throw new HttpError(409,'이전 수정 요청과 입력이 다릅니다. 기록을 다시 열어 수정해 주세요.');return json(200,{state:current.state,revision:current.revision});}
        if(body.revision!==current.revision)throw new HttpError(409,'다른 기기에서 기록이 바뀌었습니다. 최신 기록을 확인한 뒤 다시 저장해 주세요.',{state:current.state,revision:current.revision});
        const next=editRecord(current.state,body,current.role);
        return json(200,await call('commit',{revision:body.revision,state:next,action:'save'}));
      }
      if(path.startsWith('admin/')&&request.method==='POST'){
        const current=await call('read');
        if(current.role!=='admin')throw new HttpError(403,'관리자 계정으로 로그인해 주세요.');
        const action=path.slice(6);
        if(['pin','password','entry'].includes(action))return json(200,await call('settings',{...body,action}));
        if(action==='import'){
          const next=validateDocument(clone(body.state));delete next.session;next.version=6;
          return json(200,await call('commit',{revision:body.revision,state:next,action:'import'}));
        }
        if(action==='reset'||action==='draft/cancel')return json(200,await call('commit',{revision:body.revision,action:action==='reset'?'reset':'cancel-draft'}));
      }
      throw new HttpError(404,'요청한 기능을 찾지 못했습니다. 앱을 새로 열어 주세요.');
    }catch(error){
      if(!error.status)console.error('lol-room request failed',{name:error.name,message:error.message});
      return json(error.status||500,{error:error.status?error.message:'서버가 요청을 처리하지 못했습니다. 입력을 확인하고 다시 시도해 주세요.',...(error.data||{})});
    }
  };
}
