import {useEffect,useState} from 'react';
import {Download,FileText,X} from 'lucide-react';

export type MailAttachment={name:string;part:string;type:string;size:number};
export type ForwardedAttachment={messageId:string;part:string;name:string};
type DraftFile={id:string;name:string;size:number};
export type AttachmentSource=
 | {kind:'mail';id:string;part:string;name:string;hosted:boolean}
 | {kind:'inline';name:string;data:string}
 | {kind:'staged'|'large';draftId:string;file:DraftFile;name:string};

type Loaded={url:string;name:string;type:string};
const CHUNK_BYTES=2*1024*1024;

function decode(base64:string) {
 const chars=atob(base64);
 const bytes=new Uint8Array(chars.length);
 for (let index=0;index<chars.length;index++) bytes[index]=chars.charCodeAt(index);
 return bytes;
}

function previewType(bytes:Uint8Array|undefined) {
 const header=Array.from(bytes?.subarray(0,12)??[]);
 const text=String.fromCharCode(...header);
 if (text.startsWith('%PDF-')) return 'application/pdf';
 if (header.slice(0,8).join(',')==='137,80,78,71,13,10,26,10') return 'image/png';
 if (header.slice(0,3).join(',')==='255,216,255') return 'image/jpeg';
 if (/^GIF8[79]a/.test(text)) return 'image/gif';
 if (text.startsWith('RIFF')&&text.slice(8)==='WEBP') return 'image/webp';
 return 'application/octet-stream';
}

export function AttachmentPreview({source,request,close}:{
 source:AttachmentSource;request:(action:string,body:object)=>Promise<any>;close:()=>void;
}) {
 const [loaded,setLoaded]=useState<Loaded|null>(null);
 const [error,setError]=useState('');
 const [progress,setProgress]=useState('Opening attachment…');

 useEffect(()=>{
  let cancelled=false;
  let objectUrl:string|undefined;
  async function load() {
   if (source.kind==='large') {
    const {url}=await request('large-download',{draftId:source.draftId,file:source.file});
    if (!cancelled) setLoaded({url,name:source.name,type:'application/octet-stream'});
    return;
   }
   const parts:Uint8Array<ArrayBuffer>[]=[];
   let name=source.name;
   async function readChunks(chunks:number,read:(index:number)=>Promise<{data:string}>) {
    for (let index=0;index<chunks&&!cancelled;index++) {
     setProgress('Loading attachment · '+Math.floor(100*index/chunks)+'%');
     parts.push(decode((await read(index)).data));
    }
   }
   if (source.kind==='inline') parts.push(decode(source.data));
   else if (source.kind==='staged') {
    await readChunks(Math.ceil(source.file.size/CHUNK_BYTES),index=>
     request('draft-attachment-chunk',{draftId:source.draftId,file:source.file,index}));
   } else if (source.kind==='mail') {
    const result=await request('attachment',{id:source.id,part:source.part});
    name=result.name;
    if (source.hosted) {
     const {ticket,fileId,chunks}=result;
     try {await readChunks(chunks,index=>request('attachment-chunk',{ticket,fileId,index}));}
     finally {void request('attachment-release',{ticket}).catch(()=>{});}
    } else parts.push(decode(result.data));
   }
   if (cancelled) return;
   const type=previewType(parts[0]);
   objectUrl=URL.createObjectURL(new Blob(parts,{type}));
   setLoaded({url:objectUrl,name,type});
  }
  void load().catch(error=>{if(!cancelled)setError(error instanceof Error?error.message:'Attachment unavailable.')});
  return ()=>{cancelled=true;if(objectUrl)URL.revokeObjectURL(objectUrl)};
 },[source]);

 return <div className="modal-back centered" onClick={close}>
  <section className="attachment-preview live-attachment-preview" role="dialog" aria-label="Attachment preview" aria-modal="true" onClick={event=>event.stopPropagation()}>
   <header><b>{source.name}</b><button type="button" className="icon" title="Close preview" onClick={close}><X size={19}/></button></header>
   {loaded?.type==='application/pdf'?<iframe title={loaded.name} src={loaded.url}/>:
    loaded?.type.startsWith('image/')?<div className="attachment-image"><img alt={loaded.name} src={loaded.url}/></div>:
    <div className="preview-sheet" role="status"><FileText size={34}/><p>{error||(loaded?'Download this file to open it.':progress)}</p></div>}
   {loaded&&<footer><a href={loaded.url} download={loaded.name} target="_blank" rel="noopener noreferrer"><Download size={16}/> Download</a>
    {(loaded.type==='application/pdf'||loaded.type.startsWith('image/'))&&<a href={loaded.url} target="_blank" rel="noopener noreferrer">Open in new tab</a>}</footer>}
  </section>
 </div>;
}
