// Operational intelligence over the mailbox index. Pure, deterministic code: searching, filtering,
// counting, dates and aggregation never use AI. Every item carries a source reference to its email.

const zone = 'America/Los_Angeles';
const pacificDay = new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});
export const dayOf = value => value ? pacificDay.format(new Date(value)) : '';
const shift = (day,days) => new Date(Date.parse(day+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
const isDay = value => typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'));
const weekdayOf = day => new Date(day+'T12:00:00Z').getUTCDay();
const lower = value => String(value||'').toLowerCase();
const addresses = value => String(value||'').split(/[,;]/).map(item=>(item.match(/<([^>]+)>/)?.[1]||item).trim().toLowerCase()).filter(item=>item.includes('@'));
const domainOf = address => lower(address).split('@')[1]||'';
const sent = row => row.folder==='Sent';
const has = (row,flag) => (row.flags||[]).includes(flag);
const normalizeSubject = value => lower(value).replace(/^(?:\s*(?:re|fw|fwd|aw|wg)\s*:\s*)+/g,'').replace(/\s+/g,' ').trim();

// Date ranges in Pacific time. Ask AI parses words like "yesterday" in code, not with the model.
export function rangeFromText(text,today=dayOf(Date.now())) {
 const value = lower(text);
 const monday = shift(today,-((weekdayOf(today)+6)%7));
 const month = today.slice(0,7);
 const lastMonthStart = shift(month+'-01',-1).slice(0,7)+'-01';
 let match;
 if (/\btoday\b|\bthis morning\b/.test(value)) return {from:today,to:today,label:'today'};
 if (/\byesterday\b/.test(value)) return {from:shift(today,-1),to:shift(today,-1),label:'yesterday'};
 if (/\bthis week\b/.test(value)) return {from:monday,to:shift(monday,6),label:'this week'};
 if (/\bnext week\b/.test(value)) return {from:shift(monday,7),to:shift(monday,13),label:'next week'};
 if (/\blast week\b/.test(value)) return {from:shift(monday,-7),to:shift(monday,-1),label:'last week'};
 if (/\bthis month\b/.test(value)) return {from:month+'-01',to:today,label:'this month'};
 if (/\blast month\b/.test(value)) return {from:lastMonthStart,to:shift(month+'-01',-1),label:'last month'};
 if ((match=value.match(/\b(?:last|past) (\d{1,3}) (day|week|month)s?\b/))) {
  const days = Number(match[1])*({day:1,week:7,month:30}[match[2]]);
  return {from:shift(today,-(days-1)),to:today,label:'last '+match[1]+' '+match[2]+'s'};
 }
 if ((match=value.match(/\bsince (\d{4}-\d{2}-\d{2})\b/))&&isDay(match[1])) return {from:match[1],to:today,label:'since '+match[1]};
 return null;
}

export function resolveRange(args={},fallbackDays=30,today=dayOf(Date.now())) {
 const from = isDay(args.dateFrom) ? args.dateFrom : shift(today,-(fallbackDays-1));
 const to = isDay(args.dateTo) ? args.dateTo : today;
 if (from>to) throw new TypeError('dateFrom must be on or before dateTo.');
 return {from,to};
}
const inRange = (row,range) => {const day = dayOf(row.date);return day>=range.from&&day<=range.to;};

// Deadline extraction: "Bids due 12/4", "BIDS DUE 12-10-2025", "proposal due December 4th at 2 PM", ISO dates.
const months = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12};
export function extractDeadline(row) {
 const text = (row.subject||'')+'\n'+(row.preview||'');
 const cue = /\b(?:bids? (?:are )?due|bid (?:date|deadline)|due (?:date|on|by)|proposals? (?:are )?due|pricing (?:is )?due|submit(?:tal)? by|deadline|due)\b[^\n]{0,40}?/ig;
 const received = row.date ? new Date(row.date) : new Date();
 let match;
 while ((match=cue.exec(text))) {
  const tail = text.slice(match.index,match.index+90);
  const date = parseDate(tail,received);
  if (date) return date;
 }
 return null;
}
function parseDate(text,received) {
 let match, year, month, day;
 if ((match=text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/))) [year,month,day] = [Number(match[1]),Number(match[2]),Number(match[3])];
 else if ((match=text.match(/\b(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\b/))) {
  [month,day] = [Number(match[1]),Number(match[2])];
  year = match[3] ? Number(match[3].length===2?'20'+match[3]:match[3]) : null;
 } else if ((match=text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?/i))) {
  [month,day,year] = [months[match[1].toLowerCase()],Number(match[2]),match[3]?Number(match[3]):null];
 } else return null;
 if (!month||month>12||!day||day>31) return null;
 const base = Number(dayOf(received).slice(0,4));
 if (!year) {
  year = base;
  const candidate = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  if (candidate<shift(dayOf(received),-30)) year += 1;
 }
 const value = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
 return isDay(value)&&new Date(value+'T12:00:00Z').getUTCDate()===day ? value : null;
}

