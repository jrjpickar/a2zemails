import {Fragment} from 'react';

type TextBlock = {quoted:boolean;lines:string[]};
const quotePrefix = /^\s*(?:> ?)+/;
const webLink = /https?:\/\/[^\s<>"\u0000-\u001f]+/gi;
const logoPlaceholder = /^\s*\[(?:logo(?: image)?|[^\]\n]{1,40} logo)\]\s*(?:https?:\/\/\S+)?\s*$/i;

function splitMessage(body:string):TextBlock[] {
 const blocks:TextBlock[]=[];
 const lines=body.replace(/\r\n?/g,'\n').split('\n');
 let block:TextBlock|undefined;

 for (const [index,line] of lines.entries()) {
  const quoted=quotePrefix.test(line) ||
   (!line.trim() && Boolean(block?.quoted) && quotePrefix.test(lines[index+1]||''));
  const content=quoted?line.replace(quotePrefix,''):line;
  if (logoPlaceholder.test(content)) continue;
  if (!block || block.quoted!==quoted) {
   block={quoted,lines:[]};
   blocks.push(block);
  }
  if (content.trim() || (block.lines.length && block.lines.at(-1)?.trim())) block.lines.push(content);
 }
 return blocks.filter(item=>item.lines.some(line=>line.trim()));
}

function splitTrailingPunctuation(raw:string) {
 let url=raw;
 while ((!/[?#]/.test(url) && /[.,;!]$/.test(url)) ||
   (url.endsWith(')') && url.split(')').length>url.split('(').length) ||
   (url.endsWith(']') && url.split(']').length>url.split('[').length)) {
  url=url.slice(0,-1);
 }
 return {url,tail:raw.slice(url.length)};
}

function renderLine(line:string) {
 const nodes=[];
 let cursor=0;
 for (const match of line.matchAll(webLink)) {
  const index=match.index;
  const {url,tail}=splitTrailingPunctuation(match[0]);
  let target:URL;
  try {target=new URL(url);} catch {continue;}
  if (!['https:','http:'].includes(target.protocol) || target.username || target.password) continue;
  const prefix=line.slice(cursor,index);
  // Plain-text mail templates commonly print a CTA label followed by its URL.
  const action=cursor===0 && prefix.trim().length<=48 &&
   /^(?:view|open|download|review|visit|access|submit|respond|accept|decline)\b/i.test(prefix.trim());
  const label=action?prefix.trim():(url.length>70?target.hostname:url);
  nodes.push(<Fragment key={index}>
   {action?prefix.match(/^\s*/)?.[0]:prefix}
   <a href={url} target="_blank" rel="noopener noreferrer" aria-label={action?label+' ('+target.hostname+')':undefined}>{label}</a>{tail}
  </Fragment>);
  cursor=index+match[0].length;
 }
 return <>{nodes}{line.slice(cursor)}</>;
}

export function MessageText({body}:{body:string}) {
 const blocks=splitMessage(body);
 const hasUnquoted=blocks.some(block=>!block.quoted);
 if (!blocks.length) return <>This email has no text body.</>;
 return <div className="mail-text">{blocks.map((block,index)=>{
  const content=<div className="mail-text-lines">{block.lines.map((line,lineIndex)=>
   <Fragment key={lineIndex}>{lineIndex>0?'\n':null}{renderLine(line)}</Fragment>
  )}</div>;
  if (!block.quoted) return <Fragment key={index}>{content}</Fragment>;
  if (!hasUnquoted) return <blockquote className="mail-quote" key={index}>{content}</blockquote>;
  return <details className="mail-quote-toggle" key={index}>
   <summary>Show quoted message</summary>
   <blockquote className="mail-quote">{content}</blockquote>
  </details>;
 })}</div>;
}
