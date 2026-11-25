import DOMPurify from 'dompurify';
import {useLayoutEffect,useMemo,useRef,useState} from 'react';

const styleProperties = [
 'font-family','font-size','font-weight','font-style','font-variant','letter-spacing',
 'color','background-color','text-decoration','text-align','text-indent','line-height',
 'vertical-align','white-space','list-style-type','border','border-width','border-style',
 'border-color','border-radius','border-collapse','border-spacing','padding','padding-top',
 'padding-right','padding-bottom','padding-left','margin','margin-top','margin-right',
 'margin-bottom','margin-left','width','max-width','height','max-height',
];

const purify = DOMPurify(window);
const cleanOptions = {
 WHOLE_DOCUMENT:true,
 RETURN_DOM:true as const,
 ALLOWED_TAGS:[
  'html','head','body','style','a','b','blockquote','br','caption','center','code','col',
  'colgroup','dd','del','div','dl','dt','em','font','h1','h2','h3','h4','h5','h6','hr',
  'i','img','ins','li','mark','ol','p','pre','s','small','span','strong','sub','sup',
  'table','tbody','td','tfoot','th','thead','tr','u','ul',
 ],
 ALLOWED_ATTR:[
  'alt','title','align','valign','bgcolor','border','cellpadding','cellspacing','class',
  'color','colspan','dir','face','height','href','id','lang','rowspan','size','src','style','width',
 ],
 ALLOW_DATA_ATTR:false,
 ALLOWED_URI_REGEXP:/^(?:(?:https?|mailto|cid):|#)/i,
};

const readerCss = `
 :host {display:block; min-width:0; overflow:auto;}
 .email-document {font:16px/1.45 Arial,sans-serif; overflow-wrap:anywhere; white-space:normal; margin:0; padding:2px 0;}
 .email-document.dark {color-scheme:dark; color:#f5f5f5; background:#1e1e1e; padding:14px;}
 .email-document.light {color-scheme:light; color:#241d19; background:#fff; padding:14px;}
 .email-document a {color:#9a3412;}
 .email-document.dark a {color:#9bc2cf;}
 .email-document img {max-width:100% !important; height:auto !important;}
 .email-document table {max-width:100%; overflow-wrap:anywhere;}
 .email-document pre {white-space:pre-wrap;}
 .missing-image {color:inherit; font:12px Arial,sans-serif;}
`;
const readerSheet = new CSSStyleSheet();
readerSheet.replaceSync(readerCss);

function safeStyle(target:HTMLElement, style:CSSStyleDeclaration) {
 for (const property of styleProperties) {
  const value=style.getPropertyValue(property);
  if (value && !/url\s*\(|var\s*\(|expression\s*\(|image\s*\(|[\\{};]/i.test(value)) {
   target.style.setProperty(property,value);
  }
 }
}

function adaptDark(element:HTMLElement) {
 for (let ancestor:HTMLElement|null=element;ancestor;ancestor=ancestor.parentElement) {
  const background=ancestor.style.backgroundColor||ancestor.getAttribute('bgcolor')||'';
  if (background && !/^(transparent|black|#000(?:000)?|rgb\(0, 0, 0\))$/i.test(background)) return;
 }
 {
  const color=element.style.color||element.getAttribute('color')||'';
  if (/^(black|#000(?:000)?|rgb\(0, 0, 0\))$/i.test(color)) element.style.color='#f5f5f5';
  if (/^(red|#f00|#ff0000|rgb\(255, 0, 0\))$/i.test(color)) element.style.color='#ff9f9f';
 }
}

function safeUrl(value:string, protocols:string[]) {
 try {
  const url=new URL(value);
  return protocols.includes(url.protocol)&&!url.username&&!url.password?url.href:'';
 } catch {return '';}
}

export type MailBody={attachments?:import('./attachment-preview').MailAttachment[];body:string;truncated:boolean;html?:string;images?:Record<string,string>};

export function RichMail({html,images,dark}:{html:string;images?:Record<string,string>;dark:boolean}) {
 const host=useRef<HTMLDivElement>(null);
 const [showPictures,setShowPictures]=useState(false);
 const [hasRemote,setHasRemote]=useState(false);
 const source=useMemo(()=>purify.sanitize(html,cleanOptions),[html]);

 useLayoutEffect(()=>{
  if (!host.current) return;
  const shadow=host.current.shadowRoot||host.current.attachShadow({mode:'open'});
  shadow.adoptedStyleSheets=[readerSheet];
  const content=source.cloneNode(true) as HTMLElement;
  const body=content.querySelector('body')||content;
  const inlineStyles=new Map<HTMLElement,string>();
  for (const element of [body,...body.querySelectorAll<HTMLElement>('[style]')]) {
   inlineStyles.set(element,element.getAttribute('style')||'');
   element.removeAttribute('style');
  }
  // Read the sender's rules, then copy supported declarations onto matching elements.
  const styles=Array.from(content.querySelectorAll('style'));
 for (const style of styles) style.remove();
 for (const style of styles.slice(0,12)) {
   const sheet=new CSSStyleSheet();
   try { sheet.replaceSync(style.textContent?.slice(0,60000)||''); } catch {}
   for (const rule of Array.from(sheet.cssRules).slice(0,250)) {
    if (!(rule instanceof CSSStyleRule)) continue;
    try {
     for (const element of content.querySelectorAll<HTMLElement>(rule.selectorText)) safeStyle(element,rule.style);
    } catch {}
   }
  }
  const declaration=document.createElement('span');
  for (const [element,style] of inlineStyles) {
   declaration.style.cssText=style;
   safeStyle(element,declaration.style);
  }

  let remote=false;
  for (const image of body.querySelectorAll('img')) {
   const original=image.getAttribute('src')||'';
   image.removeAttribute('src');
   let cid='';
   if (original.toLowerCase().startsWith('cid:')) {
    try {cid=decodeURIComponent(original.slice(4)).replace(/^<|>$/g,'').toLowerCase();} catch {}
   }
   const embedded=cid&&images&&Object.hasOwn(images,cid)?images[cid]:'';
   const external=safeUrl(original,['https:']);
   remote ||= Boolean(external);
   if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(embedded) || (external&&showPictures)) {
    image.referrerPolicy='no-referrer';
    image.src=embedded||external;
   } else {
    const placeholder=document.createElement('span');
    placeholder.className='missing-image';
    placeholder.textContent=image.alt||(external?'External image':'Image unavailable');
    image.replaceWith(placeholder);
   }
  }
  for (const link of body.querySelectorAll('a')) {
   const url=safeUrl(link.getAttribute('href')||'',['https:','http:','mailto:']);
   if (url) {
    link.href=url;
    link.target='_blank';
    link.rel='noopener noreferrer';
   } else link.removeAttribute('href');
  }
  if (dark) for (const element of body.querySelectorAll<HTMLElement>('*')) adaptDark(element);
  if (dark) adaptDark(body as HTMLElement);
  body.className='email-document '+(dark?'dark':'light');
  shadow.replaceChildren(body);
  setHasRemote(remote);
 },[source,images,dark,showPictures]);

 return <div className="rich-mail">
  {hasRemote&&!showPictures&&<button type="button" className="project-tag" onClick={()=>setShowPictures(true)}>Show external images</button>}
  <div ref={host}/>
 </div>;
}
