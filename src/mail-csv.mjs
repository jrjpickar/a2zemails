const headers=['Folder','Date','Subject','From Name','From','To','Cc','Bcc','Category','Project','Bid Due','Temperature','Unread','Starred','Attachment Names','Attachment Metadata','Message ID','References','IONOS ID','Body','Body Status'];

function cell(value) {
 let text=String(value??'');
 if (/^[\t\r\n]|^\s*[=+\-@]/.test(text)) text="'"+text;
 return /[",\r\n]/.test(text)?'"'+text.replaceAll('"','""')+'"':text;
}

export const mailCsvHeader='\uFEFF'+headers.join(',')+'\r\n';

export function mailCsvRows(messages) {
 return messages.map(message=>[
  message.folder,message.date,message.subject,message.name,message.from,message.to,message.cc,message.bcc,
  message.category,message.project,message.due,message.temperature,message.unread?'Yes':'No',message.star?'Yes':'No',
  message.files?.join(' | '),message.attachments?.length?JSON.stringify(message.attachments):'',message.headers?.messageId,
  message.headers?.references?.join(' '),message.id,message.body,message.bodyStatus||'Complete',
 ].map(cell).join(',')+'\r\n').join('');
}

export function downloadMailCsv(parts,view) {
 const file=new Blob(parts,{type:'text/csv;charset=utf-8'});
 const url=URL.createObjectURL(file);
 const link=document.createElement('a');
 link.href=url;
 link.download='a2z-mail-'+(view.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,50)||'export')+'-'+
  new Date().toISOString().slice(0,10)+'.csv';
 document.body.append(link);
 link.click();
 link.remove();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
}
