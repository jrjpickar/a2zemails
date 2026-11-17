export type LargeFile={id:string;name:string;size:number};

function putPart(url:string,part:Blob,progress:(bytes:number)=>void,signal:AbortSignal):Promise<string> {
 return new Promise((resolve,reject)=>{
  if (signal.aborted) {reject(new Error('Upload canceled.'));return;}
  const request=new XMLHttpRequest();
  const cancel=()=>request.abort();
  const done=()=>signal.removeEventListener('abort',cancel);
  request.open('PUT',url);
  request.timeout=300000;
  request.upload.onprogress=event=>progress(event.loaded);
  request.onload=()=>{
   done();
   const tag=request.getResponseHeader('ETag');
   if (request.status>=200&&request.status<300&&tag) resolve(tag);
   else reject(new Error('Storage did not accept the upload part. Check the bucket CORS settings and retry.'));
  };
  request.onerror=request.ontimeout=()=>{
   done();reject(new Error('Connection interrupted while uploading a file part.'));
  };
  request.onabort=()=>{done();reject(new Error('Upload canceled.'));};
  signal.addEventListener('abort',cancel,{once:true});
  request.send(part);
 });
}

export async function uploadLargeFile(
 draftId:string,file:File,request:(action:string,body:object)=>Promise<any>,
 progress:(percentage:number)=>void,signal:AbortSignal,
):Promise<LargeFile> {
 const descriptor={id:crypto.randomUUID(),name:file.name,size:file.size};
 const {uploadId,partBytes,urls}:{uploadId:string;partBytes:number;urls:string[]}=await request('large-start',{draftId,file:descriptor});
 const etags:string[]=[];
 try {
  for (const [index,url] of urls.entries()) {
   const offset=index*partBytes;
   const part=file.slice(offset,offset+partBytes);
   const update=(bytes:number)=>progress(Math.floor(100*(offset+bytes)/file.size));
   try {etags.push(await putPart(url,part,update,signal));}
   catch (error) {
    if (signal.aborted) throw error;
    etags.push(await putPart(url,part,update,signal));
   }
  }
  if (signal.aborted) throw new Error('Upload canceled.');
  await request('large-finish',{draftId,file:descriptor,uploadId,etags});
  return descriptor;
 } catch(error) {
  await request('large-abort',{draftId,file:descriptor,uploadId}).catch(()=>{});
  throw error;
 }
}
