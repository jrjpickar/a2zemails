import {createHash} from 'node:crypto';
import {largeFileRefs} from './large-file-links.mjs';
import {signatureImage} from './signature-image.mjs';
import {forwardedReferences} from './ionos.mjs';
import {stagedFiles} from './staged-attachments.mjs';
import {mailAttachments} from './mail-attachments.mjs';
import {getStore} from '@netlify/blobs';

const draftId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const requiredText = (value,max) => {
 if (typeof value!=='string' || value.length>max) throw new TypeError('A draft field is too long or invalid.');
 return value;
};

export function mailboxPreferences(email, store=getStore({name:'mail-preferences',consistency:'strong'})) {
 const key=createHash('sha256').update(email.toLowerCase()).digest('hex');
 const prefix=key+'/draft/';
 function fileKey(id) {
  if (!draftId.test(id||'')) throw new TypeError('Invalid draft ID.');
  return prefix+id;
 }
 return {
  async load() {
   const [signature,{blobs}]=await Promise.all([
    store.get(key+'/signature',{type:'json'}),store.list({prefix})
   ]);
   const drafts=[];
   for (let start=0;start<blobs.length;start+=12) {
    const current=await Promise.all(blobs.slice(start,start+12).map(({key:blobKey})=>store.getMetadata(blobKey)));
    for (const entry of current) if (entry?.metadata?.id) drafts.push(entry.metadata);
   }
   return {signature:typeof signature==='string'?signature:signature?.text??null,signatureImage:signature?.image??null,drafts:drafts.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))};
  },
  async loadDraft(id) {return await store.get(fileKey(id),{type:'json'});},
  async saveDraft(input) {
   const blobKey=fileKey(input?.id);
   const draft={
    id:input.id,identity:email,files:[],attachments:mailAttachments(input.attachments),stagedAttachments:stagedFiles(input.stagedAttachments),forwardedAttachments:forwardedReferences(input.forwardedAttachments),largeFiles:largeFileRefs(input.largeFiles),
    to:requiredText(input.to,2048),cc:requiredText(input.cc,2048),
    subject:requiredText(input.subject,500),body:requiredText(input.body,150000),
    includeSignature:input.includeSignature!==false,
    updatedAt:new Date().toISOString(),
   };
   if (input.thread) draft.thread=requiredText(input.thread,2048);
   if (input.parent) {
    const refs=input.parent.headers?.references;
    if (!Array.isArray(refs)) throw new TypeError('Invalid reply headers.');
    draft.parent={
     project:requiredText(input.parent.project||'',2048),
     headers:{
      messageId:requiredText(input.parent.headers.messageId,998),
      references:refs.slice(-30).map(value=>requiredText(value,998)),
     },
    };
   }
   if (!await store.getMetadata(blobKey)) {
    const {blobs}=await store.list({prefix});
    if (blobs.length>=50) throw new TypeError('Discard an older draft before saving another.');
   }
   const {id,to,subject,updatedAt}=draft;
   await store.setJSON(blobKey,draft,{metadata:{id,to,subject,updatedAt}});
  },
  async discard(id) {await store.delete(fileKey(id));},
  async saveSignature(signature,image) {
   const text=requiredText(signature,2000);
   await store.setJSON(key+'/signature',{text,image:signatureImage(image)?.url??null});
  },
 };
}