// Source reference for citations: stable ID, folder, subject, sender, date and a short excerpt.
export function sourceOf(row,excerpt) {
 return {id:row.id,folder:row.folder,subject:row.subject,from:row.from,fromName:row.fromName||'',to:row.to,date:row.date,
  excerpt:String(excerpt??row.preview??'').slice(0,280),attachments:(row.attachments||[]).map(file=>file.name).slice(0,5)};
}

// Threads: Message-ID, In-Reply-To and References first, then normalized subject within 90 days.
export function buildThreads(rows) {
 const parent = new Map();
 const find = key => {while (parent.get(key)!==key) {parent.set(key,parent.get(parent.get(key)));key = parent.get(key);}return key;};
 const join = (a,b) => {
  for (const key of [a,b]) if (!parent.has(key)) parent.set(key,key);
  const ra = find(a), rb = find(b);
  if (ra!==rb) parent.set(ra,rb);
 };
 for (const row of rows) {
  const self = row.messageId||row.id;
  join(self,self);
  for (const other of [row.inReplyTo,...(row.refs||[])]) if (other) join(self,other);
 }
 const bySubject = new Map();
 for (const row of [...rows].sort((a,b)=>String(a.date).localeCompare(String(b.date)))) {
  const subject = normalizeSubject(row.subject);
  if (subject.length<6) continue;
  const prior = bySubject.get(subject);
  if (prior&&Date.parse(row.date)-Date.parse(prior.date)<90*86400000) join(row.messageId||row.id,prior.messageId||prior.id);
  bySubject.set(subject,row);
 }
 const threads = new Map();
 for (const row of rows) {
  const key = find(row.messageId||row.id);
  if (!threads.has(key)) threads.set(key,[]);
  threads.get(key).push(row);
 }
 const threadOf = new Map();
 for (const list of threads.values()) {
  list.sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  for (const row of list) threadOf.set(row.id,list);
 }
 return threadOf;
}

