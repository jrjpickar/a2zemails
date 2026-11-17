import {seed,projects,searchMail} from '../../src/model.mjs';
export default function sandbox(request){
 const headers={'cache-control':'no-store','x-content-type-options':'nosniff'};
 const reply=(data,status=200)=>Response.json(data,{status,headers});
 if(process.env.A2Z_MODE==='live')return reply({error:'Live API is disabled'},503);
 if(request.method!=='GET')return reply({error:'Method not allowed'},405);
 const q=new URL(request.url).searchParams.get('q')||'';
 if(q.length>512)return reply({error:'Query too long'},400);
 return reply({mode:'sandbox',mail:seed.filter(m=>searchMail(m,q)),projects});
}
