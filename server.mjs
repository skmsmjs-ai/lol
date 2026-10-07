import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, randomInt, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { HttpError, validateDocument, acceptChanges } from './room-rules.js';
import { editRecord, sameEditInput } from './record-edits.js';
const stretch=promisify(scrypt),root=dirname(fileURLToPath(import.meta.url));
const hashToken=value=>createHash('sha256').update(value).digest('hex');
const copy=value=>JSON.parse(JSON.stringify(value));
const clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
async function passwordHash(value) {const salt=randomBytes(16).toString('hex'),key=await stretch(value,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});return `${salt}:${key.toString('hex')}`;}
async function verify(value,stored) {if(typeof value!=='string'||value.length>256)return false;const [salt,hex]=stored.split(':');const key=await stretch(value,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});const other=Buffer.from(hex,'hex');return other.length===key.length&&timingSafeEqual(other,key);}
export async function createApp(options={}){
  const dataDir=resolve(options.dataDir||process.env.DATA_DIR||join(root,'.runtime'));mkdirSync(dataDir,{recursive:true,mode:0o700});chmodSync(dataDir,0o700);
  const dbPath=join(dataDir,'room.sqlite'),db=new DatabaseSync(dbPath,{timeout:5000});chmodSync(dbPath,0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS document(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,role TEXT NOT NULL,epoch INTEGER NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS failures(key TEXT PRIMARY KEY,count INTEGER NOT NULL,until INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS archives(id INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT NOT NULL,reason TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT NOT NULL,role TEXT NOT NULL,action TEXT NOT NULL,revision INTEGER);`);
  const get=key=>db.prepare('SELECT value FROM config WHERE key=?').get(key)?.value;
  const set=(key,value)=>db.prepare('INSERT INTO config VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value));
  if(!get('admin_hash')){
    const pin=options.pin||process.env.ENTRY_PIN||String(randomInt(0,10000)).padStart(4,'0');
    const password=options.password||process.env.ADMIN_PASSWORD||randomBytes(18).toString('base64url');
    const username=options.username||process.env.ADMIN_USERNAME||'minseok';
    if(!/^\d{4}$/.test(pin)||password.length<11)throw new Error('초기 PIN은 숫자 4자리, 관리자 비밀번호는 11자 이상이어야 합니다.');
    set('admin_username',username);set('admin_hash',await passwordHash(password));set('pin_hash',await passwordHash(pin));set('entry_enabled',1);set('member_epoch',0);set('admin_epoch',0);
    if(!options.password&&!process.env.ADMIN_PASSWORD)writeFileSync(join(dataDir,'account.txt'),`관리자 계정: ${username}\n관리자 비밀번호: ${password}\n참가자 입장 비밀번호: ${pin}\n\n첫 관리자 로그인 뒤 비밀번호를 변경하세요. 이 파일을 공유하지 마세요.\n`,{mode:0o600});
  }
  if(!db.prepare('SELECT id FROM document WHERE id=1').get()){
    const seed=options.initialState||JSON.parse(readFileSync(join(root,'initial-state.json'),'utf8'));
    const initial=validateDocument(copy(seed));delete initial.session;db.prepare('INSERT INTO document VALUES(1,0,?)').run(JSON.stringify(initial));
  }
  const readState=()=>{const row=db.prepare('SELECT revision,body FROM document WHERE id=1').get();return {revision:row.revision,state:JSON.parse(row.body)};};
  const secure=options.secure??process.env.NODE_ENV==='production';
  const publicOrigin=options.origin||process.env.PUBLIC_ORIGIN;
  if(secure&&!publicOrigin?.startsWith('https://'))throw new Error('운영 서버는 HTTPS PUBLIC_ORIGIN이 필요합니다.');
  function cookie(res,token,age=7*24*3600){res.setHeader('Set-Cookie',`naejun_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure?'; Secure':''}`);}
  function session(req){const raw=req.headers.cookie?.match(/(?:^|;\s*)naejun_session=([^;]+)/)?.[1];if(!raw)return null;const s=db.prepare('SELECT * FROM sessions WHERE token=?').get(hashToken(raw));if(!s||s.expires<Date.now()||s.epoch!==Number(get(`${s.role==='admin'?'admin':'member'}_epoch`)))return null;return s;}
  function requireSession(req,admin=false){const s=session(req);if(!s)throw new HttpError(401,'입장이 만료되었습니다. 다시 입장해 주세요.');if(admin&&s.role!=='admin')throw new HttpError(403,'관리자 계정으로 로그인해 주세요.');return s;}
  function issue(res,role){db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());const token=randomBytes(32).toString('base64url');db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hashToken(token),role,Number(get(`${role==='admin'?'admin':'member'}_epoch`)),Date.now()+7*24*3600*1000);cookie(res,token);}
  async function body(req){let chunks=[],size=0;for await(const chunk of req){size+=chunk.length;if(size>20*1024*1024)throw new HttpError(413,'자료가 20MB를 넘습니다. 원본을 백업하고 서버 저장 한도를 조정해 주세요.');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw new HttpError(400,'입력 자료를 읽지 못했습니다.');}}
  function throttle(req,name){const key=`${name}:${req.socket.remoteAddress}`;const row=db.prepare('SELECT * FROM failures WHERE key=?').get(key);if(row&&row.until>Date.now()&&row.count>=5)throw new HttpError(429,'입장 시도가 반복되었습니다. 1분 뒤 다시 시도해 주세요.');failure(key);return key;}
  function failure(key){const old=db.prepare('SELECT * FROM failures WHERE key=?').get(key);db.prepare('INSERT INTO failures VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,until=excluded.until').run(key,old&&old.until>Date.now()?old.count+1:1,Date.now()+60000);}
  function commit(state,revision,role,reason){db.exec('BEGIN IMMEDIATE');try{const current=readState();if(current.revision!==revision)throw new HttpError(409,'다른 사람이 자료를 수정했습니다.',current);const next=revision+1;if(reason==='import'||reason==='reset')db.prepare('INSERT INTO archives(time,reason,body) VALUES(?,?,?)').run(new Date().toISOString(),reason,JSON.stringify(current.state));db.prepare('UPDATE document SET body=?,revision=? WHERE id=1').run(JSON.stringify(state),next);db.prepare('INSERT INTO audit(time,role,action,revision) VALUES(?,?,?,?)').run(new Date().toISOString(),role,reason,next);db.exec('COMMIT');return {state,revision:next};}catch(error){db.exec('ROLLBACK');throw error;}}
  const staticFiles=new Map(['legacy-role-model.js','evidence-role-model-v7.js','match-math.js','index.html','app.js','role-model.js','room-rules.js','record-edits.js','shared-store.js','entry-input.js','cloud-config.js','styles.css','matcher-worker.js','manifest.webmanifest','service-worker.js','icon-192.png','icon-512.png','icon-entry-180.png','icon-entry-192.png','icon-entry-512.png','icon-source.svg'].map(x=>['/'+x,join(root,x)]));
  const types={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',webmanifest:'application/manifest+json',png:'image/png'};
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' https://*.supabase.co; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    try{
      let path=new URL(req.url,'http://localhost').pathname;if(path.startsWith('/lol/'))path=path.slice(4);
      if(path==='/cloud-config.js'&&options.cloudEndpoint!==undefined){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'});res.end(`export const cloudEndpoint=${JSON.stringify(options.cloudEndpoint)};`);return;}
      if(path.startsWith('/api/')){
        res.setHeader('Cache-Control','no-store');
        if(!['GET','HEAD'].includes(req.method)){
          const origin=req.headers.origin,expected=publicOrigin||`http://${req.headers.host}`;
          if(req.headers['x-requested-with']!=='Naejun'||(origin&&origin!==expected)||!req.headers['content-type']?.startsWith('application/json'))throw new HttpError(403,'같은 내전 화면에서 요청해 주세요.');
        }
        if(path==='/api/session'&&req.method==='GET'){const s=session(req);return json(200,{authenticated:!!s,role:s?.role||null,entryEnabled:get('entry_enabled')==='1'});}
        if(path==='/api/enter'&&req.method==='POST'){
          const key=throttle(req,'entry'),b=await body(req);if(get('entry_enabled')!=='1')throw new HttpError(403,'참가자 입장을 잠시 중단했습니다. 관리자에게 확인해 주세요.');
          if(!/^\d{4}$/.test(b.pin||'')||!await verify(b.pin,get('pin_hash'))){throw new HttpError(401,'입장 비밀번호를 확인해 주세요.');}db.prepare('DELETE FROM failures WHERE key=?').run(key);issue(res,'member');return json(200,{ok:true});
        }
        if(path==='/api/admin/login'&&req.method==='POST'){
          const key=throttle(req,'admin'),b=await body(req),correct=await verify(b.password||'',get('admin_hash'));
          if(b.username!==get('admin_username')||!correct){throw new HttpError(401,'관리자 계정과 비밀번호를 확인해 주세요.');}db.prepare('DELETE FROM failures WHERE key=?').run(key);issue(res,'admin');return json(200,{ok:true});
        }
        if(path==='/api/logout'&&req.method==='POST'){const s=requireSession(req);db.prepare('DELETE FROM sessions WHERE token=?').run(s.token);cookie(res,'',0);return json(200,{ok:true});}
        if(path==='/api/state'&&req.method==='GET'){requireSession(req);return json(200,readState());}
        if(path==='/api/state'&&req.method==='PUT'){
          const s=requireSession(req),b=await body(req),old=readState();if(b.revision!==old.revision)throw new HttpError(409,'다른 사람이 자료를 수정했습니다.',old);
          const next=acceptChanges(old.state,copy(b.state),s.role);return json(200,commit(next,b.revision,s.role,'save'));
        }
        if(path==='/api/records/edit'&&req.method==='POST'){
          const s=requireSession(req),b=await body(req),old=readState();
          const existing=old.state.recordEdits?.find(e=>e.id===b.editId);
          if(existing){if(existing.recordId!==b.recordId||!sameEditInput(existing.input,b.input))throw new HttpError(409,'같은 수정 요청의 입력이 달라졌습니다. 기록을 다시 열어 주세요.');return json(200,old);}
          if(b.revision!==old.revision)throw new HttpError(409,'다른 사람이 자료를 수정했습니다. 수정 초안은 보존했습니다.',old);
          return json(200,commit(editRecord(old.state,b,s.role),b.revision,s.role,'edit-record'));
        }
        if(path.startsWith('/api/admin/')){
          const s=requireSession(req,true),b=await body(req);
          if(path==='/api/admin/pin'&&req.method==='POST'){if(!/^\d{4}$/.test(b.pin||''))throw new HttpError(422,'입장 비밀번호는 숫자 4자리입니다.');set('pin_hash',await passwordHash(b.pin));set('member_epoch',Number(get('member_epoch'))+1);return json(200,{ok:true});}
          if(path==='/api/admin/password'&&req.method==='POST'){if(!await verify(b.current||'',get('admin_hash')))throw new HttpError(403,'현재 관리자 비밀번호를 확인해 주세요.');if(typeof b.password!=='string'||b.password.length<11||b.password.length>256)throw new HttpError(422,'관리자 비밀번호는 11자 이상 256자 이하입니다.');if(b.username!==undefined&&(typeof b.username!=='string'||!/^[A-Za-z0-9_.-]{3,40}$/.test(b.username)))throw new HttpError(422,'관리자 아이디는 영문, 숫자, 점, 밑줄, 하이픈으로 3~40자 입력해 주세요.');const hash=await passwordHash(b.password);db.exec('BEGIN IMMEDIATE');try{if(b.username!==undefined)set('admin_username',b.username);set('admin_hash',hash);set('admin_epoch',Number(get('admin_epoch'))+1);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}issue(res,'admin');return json(200,{ok:true});}
          if(path==='/api/admin/entry'&&req.method==='POST'){if(typeof b.enabled!=='boolean')throw new HttpError(422,'입장 설정을 확인해 주세요.');set('entry_enabled',b.enabled?1:0);if(!b.enabled)set('member_epoch',Number(get('member_epoch'))+1);return json(200,{enabled:b.enabled});}
          if(path==='/api/admin/import'&&req.method==='POST'){const old=readState(),incoming=validateDocument(copy(b.state));if(old.state.history.length&&!same(old.state.history,incoming.history))throw new HttpError(409,'서버에 이미 다른 경기 기록이 있습니다. 기존 자료를 덮어쓰지 않았습니다.',old);delete incoming.session;incoming.version=6;return json(200,commit(incoming,b.revision,s.role,'import'));}
          if(path==='/api/admin/draft/cancel'&&req.method==='POST'){const old=readState();if(b.revision!==old.revision)throw new HttpError(409,'다른 사람이 자료를 수정했습니다.',old);if(old.state.activeDraft)db.prepare('INSERT INTO archives(time,reason,body) VALUES(?,?,?)').run(new Date().toISOString(),'cancel-draft',JSON.stringify(old.state.activeDraft));old.state.activeDraft=null;return json(200,commit(old.state,b.revision,s.role,'cancel-draft'));}
          if(path==='/api/admin/reset'&&req.method==='POST'){const initial=JSON.parse(readFileSync(join(root,'initial-state.json'),'utf8'));delete initial.session;return json(200,commit(initial,b.revision,s.role,'reset'));}
        }
        throw new HttpError(404,'요청한 기능을 찾지 못했습니다.');
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw new HttpError(405,'허용되지 않는 요청입니다.');
      const file=staticFiles.get(path==='/'?'/index.html':path);if(!file)throw new HttpError(404,'파일을 찾지 못했습니다.');
      res.writeHead(200,{'Content-Type':types[file.split('.').at(-1)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:readFileSync(file));
    }catch(error){if(!(error instanceof HttpError))console.error('Request failed:',error.name);json(error.status||500,{error:error.status?error.message:'서버에서 저장하지 못했습니다. 입력을 보존하고 다시 시도해 주세요.',...error.data});}
  });
  return {server,db,close:()=>new Promise(resolve=>server.close(()=>{db.close();resolve();}))};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createApp();const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||5397);
  app.server.listen(port,host,()=>console.log(`내전 매칭기 http://${host}:${port} · 관리자 정보는 DATA_DIR/account.txt에 보관했습니다.`));
}
