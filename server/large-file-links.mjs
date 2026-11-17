import {createHash} from 'node:crypto';
import {
 AbortMultipartUploadCommand,CompleteMultipartUploadCommand,CreateMultipartUploadCommand,
 DeleteObjectCommand,GetObjectCommand,HeadObjectCommand,S3Client,UploadPartCommand,
} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';

export const LARGE_FILE_LIMIT=1024*1024*1024;
const PART_BYTES=16*1024*1024;
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

export function largeFileRefs(input) {
 if (input===undefined) return [];
 if (!Array.isArray(input)||input.length>10) throw new TypeError('Choose up to 10 large files.');
 let total=0;
 const ids=new Set();
 return input.map(file=>{
  if (!uuid.test(file?.id||'')||ids.has(file.id)||typeof file.name!=='string'||!file.name.trim()||file.name.length>180||
      /[\x00-\x1f\x7f/\\]/.test(file.name)||!Number.isSafeInteger(file.size)||file.size<=0) {
   throw new TypeError('Invalid large file.');
  }
  total+=file.size;
  if (total>LARGE_FILE_LIMIT) throw new TypeError('Download links can total up to 1 GB per message.');
  ids.add(file.id);
  return {id:file.id,name:file.name,size:file.size};
 });
}

export function largeFilesEnabled(env) {
 return /^[a-f0-9]{32}$/i.test(env.R2_ACCOUNT_ID||'')&&Boolean(
  env.ATTACHMENT_STORAGE_BUCKET&&env.R2_ACCESS_KEY_ID&&env.R2_SECRET_ACCESS_KEY);
}

export function largeFileLinks(env,email,dependencies={}) {
 if (!largeFilesEnabled(env)) throw new TypeError('Large file uploads are not configured for this deployment.');
 const Bucket=env.ATTACHMENT_STORAGE_BUCKET;
 const client=dependencies.client||new S3Client({
  region:'auto',endpoint:'https://'+env.R2_ACCOUNT_ID+'.r2.cloudflarestorage.com',
  credentials:{accessKeyId:env.R2_ACCESS_KEY_ID,secretAccessKey:env.R2_SECRET_ACCESS_KEY},
  requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',
 });
 const sign=dependencies.sign||getSignedUrl;
 const owner=createHash('sha256').update(email.toLowerCase()).digest('hex');
 function locator(draft,file) {
  if (!uuid.test(draft||'')) throw new TypeError('Invalid draft ID.');
  return {Bucket,Key:'shared/'+owner+'/'+draft+'/'+file.id};
 }
 function downloadDisposition(name) {
  return "attachment; filename*=UTF-8''"+encodeURIComponent(name).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
 }
 function uploadIdentifier(value) {
  if (typeof value!=='string'||!value||value.length>1024) throw new TypeError('Invalid upload session.');
  return value;
 }
 return {
  async begin(input) {
   const file=largeFileRefs([input?.file])[0];
   const object=locator(input.draftId,file);
   const {UploadId}=await client.send(new CreateMultipartUploadCommand({
    ...object,ContentType:'application/octet-stream',ContentDisposition:downloadDisposition(file.name),
    Metadata:{'declared-bytes':String(file.size)},
   }));
   if (!UploadId) throw new Error('Storage did not start the upload.');
   try {
    const urls=await Promise.all(Array.from({length:Math.ceil(file.size/PART_BYTES)},(_,index)=>
     sign(client,new UploadPartCommand({...object,UploadId,PartNumber:index+1}),{expiresIn:7200})));
    return {uploadId:UploadId,partBytes:PART_BYTES,urls};
   } catch(error) {
    await client.send(new AbortMultipartUploadCommand({...object,UploadId})).catch(()=>{});
    throw error;
   }
  },
  async complete(input) {
   const file=largeFileRefs([input?.file])[0];
   const object=locator(input.draftId,file);
   const UploadId=uploadIdentifier(input.uploadId);
   const parts=input.etags;
   if (!Array.isArray(parts)||parts.length!==Math.ceil(file.size/PART_BYTES)||
       parts.some(tag=>typeof tag!=='string'||!/^(?:"[a-f0-9]{32}"|[a-f0-9]{32})$/i.test(tag))) {
    throw new TypeError('The upload is incomplete.');
   }
   await client.send(new CompleteMultipartUploadCommand({
    ...object,UploadId,MultipartUpload:{Parts:parts.map((ETag,index)=>({ETag,PartNumber:index+1}))},
   }));
   const head=await client.send(new HeadObjectCommand(object));
   if (head.ContentLength!==file.size) {
    await client.send(new DeleteObjectCommand(object)).catch(()=>{});
    throw new TypeError('The uploaded file size did not match. Attach the file again.');
   }
  },
  async abort(input) {
   const file=largeFileRefs([input?.file])[0];
   await client.send(new AbortMultipartUploadCommand({...locator(input.draftId,file),UploadId:uploadIdentifier(input.uploadId)}));
  },
  async links(draft,input) {
   const files=largeFileRefs(input);
   return Promise.all(files.map(async file=>{
    const object=locator(draft,file);
    const head=await client.send(new HeadObjectCommand(object));
    if (head.ContentLength!==file.size) throw new TypeError('A large file is missing or incomplete. Attach it again.');
    const url=await sign(client,new GetObjectCommand({...object,ResponseContentDisposition:downloadDisposition(file.name)}),{expiresIn:7*86400});
    return {name:file.name,url};
   }));
  },
 };
}
