// Mock integration contracts. No external routes or credentials are assumed.
export function createMockAdapters(getState, projects) {
 const snapshot=()=>getState().mail;
 const projectMail=id=>snapshot().filter(m=>m.project===id);
 const files=mail=>mail.flatMap(m=>m.files.map(name=>({messageId:m.id,name,sample:true})));
 return {
  estimating: {forEstimate: estimate=>{const p=projects.find(p=>p.aliases.includes(estimate));return p?projectMail(p.id).filter(m=>['Estimating','Bid Invitations'].includes(m.category)):[]}, prepareAttachments:ids=>files(snapshot().filter(m=>ids.includes(m.id)))},
  dispatch:{forJob:id=>projectMail(id).filter(m=>m.category==='Dispatch')},
  ledger:{correspondence:id=>projectMail(id).filter(m=>m.category==='Invoices')},
  crm:{findExisting:email=>{const m=snapshot().find(m=>m.from.toLowerCase()===email.toLowerCase());return m?{email:m.from,name:m.name,company:m.company,mock:true}:null}},
  assistant:{summary:()=>({unread:snapshot().filter(m=>m.folder==='Inbox'&&m.unread).length}), projectMail, attachments:id=>files(snapshot().filter(m=>m.id===id))}
 };
}
