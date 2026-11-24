export const projects = [
 {id:'P-241', name:'Harbor Point Redevelopment', gc:'Summit Builders', aliases:['Harbor Point','1400 Harbor Blvd','EST-241']},
 {id:'P-252', name:'Westfield Medical Plaza', gc:'Pacific Coast GC', aliases:['Westfield','875 Westfield Ave','EST-252']},
 {id:'P-263', name:'Riverside Warehouse', gc:'Atlas Construction', aliases:['Riverside','520 River Road','EST-263']},
 {id:'P-275', name:'Civic Center Annex', gc:'Meridian Group', aliases:['Civic Center','310 Main Street','EST-275']}
];
export const categories = ['Bid Invitations','Estimating','RFIs & Change Orders','Dispatch','Invoices','General'];
export function currentMessageText(body) {
 return body.split(/^\s*(?:-{2,}\s*(?:original|forwarded) message\s*-*|begin forwarded message:|on .+ wrote:|from:[^\n]+\n(?:\s*\n)?\s*(?:sent|date):)/im,1)[0]
  .replace(/^\s*>.*$/gm,'');
}
// Bid boards that send invitations. A message from one, or with one in its current text, is a bid invite
// unless the subject says it is a reply, RFI, addendum, award or account notice.
const bidPlatforms=/\b(planhub|buildingconnected|bidmail|smartbid(?:net)?|isqft|constructconnect|pipelinesuite|bidclerk|bidnet|bluebeam studio)\b/;
const notAnInvite=/^\s*(re|fw|fwd)\s*:|\b(rfi|addend(?:um|a)|award(?:ed)?|password|verify|subscription|newsletter|webinar|receipt|invoice)\b/;
// Senior admin sorting keywords: [{term, category, field:'subject'|'any'}]. They run before the built-in rules.
const escapeTerm=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function keywordCategory(subject, body='', keywords=[]) {
 if(!Array.isArray(keywords)||!keywords.length) return '';
 const s=String(subject||'').toLowerCase();
 let current;
 for(const keyword of [...keywords].sort((a,b)=>b.term.length-a.term.length)){
  if(!keyword?.term||!categories.includes(keyword.category)) continue;
  const pattern=new RegExp('(?:^|[^a-z0-9])'+escapeTerm(keyword.term.toLowerCase())+'(?:$|[^a-z0-9])');
  if(pattern.test(s)) return keyword.category;
  if(keyword.field==='any'){
   current??=currentMessageText(String(body||'')).toLowerCase().slice(0,20000);
   if(pattern.test(current)) return keyword.category;
  }
 }
 return '';
}
export function classify(subject, body='', sender='', rules={}, keywords=[]) {
 const domain=sender.toLowerCase().split('@')[1];
 if(domain && Object.hasOwn(rules,domain) && categories.includes(rules[domain])) return rules[domain];
 const custom=keywordCategory(subject,body,keywords);
 if(custom) return custom;
 const current=currentMessageText(body).toLowerCase();
 if((bidPlatforms.test(domain||'')||bidPlatforms.test(current.slice(0,4000)))&&!notAnInvite.test(subject.toLowerCase())) return categories[0];
 for(const content of [subject,currentMessageText(body)]){
 const s=content.toLowerCase();
 if(/\b(itb|rfp|bid invit(?:e|es|ation|ations)|invitation to (?:bid|tender)|request for (?:bids?|proposals?|pricing|quotes?)|intent to bid|out to bid|bids? (?:are )?due|bid date|invit(?:e|es|ed|ing)\b[^.!?\n]{0,50}\bto (?:submit (?:a |your )?)?bid)\b/.test(s)) return categories[0];
 if(/\b(rfi|request for information|change order|co[- #]?\d+)\b/.test(s)) return categories[2];
 if(/\b((?:demo(?:lition)?|revised|updated) bids?|bid (?:revision|scope|clarification|submission))\b/.test(s)) return categories[1];
 if(/\b(invoice|payment|purchase order|po[- #]?\d+|receipt)\b/.test(s)) return categories[4];
 if(/\b(dispatch|schedule update|notice to proceed|ntp|crew)\b/.test(s)) return categories[3];
 if(/\b(addend(?:um|a)|estimates?|proposals?)\b/.test(s)) return categories[1];
 }
 return 'General';
}
export function matchProject(content) {
 const s=content.toLowerCase();
 const found=projects.filter(p=>[p.id,p.name,...p.aliases].some(a=>s.includes(a.toLowerCase())));
 return found.length===1 ? found[0].id : '';
}
const rows=[
 ['Marcus Reynolds','Summit Builders','ITB: Harbor Point Redevelopment','2026-11-17T09:42:00','Hi A2Z team,\n\nWe’re inviting you to bid on the selective demolition package for Harbor Point Redevelopment. Please review the attached bid documents and let us know if you plan to submit.\n\nScope includes interior strip-out on levels 1–3, removal of existing MEP systems, and site clearing along the east elevation. A site walk is scheduled for November 19 at 8:00 AM.\n\nPlease send any scope questions by November 23. Looking forward to working with you.\n\nBest,\nMarcus Reynolds\nPreconstruction Manager | Summit Builders',['Demo Plan Set.pdf','Bid Instructions.pdf'],'2026-11-30'],
 ['Nina Patel','Pacific Coast GC','RFI #018 — Westfield structural demo limits','2026-11-17T09:18:00','Please confirm the slab opening limits at grid C. The marked sketch shows the area in question.',['RFI 018 Sketch.pdf']],
 ['Jake Morrison','Atlas Construction','Schedule update: Riverside crew for Thursday','2026-11-17T08:56:00','Please confirm six crew members for the Thursday morning shift. Check in with the site superintendent at 6:30 AM.',[]],
 ['Elena Torres','Meridian Group','Addendum 02 — Civic Center Annex','2026-11-17T08:31:00','Revised drawings are attached. Please acknowledge Addendum 02 with your proposal.',['Addendum 02.pdf']],
 ['Accounts Payable','Pacific Coast GC','Payment confirmation — Westfield INV-1042','2026-11-16T15:20:00','Payment has been issued for invoice INV-1042. Remittance details are attached.',['Remittance.pdf']],
 ['Cole Bennett','Summit Builders','Harbor Point — revised proposal worksheet','2026-11-16T13:02:00','Please use the revised worksheet for your alternate pricing.',['Pricing Worksheet.pdf']],
 ['Alex Kim','Meridian Group','ITB: Civic Center Annex selective demolition','2026-11-16T10:05:00','Please review the scope and confirm your intent to bid.',['Selective Demo Scope.pdf'],'2026-12-03'],
 ['Ashley Ford','Atlas Construction','Change Order #007 — Riverside haul-off','2026-11-16T08:09:00','Can you provide a breakdown for the additional haul-off quantities?',['CO 007.pdf']],
 ['Jordan Lee','Field Operations','Gate access for the week','2026-11-13T14:20:00','Please use the south gate while the main driveway is being resurfaced.',[]],
 ['Caleb Reed','Summit Builders','Purchase Order PO-479 — Harbor Point','2026-11-13T12:45:00','Attached is the purchase order for the preliminary site work.',['PO 479.pdf']]
];
export const seed=rows.map(([name,company,subject,date,body,files,due],i)=>({id:'mail-'+i,thread:'thread-'+i,name,company,subject,date,body,files,due,from:name.toLowerCase().replaceAll(' ','.')+'@'+company.toLowerCase().replace(/[^a-z]/g,'')+'.example',to:'operations@a2z.example',cc:'',category:classify(subject,body),project:matchProject(subject+' '+body),folder:'Inbox',unread:i<5 || i===6,star:i===0 || i===4,headers:{messageId:'<demo-'+i+'@a2z.example>',references:[]}}));
export function searchMail(row, q) {
 const values={from:row.from+' '+row.name,to:row.to+' '+(row.cc||''),subject:row.subject,project:projects.find(p=>p.id===row.project)?.name||'',date:row.date,attachment:row.files.join(' ')};
 const all=[...Object.values(values),row.body,row.company,row.category,row.project].join(' ').toLowerCase();
 return (q.match(/(?:[^\s"]+|"[^"]*")+/g)||[]).every(term=>{
  const m=term.match(/^(from|to|subject|project|date|attachment):(.*)$/i);
  return (m?values[m[1].toLowerCase()].toLowerCase():all).includes((m?m[2]:term).replaceAll('"','').toLowerCase());
 });
}
export function initialState(){return {mail:seed,rules:{},drafts:[]}}
export function threadFor(mail,row){return mail.filter(m=>m.thread===row.thread && m.folder!=='Trash').sort((a,b)=>a.date.localeCompare(b.date))}
export function rowActions(row,patch){return {...row,...patch,...(patch.folder?{previousFolder:row.folder}: {})}}

export function appendSignature(body, signature) {
 const text = signature?.trim();
 return text ? body.trimEnd() + '\n\n-- \n' + text : body;
}

export function dashboardQueues(mail) {
 const incoming = mail.filter(message => message.folder === 'Inbox');
 const latestReplies = new Map();
 for (const message of mail) {
  if (message.folder === 'Sent' && message.headers?.references.length &&
      message.date > (latestReplies.get(message.thread) || '')) {
   latestReplies.set(message.thread,message.date);
  }
 }
 const newestFirst = (a, b) => b.date.localeCompare(a.date);
 return {
  bids: incoming.filter(message => message.category === 'Bid Invitations').sort((a, b) =>
   (a.due || '9999').localeCompare(b.due || '9999') || newestFirst(a, b)),
  urgent: incoming.filter(message => message.unread && (
   message.category === 'RFIs & Change Orders' ||
   /\b(urgent|asap|time.sensitive|notice to proceed|ntp)\b/i.test(message.subject)
  )).sort(newestFirst),
  unanswered: incoming.filter(message => message.date > (latestReplies.get(message.thread) || '') && (
   ['Bid Invitations','RFIs & Change Orders','Dispatch'].includes(message.category) || /\?/.test(message.body)
  )).sort(newestFirst),
  invoices: incoming.filter(message => message.category === 'Invoices' && message.unread).sort(newestFirst),
 };
}

export function commandCenterStats(mail) {
 const queues=dashboardQueues(mail);
 return {
  unreadIncoming:mail.filter(message=>message.folder==='Inbox'&&message.unread).length,
  bidInvitations:queues.bids.length,
  urgentUnread:queues.urgent.length,
  awaitingReply:queues.unanswered.length,
  unreadInvoiceMail:queues.invoices.length,
 };
}
