import {getStore} from '@netlify/blobs';
import {createHash} from 'node:crypto';

// Delivery status for mail sent from this app, built from delivery reports (DSNs) and bounces.
// Reports are saved per mailbox before success reports are filed away, so status survives refreshes.

const maxEntries = 1000;
const key = email => 'deliveries/'+createHash('sha256').update(String(email).toLowerCase()).digest('hex');
const rank = {failed:4,delayed:3,delivered:2,relayed:2,expanded:2};
const addresses = value => String(value||'').split(/[,;]/).map(item=>(item.match(/<([^>]+)>/)?.[1]||item).trim().toLowerCase()).filter(item=>item.includes('@'));

export function deliveryStore({storeFactory=()=>getStore({name:'deliveries',consistency:'strong'})}={}) {
 let store;
 const blobs = () => (store ||= storeFactory());
 return {
  async load(email) {
   try { return (await blobs().get(key(email),{type:'json'}))?.entries||{}; } catch { return {}; }
  },
  async merge(email,reports) {
   if (!reports?.length) return;
   const entries = await this.load(email);
   for (const report of reports) {
    const entry = entries[report.id] ||= {recipients:{},updatedAt:report.date};
    for (const recipient of report.recipients) {
     const address = recipient.address||'*';
     const previous = entry.recipients[address];
     // Keep the most recent report per recipient; a failure is never replaced by a delay.
     if (previous && (previous.at>report.date || (previous.action==='failed'&&recipient.action==='delayed'))) continue;
     entry.recipients[address] = {action:recipient.action,status:recipient.status,detail:recipient.detail,at:report.date};
    }
    if (report.date>entry.updatedAt) entry.updatedAt = report.date;
   }
   const kept = Object.entries(entries).sort(([,a],[,b])=>String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0,maxEntries);
   await blobs().setJSON(key(email),{entries:Object.fromEntries(kept)});
  },
 };
}

// sent: accepted by IONOS. delivered: every recipient confirmed. delayed / bounced / partly bounced from reports.
export function deliveryStatus(row,entry) {
 const recipients = [...new Set([...addresses(row.to),...addresses(row.cc),...addresses(row.bcc)])];
 const reports = entry?.recipients || {};
 const actions = recipients.map(address=>reports[address]?.action||null);
 const general = reports['*']?.action;
 const details = Object.entries(reports).map(([address,value])=>({address:address==='*'?'':address,...value}));
 const failed = actions.filter(action=>action==='failed').length || (general==='failed'?recipients.length:0);
 let status = 'sent';
 if (failed) status = failed>=recipients.length ? 'bounced' : 'partly bounced';
 else if (actions.some(action=>action==='delayed')) status = 'delayed';
 else if (recipients.length && actions.every(action=>action&&rank[action]===2)) status = 'delivered';
 else if (actions.some(action=>action&&rank[action]===2)) status = 'partly delivered';
 return {status,recipients:details,updatedAt:entry?.updatedAt||null};
}

export function sendIdFor(row) {
 return (String(row.headers?.messageId||'').match(/out-[0-9a-f-]{36}/i)?.[0]||'').toLowerCase();
}
