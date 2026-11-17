import {createHash} from 'node:crypto';
import {getStore} from '@netlify/blobs';

export const MAX_STAGED_BYTES=24*1024*1024;
export const CHUNK_BYTES=2*1024*1024;
export const UPLOAD_REQUEST_LIMIT=2_900_000;
const validId=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function checkedId(value) {
 if (typeof value!=='string'||!validId.test(value)) throw new TypeError('Invalid attachment or draft ID.');
 return value;
}
export function stagedFiles(input) {
 if (input===undefined) return [];
 if (!Array.isArray(input)||input.length>10) throw new TypeError('Attach up to 10 files.');
 let total=0;
 const used=new Set();
 return input.map(file=>{
  const id=checkedId(file?.id);
  if (used.has(id)||typeof file.name!=='string'||!file.name.trim()||file.name.length>180||
      /[\u0000-\u001f\u007f/\\]/.test(file.name)||!Number.isSafeInteger(file.size)||file.size<=0) {
   throw new TypeError('Invalid attachment.');
  }
  used.add(id);
  total+=file.size;
  if (total>MAX_STAGED_BYTES) throw new TypeError('Attachments must total 24 MB or less.');
  return {id,name:file.name,size:file.size};
 });
}

export function stagedAttachments(email,store=getStore({name:'mail-uploads',consistency:'strong'})) {
 const account=createHash('sha256').update(email.toLowerCase()).digest('hex');
 const prefix=draft=>account+'/'+checkedId(draft)+'/';
 const partKey=(draft,file,index)=>prefix(draft)+file+'/'+index;
 return {
  async saveFile(draft,file,content) {
   const count=Math.ceil(content.length/CHUNK_BYTES);
   for (let start=0;start<count;start+=4) {
    await Promise.all(Array.from({length:Math.min(4,count-start)},(_,offset)=>{
     const index=start+offset;
     const part=content.subarray(index*CHUNK_BYTES,(index+1)*CHUNK_BYTES);
     return store.set(partKey(draft,checkedId(file),index),part.buffer.slice(part.byteOffset,part.byteOffset+part.byteLength));
    }));
   }
   return count;
  },
  async readChunk(draft,file,index,maxBytes=MAX_STAGED_BYTES) {
   if (!Number.isInteger(index)||index<0||index>=Math.ceil(maxBytes/CHUNK_BYTES)) throw new TypeError('Invalid attachment chunk.');
   const data=await store.get(partKey(draft,checkedId(file),index),{type:'arrayBuffer'});
   return data&&Buffer.from(data);
  },
  async upload(input) {
   const file=stagedFiles([input?.file])[0];
   const index=input.index;
   const count=Math.ceil(file.size/CHUNK_BYTES);
   if (!Number.isInteger(index)||index<0||index>=count||typeof input.data!=='string'||
       input.data.length>Math.ceil(CHUNK_BYTES/3)*4||input.data.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) {
    throw new TypeError('Invalid upload chunk.');
   }
   const data=Buffer.from(input.data,'base64');
   const expected=Math.min(CHUNK_BYTES,file.size-index*CHUNK_BYTES);
   if (data.length!==expected) throw new TypeError('Upload chunk was incomplete.');
   const key=partKey(input.draftId,file.id,index);
   await store.set(key,data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));
  },
  async resolve(draft,input) {
   const files=stagedFiles(input);
   if (!files.length) return [];
   // Read batches sequentially by file, with at most four chunk fetches in flight.
   const attachments=[];
   for (const file of files) {
    const count=Math.ceil(file.size/CHUNK_BYTES);
    const chunks=[];
    for (let start=0;start<count;start+=4) {
     const indexes=Array.from({length:Math.min(4,count-start)},(_,offset)=>start+offset);
     const batch=await Promise.all(indexes.map(index=>store.get(partKey(draft,file.id,index),{type:'arrayBuffer'})));
     for (const [offset,chunk] of batch.entries()) {
      const expected=Math.min(CHUNK_BYTES,file.size-(start+offset)*CHUNK_BYTES);
      if (!chunk||chunk.byteLength!==expected) throw new TypeError('An attachment did not finish uploading. Remove it and attach it again.');
      chunks.push(Buffer.from(chunk));
     }
    }
    attachments.push({filename:file.name,content:Buffer.concat(chunks,file.size)});
   }
   return attachments;
  },
  async clean(draft,keep=[]) {
   const draftPrefix=prefix(draft);
   const {blobs}=await store.list({prefix:draftPrefix});
   const retained=new Set(keep.map(file=>file.id));
   const obsolete=blobs.filter(({key})=>!retained.has(key.slice(draftPrefix.length).split('/')[0]));
   for (let start=0;start<obsolete.length;start+=12) {
    await Promise.all(obsolete.slice(start,start+12).map(({key})=>store.delete(key)));
   }
  },
 };
}
