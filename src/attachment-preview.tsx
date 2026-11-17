import {useEffect,useState} from 'react';
import {Download,FileText,X} from 'lucide-react';

export type MailAttachment={name:string;part:string;type:string;size:number};
export type ForwardedAttachment={messageId:string;part:string;name:string};

type Loaded={url:string;name:string;type:string};

export function AttachmentPreview({id,file,hosted,request,close}:{
 id:string;file:MailAttachment;hosted:boolean;
 request:(action:string,body:object)=>Promise<any>;close:()=>void;
}) {
 const [loaded,setLoaded]=useState<Loaded|null>(null);
 const [error,setError]=useState('');
 const [progress,setProgress]=useState('Opening attachment…');

 useEffect(()=>{
  let cancelled=false;
  let objectUrl:string|undefined;
  function decode(base64:string) {
   const chars=atob(base64);
   const bytes=new Uint8Array(chars.length);
   for (let index=0;index<chars.length;index++) bytes[index]=chars.charCodeAt(index);
   return bytes;
  }
  async function load() {
   const result=await request('attachment',{id,part:file.part});
   const parts:Uint8Array<ArrayBuffer>[]=[];
   if (hosted) {
    const {ticket,fileId,chunks}=result;
    try {
     for (let index=0;index<chunks&&!cancelled;index++) {
      setProgress('Loading attachment · '+Math.floor(100*index/chunks)+'%');
      const {data}=await request('attachment-chunk',{ticket,fileId,index});
      parts.push(decode(data));
     }
    } finally {
     void request('attachment-release',{ticket}).catch(()=>{});
    }
   } else parts.push(decode(result.data));
   if (cancelled) return;
   objectUrl=URL.createObjectURL(new Blob(parts,{type:result.type}));
   setLoaded({url:objectUrl,name:result.name,type:result.type});
  }
  void load().catch(error=>{if(!cancelled)setError(error instanceof Error?error.message:'Attachment unavailable.')});
  return ()=>{cancelled=true;if(objectUrl)URL.revokeObjectURL(objectUrl)};
 },[id,file.part,hosted]);

 return <div className="modal-back centered" onClick={close}>
  <section className="attachment-preview live-attachment-preview" role="dialog" aria-label="Attachment preview" aria-modal="true" onClick={event=>event.stopPropagation()}>
   <header><b>{file.name}</b><button className="icon" title="Close preview" onClick={close}><X size={19}/></button></header>
   {loaded?.type==='application/pdf'?<iframe title={loaded.name} src={loaded.url}/>:
    loaded?.type.startsWith('image/')?<div className="attachment-image"><img alt={loaded.name} src={loaded.url}/></div>:
    <div className="preview-sheet" role="status"><FileText size={34}/><p>{error||(loaded?'Download this file to open it.':progress)}</p></div>}
   {loaded&&<footer><a href={loaded.url} download={loaded.name}><Download size={16}/> Download</a>
    {(loaded.type==='application/pdf'||loaded.type.startsWith('image/'))&&<a href={loaded.url} target="_blank" rel="noopener noreferrer">Open in new tab</a>}</footer>}
  </section>
 </div>;
}
