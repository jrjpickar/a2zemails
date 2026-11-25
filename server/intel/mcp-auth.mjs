import {createHash,timingSafeEqual} from 'node:crypto';
import {teamDirectory} from '../team-directory.mjs';

// Server-to-server auth for the email MCP server and metrics endpoint.
// MCP_API_KEY: read access. MCP_WRITE_API_KEY: write tools, only when MCP_READ_ONLY=false.
const digest = value => createHash('sha256').update(String(value)).digest();
const same = (a,b) => timingSafeEqual(digest(a),digest(b));

export function mcpAccess(env,request) {
 const supplied = /^Bearer (\S{16,512})$/i.exec(request.headers.get('authorization')||'')?.[1]||'';
 const read = env.MCP_API_KEY?.trim(), write = env.MCP_WRITE_API_KEY?.trim();
 if (!read||read.length<32) return {status:503,error:'MCP_API_KEY is not configured (32 or more characters).'};
 const readOnly = env.MCP_READ_ONLY?.trim().toLowerCase()!=='false';
 // Compare against both keys every time so timing does not reveal which one matched.
 const isWrite = Boolean(write&&write.length>=32)&&same(supplied,write);
 const isRead = same(supplied,read);
 if (!isRead&&!isWrite) return {status:401,error:'Unauthorized'};
 return {status:0,canWrite:isWrite&&!readOnly,readOnly};
}

// The mailbox the MCP server reads: MCP_IONOS_EMAIL with MCP_IONOS_PASSWORD, the HighLevel mapping, or a password saved in Team access.
export async function mcpMailbox(env,{directoryFactory=teamDirectory}={}) {
 const email = env.MCP_IONOS_EMAIL?.trim().toLowerCase();
 if (!email) return null;
 let password = env.MCP_IONOS_PASSWORD;
 if (!password) {
  try { password = Object.entries(JSON.parse(env.GHL_IONOS_MAILBOX_PASSWORDS||'{}')).find(([key])=>key.trim().toLowerCase()===email)?.[1]; } catch {}
 }
 if (!password) password = await directoryFactory(env).credential(email).catch(()=>null);
 return typeof password==='string'&&password?{email,password}:null;
}
