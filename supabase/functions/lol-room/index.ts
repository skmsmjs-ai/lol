import { createHandler } from './handler.js';

const url=Deno.env.get('SUPABASE_URL');
const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if(!url||!serviceKey)throw new Error('Missing server-only Supabase environment');
const allowedOrigins=(Deno.env.get('LOL_ALLOWED_ORIGINS')||'https://skmsmjs-ai.github.io,http://127.0.0.1:5397').split(',').map(s=>s.trim()).filter(Boolean);
const rpc=async(operation:string,args:unknown)=>{
  const response=await fetch(`${url}/rest/v1/rpc/lol_gateway`,{
    method:'POST',headers:{'Content-Type':'application/json','apikey':serviceKey,'Authorization':`Bearer ${serviceKey}`},
    body:JSON.stringify({operation,args}),signal:AbortSignal.timeout(operation==='commit'?35000:12000),
  });
  if(!response.ok){
    try{
      const problem=await response.json();
      console.error('lol-room database request failed',{status:response.status,code:problem.code,message:typeof problem.message==='string'?problem.message.slice(0,240):undefined});
    }catch{}
    throw new Error(`Database request failed: ${response.status}`);
  }
  return await response.json();
};
Deno.serve(createHandler({rpc,allowedOrigins}));