export function createIntel(rows,{ownEmail='',today=dayOf(Date.now()),gcThreshold=2}={}) {
 const ownDomain = domainOf(ownEmail);
 const external = address => {const domain = domainOf(address);return Boolean(domain)&&domain!==ownDomain;};
 const threads = buildThreads(rows);
 const byId = new Map(rows.map(row=>[row.id,row]));
 const sentRows = rows.filter(sent);
 const inbound = rows.filter(row=>!sent(row)&&external(addresses(row.from)[0]));

 const repliedTo = row => {
  if (has(row,'\\Answered')) return true;
  const thread = threads.get(row.id)||[];
  const sender = addresses(row.from)[0];
  return thread.some(other=>sent(other)&&other.date>row.date)||
   sentRows.some(other=>other.date>row.date&&(other.inReplyTo===row.messageId||(other.refs||[]).includes(row.messageId)||
    (addresses(other.to+','+other.cc).includes(sender)&&normalizeSubject(other.subject)===normalizeSubject(row.subject))));
 };
 const actionable = row => ['Bid Invitations','Estimating','RFIs & Change Orders','Dispatch','Invoices'].includes(row.category)||
  /\?|\b(?:please|can you|could you|let me know|confirm|need(?:ed)?|request|asap|urgent|by (?:monday|tuesday|wednesday|thursday|friday|eod|end of day|tomorrow))\b/i.test(row.preview||'');

 const riskPatterns = [
  ['complaint',/\b(?:complain\w*|unacceptable|disappointed|not happy|poor (?:work|quality)|frustrat\w*)\b/i],
  ['dispute',/\b(?:dispute\w*|disagree\w*|back ?charge\w*|withhold\w*|lien\w*|claim\b|legal|attorney)\b/i],
  ['delay',/\b(?:delay\w*|behind schedule|push(?:ed)? back|postpon\w*|resched\w*|late\b|on hold)\b/i],
  ['payment issue',/\b(?:past due|overdue|unpaid|not (?:been )?paid|late payment|short ?paid|bounced check|collections?)\b/i],
  ['safety',/\b(?:injur\w*|accident|incident|osha|unsafe|safety violation)\b/i],
  ['damage',/\b(?:damag\w*|broke\w*|crack\w*|leak\w*)\b/i],
 ];
 const risksOf = row => riskPatterns.filter(([,pattern])=>pattern.test(row.subject+' '+row.preview)).map(([name])=>name);
 const amount = /\$\s?\d[\d,]*(?:\.\d{2})?(?:\s?(?:k|K|M))?/g;
 const sentences = text => String(text||'').split(/(?<=[.!?])\s+|\n+/).map(item=>item.trim()).filter(Boolean);
 const paymentLine = /\b(?:pay(?:ment|ing|s)?|paid|check|wire|ach|remit\w*|invoice\w*|net ?\d{2}|deposit|retention|retainage|balance due|amount due)\b/i;
 const commitmentLine = /\b(?:will (?:be )?(?:pay|paid|send|sent|issue|release|process|mail|wire)|(?:is|are) scheduled|expect(?:ed)? (?:to|by|on)|by (?:end of|eod|friday|monday|next week|the \d+)|on or before|will go out|going out)\b/i;
 const promiseLine = /\b(?:we(?:'ll| will)|i(?:'ll| will)|we can have|we are going to|our crew will|expect to have)\b[^.!?]{3,}/i;
 const proposalLine = /\b(?:proposal|quote|pricing|bid|estimate|number[s]?)\b/i;
 const score = row => {
  const weights = {'Bid Invitations':5,'RFIs & Change Orders':5,'Estimating':4,'Dispatch':4,'Invoices':3,'General':1};
  let total = weights[row.category]||1;
  if (!has(row,'\\Seen')) total += 1;
  if (actionable(row)&&!repliedTo(row)) total += 2;
  const due = extractDeadline(row);
  if (due&&due>=today&&due<=shift(today,3)) total += 4;
  if (risksOf(row).length) total += 3;
  if ((row.attachments||[]).length) total += 1;
  return total;
 };
 const page = (items,{limit=25,offset=0}={}) => ({total:items.length,offset,limit,hasMore:offset+limit<items.length,items:items.slice(offset,offset+limit)});

 const synonyms = {bid:['itb','invite','invitation','bidding','rfp','pricing','quote'],demo:['demolition'],demolition:['demo'],
  invoice:['payment','remittance','billing','pay app'],rfi:['request for information'],proposal:['quote','pricing','estimate'],
  addendum:['addenda','revised','revision'],walk:['site walk','walkthrough','job walk'],award:['awarded','notice of award','selected']};
 const stop = new Set('the a an and or of for to in on at by from with about regarding re fw fwd email emails find every all any me my our we us show list get give what which who is are was were this that these those project projects please'.split(' '));

 function search(args={}) {
  const phrases = [...String(args.query||'').matchAll(/"([^"]{2,80})"/g)].map(match=>lower(match[1]));
  const words = lower(String(args.query||'').replace(/"[^"]*"/g,' ')).match(/[a-z0-9@.$#&'-]{2,}/g)?.filter(word=>!stop.has(word))||[];
  const terms = [...new Set(words.flatMap(word=>[word,...(synonyms[word]||[])]))];
  const range = args.dateFrom||args.dateTo ? resolveRange(args,3650,today) : null;
  const scored = [];
  for (const row of rows) {
   if (args.folder&&lower(row.folder)!==lower(args.folder)) continue;
   if (args.category&&row.category!==args.category) continue;
   if (range&&!inRange(row,range)) continue;
   if (args.from&&!lower(row.from+' '+row.fromName).includes(lower(args.from))) continue;
   if (args.to&&!lower(row.to+' '+row.cc).includes(lower(args.to))) continue;
   if (args.domain&&!lower(row.from+' '+row.to+' '+row.cc).includes(lower(args.domain).replace(/^@/,''))) continue;
   if (args.hasAttachment===true&&!(row.attachments||[]).length) continue;
   if (args.unread===true&&has(row,'\\Seen')) continue;
   if (args.starred===true&&!has(row,'\\Flagged')) continue;
   const fields = {subject:lower(row.subject),from:lower(row.from+' '+row.fromName+' '+row.to),files:lower((row.attachments||[]).map(file=>file.name).join(' ')),body:lower(row.preview)};
   if (phrases.some(phrase=>!Object.values(fields).some(field=>field.includes(phrase)))) continue;
   let points = phrases.length*4;
   for (const term of terms) points += (fields.subject.includes(term)?3:0)+(fields.from.includes(term)?2:0)+(fields.files.includes(term)?2:0)+(fields.body.includes(term)?1:0);
   if (terms.length&&!phrases.length&&points===0) continue;
   scored.push({row,points});
  }
  scored.sort((a,b)=>b.points-a.points||String(b.row.date).localeCompare(String(a.row.date)));
  const seen = new Set();
  const unique = scored.filter(({row})=>{const key = row.messageId||row.id;if (seen.has(key)) return false;seen.add(key);return true;});
  return page(unique.map(({row,points})=>({...sourceOf(row),category:row.category,unread:!has(row,'\\Seen'),score:points})),
   {limit:Math.min(args.limit||20,50),offset:args.offset||0});
 }

 function thread(args) {
  const row = byId.get(args.id);
  if (!row) return null;
  return {id:row.id,subject:row.subject,messages:(threads.get(row.id)||[row]).map(item=>({...sourceOf(item,item.preview),category:item.category}))};
 }

 function unanswered(args={}) {
  const range = resolveRange(args,14,today);
  const items = inbound.filter(row=>inRange(row,range)&&actionable(row)&&!repliedTo(row))
   .map(row=>({...sourceOf(row),category:row.category,waitingDays:Math.max(0,Math.round((Date.parse(today)-Date.parse(dayOf(row.date)))/86400000)),score:score(row)}))
   .sort((a,b)=>b.score-a.score||String(b.date).localeCompare(String(a.date)));
  return {range,...page(items,args)};
 }

 function opportunities(args={}) {
  const range = resolveRange(args,30,today);
  const items = inbound.filter(row=>row.category==='Bid Invitations'&&inRange(row,range)).map(row=>{
   const responded = repliedTo(row);
   return {...sourceOf(row),due:extractDeadline(row),responded,gc:domainOf(addresses(row.from)[0])};
  }).filter(item=>args.status==='not_responded'?!item.responded:true)
   .sort((a,b)=>String(a.due||'9999').localeCompare(String(b.due||'9999')));
  return {range,...page(items,args)};
 }

 function deadlines(args={}) {
  const range = isDay(args.dateFrom)||isDay(args.dateTo) ? resolveRange(args,7,today) : {from:today,to:shift(today,6)};
  const items = [];
  const seen = new Set();
  for (const row of rows) {
   if (sent(row)) continue;
   const due = extractDeadline(row);
   if (!due) continue;
   const key = normalizeSubject(row.subject)+'|'+due;
   if (seen.has(key)) continue;
   const upcoming = due>=range.from&&due<=range.to;
   const missed = args.includeMissed!==false&&due<today&&due>=shift(today,-14)&&!repliedTo(row);
   if (!upcoming&&!missed) continue;
   seen.add(key);
   items.push({...sourceOf(row),due,status:due<today?'missed':due===today?'today':'upcoming',daysLeft:Math.round((Date.parse(due)-Date.parse(today))/86400000),responded:repliedTo(row),category:row.category});
  }
  items.sort((a,b)=>a.due.localeCompare(b.due));
  return {range,...page(items,{limit:args.limit||50})};
 }

 function followups(args={}) {
  const olderThan = Math.min(Math.max(args.olderThanDays??3,0),60);
  const cutoff = shift(today,-olderThan);
  const items = [];
  for (const row of sentRows) {
   const day = dayOf(row.date);
   if (day>cutoff||day<shift(today,-60)) continue;
   if (!proposalLine.test(row.subject+' '+row.preview)&&!(row.attachments||[]).length) continue;
   const recipients = addresses(row.to+','+row.cc).filter(external);
   if (!recipients.length) continue;
   const domains = new Set(recipients.map(domainOf));
   const thread = threads.get(row.id)||[];
   const answered = thread.some(other=>!sent(other)&&other.date>row.date)||
    inbound.some(other=>other.date>row.date&&domains.has(domainOf(addresses(other.from)[0]))&&normalizeSubject(other.subject)===normalizeSubject(row.subject));
   if (answered) continue;
   items.push({...sourceOf(row),recipients,daysWaiting:Math.round((Date.parse(today)-Date.parse(day))/86400000)});
  }
  items.sort((a,b)=>b.daysWaiting-a.daysWaiting);
  return page(items,args);
 }

 function projectHistory(args) {
  const found = search({query:args.project,limit:200});
  const ids = new Set();
  for (const item of found.items) for (const row of threads.get(item.id)||[]) ids.add(row.id);
  const items = [...ids].map(id=>byId.get(id)).sort((a,b)=>String(a.date).localeCompare(String(b.date)))
   .map(row=>({...sourceOf(row),category:row.category,direction:sent(row)?'sent':'received',due:extractDeadline(row)}));
  return {project:args.project,firstDate:items[0]?.date||null,lastDate:items.at(-1)?.date||null,...page(items,{limit:Math.min(args.limit||40,100),offset:args.offset||0})};
 }

 function contactHistory(args) {
  const needle = lower(args.contact).replace(/^@/,'');
  const items = rows.filter(row=>lower(row.from+' '+row.fromName+' '+row.to+' '+row.cc).includes(needle))
   .map(row=>({...sourceOf(row),category:row.category,direction:sent(row)?'sent':'received'}));
  const counts = {};
  for (const item of items) counts[item.category] = (counts[item.category]||0)+1;
  return {contact:args.contact,received:items.filter(item=>item.direction==='received').length,sent:items.filter(item=>item.direction==='sent').length,
   byCategory:counts,firstDate:items.at(-1)?.date||null,lastDate:items[0]?.date||null,...page(items,{limit:Math.min(args.limit||30,100),offset:args.offset||0})};
 }

 function paymentCommitments(args={}) {
  const range = resolveRange(args,60,today);
  const items = [];
  for (const row of rows) {
   if (!inRange(row,range)) continue;
   for (const line of sentences(row.preview)) {
    if (!paymentLine.test(line)) continue;
    if (!commitmentLine.test(line)&&!/\$\s?\d/.test(line)&&row.category!=='Invoices') continue;
    items.push({...sourceOf(row,line),direction:sent(row)?'we said':'they said',amounts:line.match(amount)||[],dueDate:parseDate(line,new Date(row.date)),
     overdue:Boolean(parseDate(line,new Date(row.date))&&parseDate(line,new Date(row.date))<today)});
    break;
   }
  }
  return {range,...page(items,args)};
 }

 function commitments(args={}) {
  const range = resolveRange(args,30,today);
  const items = [];
  for (const row of sentRows) {
   if (!inRange(row,range)) continue;
   const line = sentences(row.preview).find(item=>promiseLine.test(item));
   if (!line) continue;
   items.push({...sourceOf(row,line),to:row.to,dueDate:parseDate(line,new Date(row.date))});
  }
  return {range,...page(items,args)};
 }

 function risks(args={}) {
  const range = resolveRange(args,30,today);
  const items = rows.filter(row=>inRange(row,range)).map(row=>({row,types:risksOf(row)})).filter(item=>item.types.length)
   .map(({row,types})=>({...sourceOf(row),types,direction:sent(row)?'sent':'received'}));
  return {range,...page(items,args)};
 }

 function relationships(args={}) {
  const groups = new Map();
  for (const row of inbound) {
   const domain = domainOf(addresses(row.from)[0]);
   if (!domain) continue;
   const entry = groups.get(domain)||{domain,total:0,bidInvites:0,last30:0,prior90:0,lastDate:null,names:new Set()};
   entry.total++;
   if (row.category==='Bid Invitations') entry.bidInvites++;
   const day = dayOf(row.date);
   if (day>=shift(today,-29)) entry.last30++;
   else if (day>=shift(today,-119)) entry.prior90++;
   if (!entry.lastDate||row.date>entry.lastDate) entry.lastDate = row.date;
   if (row.fromName) entry.names.add(row.fromName);
   groups.set(domain,entry);
  }
  const list = [...groups.values()].filter(entry=>entry.total>=gcThreshold).map(entry=>({...entry,names:[...entry.names].slice(0,4),
   status:entry.last30===0&&entry.prior90>=2?'cold':entry.last30<entry.prior90/3?'cooling':'active'}));
  const sort = args.sort==='volume'?(a,b)=>b.bidInvites-a.bidInvites||b.total-a.total:(a,b)=>String(b.lastDate).localeCompare(String(a.lastDate));
  const filtered = args.status?list.filter(entry=>entry.status===args.status):list;
  return page(filtered.sort(sort),{limit:Math.min(args.limit||25,100)});
 }

 function volume(args={}) {
  const range = resolveRange(args,90,today);
  const unit = ['day','week','month'].includes(args.groupBy)?args.groupBy:'month';
  const bucket = day => unit==='day'?day:unit==='month'?day.slice(0,7):shift(day,-((weekdayOf(day)+6)%7));
  const counts = {};
  for (const row of rows) {
   if (!inRange(row,range)||(args.category&&row.category!==args.category)) continue;
   if (args.direction==='sent'&&!sent(row)) continue;
   if (args.direction!=='sent'&&sent(row)) continue;
   const key = bucket(dayOf(row.date));
   counts[key] = (counts[key]||0)+1;
  }
  return {range,groupBy:unit,category:args.category||'all',direction:args.direction||'received',
   series:Object.entries(counts).sort(([a],[b])=>a.localeCompare(b)).map(([period,count])=>({period,count}))};
 }

 function alerts() {
  const out = [];
  for (const item of deadlines({dateFrom:today,dateTo:shift(today,3),includeMissed:true}).items) {
   out.push({type:item.status==='missed'?'missed bid deadline':'bid deadline soon',severity:item.status==='missed'?'high':item.daysLeft<=1?'high':'medium',
    message:(item.status==='missed'?'Missed: ':'Due '+item.due+': ')+item.subject,source:item});
  }
  for (const item of unanswered({dateFrom:shift(today,-10),dateTo:shift(today,-2),limit:8}).items) {
   out.push({type:'unanswered email',severity:item.waitingDays>=5?'high':'medium',message:item.waitingDays+' days without a reply: '+item.subject,source:item});
  }
  for (const item of followups({olderThanDays:5,limit:5}).items) out.push({type:'proposal follow-up',severity:'medium',message:item.daysWaiting+' days with no response: '+item.subject,source:item});
  for (const item of paymentCommitments({limit:20}).items.filter(entry=>entry.overdue).slice(0,5)) out.push({type:'overdue payment commitment',severity:'high',message:'Payment date passed: '+item.subject,source:item});
  for (const row of rows.filter(row=>!sent(row)&&dayOf(row.date)>=shift(today,-7)&&/\b(?:addend(?:um|a)|revised (?:plans|drawings|set)|reissued?|bulletin)\b/i.test(row.subject+' '+row.preview)).slice(0,5)) {
   out.push({type:'revised plans or addendum',severity:'medium',message:row.subject,source:sourceOf(row)});
  }
  for (const item of risks({dateFrom:shift(today,-7),limit:5}).items) out.push({type:item.types.join(', '),severity:'high',message:item.subject,source:item});
  const scheduleDays = new Map();
  for (const row of rows.filter(row=>row.category==='Dispatch'&&dayOf(row.date)>=shift(today,-14))) {
   const date = parseDate(row.preview,new Date(row.date));
   if (!date||date<today) continue;
   scheduleDays.set(date,[...(scheduleDays.get(date)||[]),row]);
  }
  for (const [date,list] of scheduleDays) {
   const projects = new Set(list.map(row=>normalizeSubject(row.subject)));
   if (projects.size>1) out.push({type:'possible scheduling conflict',severity:'medium',message:projects.size+' crew requests for '+date,source:sourceOf(list[0])});
  }
  for (const entry of relationships({status:'cold',limit:5}).items) out.push({type:'dormant GC relationship',severity:'low',message:entry.domain+' sent '+entry.prior90+' emails in the prior 90 days and none in the last 30',source:null});
  return out;
 }

 function briefing(args={}) {
  const range = args.dateFrom||args.dateTo ? resolveRange(args,1,today) : {from:today,to:today};
  const received = inbound.filter(row=>inRange(row,range));
  const ranked = received.map(row=>({...sourceOf(row),category:row.category,unread:!has(row,'\\Seen'),replied:repliedTo(row),due:extractDeadline(row),risk:risksOf(row),score:score(row)}))
   .sort((a,b)=>b.score-a.score);
  return {range,received:received.length,unread:received.filter(row=>!has(row,'\\Seen')).length,
   sent:sentRows.filter(row=>inRange(row,range)).length,mostImportant:ranked.slice(0,12),
   deadlinesNext7Days:deadlines({}).items.slice(0,10),unanswered:unanswered({limit:10}).items,
   followups:followups({limit:8}).items,risks:risks({dateFrom:shift(range.to,-6),dateTo:range.to,limit:6}).items,
   alerts:alerts().slice(0,15)};
 }

 function metrics(args={},{coverageStart=null}={}) {
  const range = resolveRange(args,30,today);
  const received = inbound.filter(row=>inRange(row,range));
  const covered = !coverageStart||dayOf(coverageStart)<=range.from;
  const responseHours = [];
  for (const row of received.filter(actionable)) {
   const reply = (threads.get(row.id)||[]).find(other=>sent(other)&&other.date>row.date);
   if (reply) responseHours.push((Date.parse(reply.date)-Date.parse(row.date))/3600000);
  }
  const firstSeen = new Map();
  for (const row of [...inbound].sort((a,b)=>String(a.date).localeCompare(String(b.date)))) {
   const domain = domainOf(addresses(row.from)[0]);
   if (domain&&!firstSeen.has(domain)) firstSeen.set(domain,dayOf(row.date));
  }
  const gcDomains = new Set(received.filter(row=>['Bid Invitations','Estimating','RFIs & Change Orders'].includes(row.category)).map(row=>domainOf(addresses(row.from)[0])));
  const allDeadlines = rows.filter(row=>!sent(row)).map(row=>({row,due:extractDeadline(row)})).filter(item=>item.due&&item.due>=range.from&&item.due<=range.to);
  return {range,coverage:{complete:covered,indexedFrom:coverageStart},
   emailsReceived:covered?received.length:null,emailsSent:covered?sentRows.filter(row=>inRange(row,range)).length:null,
   unreadEmails:covered?received.filter(row=>!has(row,'\\Seen')).length:null,
   unansweredActionable:covered?received.filter(row=>actionable(row)&&!repliedTo(row)).length:null,
   newBidInvitations:covered?received.filter(row=>row.category==='Bid Invitations').length:null,
   upcomingBidDeadlines:allDeadlines.filter(item=>item.due>=today).length,
   missedBidDeadlines:allDeadlines.filter(item=>item.due<today&&!repliedTo(item.row)).length,
   outstandingProposalFollowups:followups({olderThanDays:3,limit:1}).total,
   averageResponseHours:responseHours.length?Math.round(responseHours.reduce((a,b)=>a+b,0)/responseHours.length*10)/10:null,
   activeGcRelationships:covered?gcDomains.size:null,
   newGcRelationships:coverageStart?null:[...gcDomains].filter(domain=>(firstSeen.get(domain)||'')>=range.from).length,
   detectedPaymentCommitments:paymentCommitments({dateFrom:range.from,dateTo:range.to,limit:1}).total,
   operationalAlerts:alerts().length};
 }

 return {search,thread,unanswered,opportunities,deadlines,followups,projectHistory,contactHistory,paymentCommitments,commitments,
  risks,relationships,volume,alerts,briefing,metrics,byId,threads};
}
