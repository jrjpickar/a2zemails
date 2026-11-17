import {useEffect,useRef,useState,type PointerEvent as ReactPointerEvent} from 'react';

export function useComposePosition(draftId?:string) {
 const panel=useRef<HTMLFormElement>(null);
 const drag=useRef<{id:number;x:number;y:number;left:number;top:number}|null>(null);
 const [position,setPosition]=useState<{left:number;top:number}|null>(null);

 function clamp(left:number,top:number) {
  const rect=panel.current?.getBoundingClientRect();
  if(!rect) return {left,top};
  const maxLeft=Math.max(0,window.innerWidth-rect.width);
  const maxTop=Math.max(0,window.innerHeight-rect.height);
  return {left:Math.min(maxLeft,Math.max(0,left)),top:Math.min(maxTop,Math.max(0,top))};
 }
 useEffect(()=>{setPosition(null);drag.current=null},[draftId]);
 useEffect(()=>{
  const resize=()=>setPosition(value=>value&&clamp(value.left,value.top));
  window.addEventListener('resize',resize);
  return ()=>window.removeEventListener('resize',resize);
 },[]);
 function begin(event:ReactPointerEvent<HTMLElement>) {
  if (window.innerWidth<=760 || event.button!==0 || (event.target as HTMLElement).closest('button')) return;
  const rect=panel.current?.getBoundingClientRect();
  if (!rect) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  drag.current={id:event.pointerId,x:event.clientX,y:event.clientY,left:rect.left,top:rect.top};
 }
 function move(event:ReactPointerEvent<HTMLElement>) {
  const point=drag.current;
  if (point?.id!==event.pointerId) return;
  setPosition(clamp(point.left+event.clientX-point.x,point.top+event.clientY-point.y));
 }
 function end(event:ReactPointerEvent<HTMLElement>) {
  if (drag.current?.id===event.pointerId) drag.current=null;
 }
 return {panel,position,begin,move,end,reset:()=>setPosition(null)};
}
