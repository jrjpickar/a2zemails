/// <reference types="vite/client" />
import {scopedMailMatches,searchTerms} from './mail-search-scope.mjs';
import {SearchFilters,defaultSearchFilters,type SearchFiltersValue} from './search-filters';
import {downloadMailCsv,mailCsvHeader,mailCsvRows} from './mail-csv.mjs';
import React,{useEffect,useMemo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {LayoutDashboard,ClipboardList,FolderKanban,Calculator,FileQuestion,HardHat,Receipt,Inbox,Send,FileText,Archive,Trash2,ShieldAlert,Plus,Search,SlidersHorizontal,PanelLeft,ChevronDown,ChevronLeft,Star,Paperclip,Reply,ReplyAll,Forward,MoreHorizontal,ArrowUpRight,Mail,Clock3,X,Check,Download,RotateCcw,MailOpen,Menu,ArrowRight,Moon,Palette,Settings2,Users,Sparkles} from 'lucide-react';
import {categories,projects,seed,classify,matchProject,searchMail,initialState,threadFor,rowActions,appendSignature,dashboardQueues} from './model.mjs';
import {RichMail,type MailBody} from './rich-mail';
import {uploadLargeFile,type LargeFile} from './large-upload';
import {AttachmentPreview,type AttachmentSource,type MailAttachment,type ForwardedAttachment} from './attachment-preview';
import {useComposePosition} from './compose-position';
import {MessageText} from './message-text';
import {AskAi,type AskRunner,type AskSource} from './ask-ai';
import {BidImportReport} from './bid-import-report';
import {RecipientInput,type Contact} from './recipient-input';
import {AdminConsole} from './admin-console';
import {rememberedSession,hostedRequest,hostedStream,MailboxLogin,requestHighLevelContext,highLevelSignInNotice} from './hosted';
import './style.css';
import './theme.css';
const temperatures=[['cold','Cold'],['warm','Warm'],['hot','Hot'],['vip','VIP']] as const;
type Temperature=typeof temperatures[number][0];
type SearchCursor={path:string;before:number|null;generation:string|null};
type Delivery={status:string;recipients:{address:string;action:string;status?:string;detail?:string;at?:string}[];updatedAt:string|null};
type SendReceipt={subject:string;to:string[];accepted:string[];rejected:string[];sentSaved:boolean;live:boolean;id:string;thread:boolean};
type Message={id:string;older?:boolean;delivery?:Delivery;temperature?:Temperature;thread:string;name:string;company:string;subject:string;date:string;body:string;sentSignatureImage?:string;needsBody?:boolean;files:string[];attachments?:MailAttachment[];due?:string;from:string;to:string;cc:string;bcc?:string;category:string;project:string;folder:string;unread:boolean;star:boolean;previousFolder?:string;headers:{messageId:string;references:string[]}};
type Upload={name:string;data:string;size?:number};
type StagedUpload={id:string;name:string;size:number};
type SavedDraft={id:string;to:string;subject:string;updatedAt:string};
type Draft={id:string;to:string;cc:string;bcc?:string;subject:string;body:string;files:string[];thread?:string;parent?:Pick<Message,'project'|'headers'>;identity:string;includeSignature?:boolean;attachments?:Upload[];stagedAttachments?:StagedUpload[];forwardedAttachments?:ForwardedAttachment[];largeFiles?:LargeFile[]};
function draftHasContent(draft:Draft) {
 return Boolean(draft.to||draft.cc||draft.bcc||draft.subject||draft.body||draft.files.length||
  draft.attachments?.length||draft.stagedAttachments?.length||draft.forwardedAttachments?.length||draft.largeFiles?.length);
}
const draftStoragePrefix=(account:string)=>'a2z-draft:'+account+':';
function recoverDrafts(account:string):Draft[] {
 try {
  const prefix=draftStoragePrefix(account);
  return Object.keys(sessionStorage).filter(key=>key.startsWith(prefix)).map(key=>JSON.parse(sessionStorage.getItem(key)||'null')).filter(Boolean);
 } catch { return []; }
}
function clearDraftRecovery(draft:Draft, payload?:string) {
 try {
  const key=draftStoragePrefix(draft.identity)+draft.id;
  if (payload===undefined||sessionStorage.getItem(key)===payload) sessionStorage.removeItem(key);
 } catch {}
}
type State={mail:Message[];rules:Record<string,string>;drafts:Draft[];signatures?:Record<string,string>;signatureImages?:Record<string,string>};
const samples=seed as Message[];
const demo='operations@a2z.example';
const identities=[demo,'estimating@a2z.example'];
const groups=[
 {label:'WORKSPACE', links:[['Command Center',LayoutDashboard],['Bid Invitations',ClipboardList],['Active Projects',FolderKanban],['Estimating',Calculator],['RFIs & Change Orders',FileQuestion],['Dispatch',HardHat],['Invoices',Receipt],['General',Mail]]},
 {label:'MAILBOX',links:[['Inbox',Inbox],['Starred',Star],['Sent',Send],['Drafts',FileText],['Archive',Archive],['Trash',Trash2],['Spam',ShieldAlert]]}
] as const;
const tags:Record<string,string>={'Bid Invitations':'Bid Invitation','Estimating':'Estimating','RFIs & Change Orders':'RFI / Change Order','Dispatch':'Dispatch','Invoices':'Invoices','General':'General'};
const tones:Record<string,string>={'Bid Invitations':'gold','Estimating':'purple','RFIs & Change Orders':'blue','Dispatch':'green','Invoices':'rose','General':'gray'};
const storageKey='a2z-sandbox-v1';
const liveSignatureKey = 'a2z-ionos-signatures';
const localToken = document.querySelector<HTMLMetaElement>('meta[name="a2z-live-token"]')?.content;
const defaultSignature = 'A2Z Construction Services';

function getState(liveToken?:string):State {
 if (liveToken) {
  let signatures;
  try { signatures = JSON.parse(localStorage.getItem(liveSignatureKey)||'{}'); } catch {}
  return {mail:[],rules:{},drafts:[],signatures};
 }
 try {
  const raw = localStorage.getItem(storageKey);
  if (raw) {
   const saved: State = JSON.parse(raw);
   saved.mail = saved.mail.map(message => message.category === 'Billing' ? {...message, category:'Invoices'} : message);
   saved.rules = Object.fromEntries(Object.entries(saved.rules).map(([domain, category]) =>
    [domain, category === 'Billing' ? 'Invoices' : category]));
   return saved;
  }
 } catch {}
 return initialState() as State;
}
async function localRequest(path:string, body?:object, signal?:AbortSignal) {
 const response = await fetch('/api/ionos/'+path, {
  signal,
  method:body?'POST':'GET',
  headers:{'X-A2Z-Session':localToken||'', ...(body?{'Content-Type':'application/json'}:{})},
  body:body?JSON.stringify(body):undefined,
  cache:'no-store'
 });
 const data = await response.json();
 if (!response.ok||data.error) throw new Error(data.error || 'Unable to reach IONOS.');
 return data;
}
const day=(v:string)=>new Date(v).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
const messageDate=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric'});
const messageTime=new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit'});
const fullMessageDate=new Intl.DateTimeFormat('en-US',{dateStyle:'full',timeStyle:'long'});
function MessageTimestamp({value}:{value:string}) {
 const date=new Date(value);
 if (Number.isNaN(date.getTime())) return null;
 return <time dateTime={date.toISOString()} title={fullMessageDate.format(date)}>
  {messageTime.format(date)} · {messageDate.format(date)}
 </time>;
}
const deliveryLabels:Record<string,[string,string]>={sent:['Sent','gray'],delivered:['Delivered','green'],'partly delivered':['Partly delivered','green'],
 delayed:['Delayed','gold'],bounced:['Bounced','rose'],'partly bounced':['Partly bounced','rose']};
function deliveryTitle(delivery?:Delivery) {
 if (!delivery||!delivery.recipients.length) return 'Accepted by IONOS. Shows Delivered when the recipient server confirms. Some servers never confirm.';
 return delivery.recipients.map(item=>(item.address||'All recipients')+': '+item.action+(item.status?' ('+item.status+')':'')+(item.detail?' '+item.detail:'')).join('\n');
}
const initials=(name:string)=>name.split(' ').slice(0,2).map(s=>s[0]).join('');
const mailboxName=(email:string)=>{const words=(email.split('@')[0]||'').split(/[._\-+]+/).filter(Boolean);return words.length?words.map(word=>word[0].toUpperCase()+word.slice(1).toLowerCase()).join(' '):'A2Z user';};
type Profile={name:string;admin:boolean};
type OlderCursor={path:string;generation:string;before:number};
const avatarColors=['sand','lavender','sage','peach','sky'];
function App({liveToken,onSignOut,largeUploads=false,contactLookup=false}:{liveToken?:string;onSignOut?:(error?:unknown)=>Promise<void>;largeUploads?:boolean;contactLookup?:boolean}){
 const [knownContacts,setKnownContacts]=useState<Contact[]>([]);
 const [mailFeatures,setMailFeatures]=useState({askAi:false,temperatureFolders:false,temperatureUnavailable:false});
 const [profile,setProfile]=useState<Profile|null>(null);
 const [sendReceipt,setSendReceipt]=useState<SendReceipt|null>(null);
 const [aiWriting,setAiWriting]=useState('');
 const [aiUndo,setAiUndo]=useState<{draft:string;body:string}|null>(null);
 const [aiPrompt,setAiPrompt]=useState('');
 const [aiWriteOpen,setAiWriteOpen]=useState(false);
 const [smartReplies,setSmartReplies]=useState<{id:string;replies:string[]}|null>(null);
 const [smartBusy,setSmartBusy]=useState(false);
 useEffect(()=>{if(!sendReceipt||sendReceipt.rejected.length)return;const timer=window.setTimeout(()=>setSendReceipt(null),9000);return()=>window.clearTimeout(timer);},[sendReceipt]);
 const [teamOpen,setTeamOpen]=useState(false);
 const [olderCursors,setOlderCursors]=useState<Record<string,OlderCursor|null>>({});
 const [olderBusy,setOlderBusy]=useState(false);
 const lookupContacts=React.useCallback(async(query:string,signal:AbortSignal):Promise<Contact[]>=>{
  const result=await hostedRequest('contacts',{query},liveToken,signal);
  return result.contacts||[];
 },[liveToken]);
 async function liveRequest(path:string, body?:object, signal?:AbortSignal) {
  if (!onSignOut) return localRequest(path,body,signal);
  try { return await hostedRequest(path,body,liveToken,signal); }
  catch (error) {
   const failure=error as {status?:number};
   if (failure.status===401) void onSignOut(error).catch(()=>setToast('Your session ended. Reload to sign in again.'));
   throw error;
  }
 }
 const [state,setState]=useState<State>(()=>getState(liveToken)),[nav,setNav]=useState('Inbox'),[selected,setSelected]=useState('mail-0'),[query,setQuery]=useState(''),[filter,setFilter]=useState('All mail'),[projectFilter,setProjectFilter]=useState(''),[marked,setMarked]=useState<string[]>([]),[compose,setCompose]=useState<string|null>(null),[preview,setPreview]=useState<string|null>(null),[livePreview,setLivePreview]=useState<AttachmentSource|null>(null),[toast,setToast]=useState(''),[menu,setMenu]=useState(''),[mobileRead,setMobileRead]=useState(false),[side,setSide]=useState(false),[help,setHelp]=useState(false),[limit,setLimit]=useState(liveToken?200:60);
 const [theme,setTheme]=useState(() => {
  try { return localStorage.getItem('a2z-theme')==='color'?'color':'dark'; }
  catch { return 'dark'; }
 });
 const [signatureImageForm,setSignatureImageForm]=useState<Record<string,string>>({});
 const [signatureForm,setSignatureForm]=useState<Record<string,string>|null>(null);
 const [account,setAccount]=useState('');
 const [mailFolders,setMailFolders]=useState<string[]>([]);
 const [connection,setConnection]=useState(liveToken?'Connecting to IONOS…':'');
 const [mailboxIssue,setMailboxIssue]=useState('');
 const [sending,setSending]=useState(false);
 const [deleteTarget,setDeleteTarget]=useState<Message|null>(null);
 const hosted=Boolean(onSignOut);
 const [saving,setSaving]=useState(false);
 const [draftSaveState,setDraftSaveState]=useState('');
 const lastSaved=React.useRef('');
 const reopenedDraft=React.useRef('');
 const latestDraftPayload=React.useRef('');
 const autoSave=React.useRef<Promise<void>|null>(null);
 const [draggingFiles,setDraggingFiles]=useState(false);
 const [uploadProgress,setUploadProgress]=useState('');
 const [savedDrafts,setSavedDrafts]=useState<SavedDraft[]>([]);
 const [draftSyncError,setDraftSyncError]=useState('');
 const writing=React.useRef(false);
 const attachmentPicker=React.useRef<HTMLInputElement>(null);
 const linkPicker=React.useRef<HTMLInputElement>(null);
 const largeUploadAbort=React.useRef<AbortController|null>(null);
 const prefsVersion=React.useRef(0);
 const sendingRef=React.useRef(false);
 const senderIdentities=liveToken?(account?[account]:[]):identities;
 const signatureFor=(identity:string)=>state.signatures?.[identity] ?? defaultSignature;
 const draftSignature=(d:Draft)=>d.includeSignature===false?'':signatureFor(d.identity);

 useEffect(() => {
  document.documentElement.dataset.theme=theme;
  try { localStorage.setItem('a2z-theme',theme); } catch {}
 },[theme]);

 const [mailSearch,setMailSearch]=useState<{query:string;mail:Message[];next:SearchCursor[]}>({query:'',mail:[],next:[]});
 const [searchBusy,setSearchBusy]=useState(false);
 const [searchError,setSearchError]=useState('');
 const [searchFilters,setSearchFilters]=useState<SearchFiltersValue>(defaultSearchFilters);
 const searchRevision=React.useRef(0);
 const searchAbort=React.useRef<AbortController|null>(null);
 const refreshing = React.useRef<Promise<void>|null>(null);
 const mailboxRevision = React.useRef(0);
 const moving = React.useRef(new Set<string>());
 function refreshMailbox() {
  if (refreshing.current) return refreshing.current;
  const revision=mailboxRevision.current;
  const pending=fetchMailbox(revision).finally(()=>{refreshing.current=null});
  refreshing.current=pending;
  return pending;
 }
 async function fetchMailbox(revision:number) {
  setConnection('Connecting to IONOS…');
  setMailboxIssue('');
  try {
   type MailboxResponse={email:string;mail:Message[];contacts?:Contact[];folders?:string[];askAi?:boolean;temperatureFolders?:boolean;temperatureUnavailable?:boolean;profile?:Profile;unavailableFolders?:string[];inboxOnly?:boolean};
   let data:MailboxResponse;
   let fullRefreshReference='';
   try {
    data=await liveRequest('mail',undefined,hosted?AbortSignal.timeout(20000):undefined);
    if (!Array.isArray(data.mail) || typeof data.email!=='string') throw new Error('The mailbox service returned an incomplete response.');
   } catch (error) {
    const failure=error as {status?:number;requestId?:string};
    if (!hosted || revision!==mailboxRevision.current || (failure.status && failure.status<500)) throw error;
    fullRefreshReference=failure.requestId||'';
    setConnection('Loading recent Inbox messages…');
    data=await liveRequest('mail-inbox',undefined,AbortSignal.timeout(24000));
   }
   if (revision!==mailboxRevision.current) return;
   if (!Array.isArray(data.mail) || typeof data.email!=='string') throw new Error('The mailbox service returned an incomplete response.');
   if (!data.inboxOnly) {
    setKnownContacts(data.contacts||[]);
    setMailFeatures({askAi:!!data.askAi,temperatureFolders:!!data.temperatureFolders,temperatureUnavailable:!!data.temperatureUnavailable});
   } else {
    setMailFeatures(previous=>({...previous,askAi:!!data.askAi}));
   }
   setAccount(data.email);
   if (data.profile) setProfile({name:data.profile.name,admin:!!data.profile.admin});
   if (!data.inboxOnly) setMailFolders((data.folders||[]).filter(folder=>!groups[1].links.some(([name])=>name===folder))
    .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'})));
   const fetched=new Set(data.mail.map(message=>message.id));
   const unavailable=new Set(data.unavailableFolders);
   setState(previous=>({...previous,mail:[
    ...data.mail,
    // Keep older pages the user loaded. Refresh only replaces the recent window.
    ...previous.mail.filter(message=>(message.older||unavailable.has(message.folder)||(data.inboxOnly&&message.folder!=='Inbox'))&&!fetched.has(message.id)&&!message.id.startsWith('out-')),
    ...previous.mail.filter(message=>message.folder==='Sent' && message.id.startsWith('out-') &&
      !data.mail.some(fetched=>fetched.headers.messageId===message.headers.messageId))
   ]}));
   setSelected(current=>{
    if (current.startsWith('out-')) return data.mail.find(message=>message.headers.messageId.startsWith('<'+current+'@'))?.id||current;
    return data.mail.some(message=>message.id===current)?current:data.mail[0]?.id||'';
   });
   setConnection(data.inboxOnly?'Recent Inbox only':'IONOS connected');
   if (data.inboxOnly) setMailboxIssue('Recent Inbox messages loaded. Retry to refresh all folders.'+
    (fullRefreshReference?' (Reference: '+fullRefreshReference+')':''));
   else if (unavailable.size) setMailboxIssue('Some folders could not load: '+[...unavailable].join(', ')+'.');
  } catch (error) {
   if (revision!==mailboxRevision.current) return;
   setConnection('Mailbox refresh failed');
   const requestId=(error as {requestId?:string})?.requestId;
   const message=error instanceof Error ? error.message : 'Unable to connect to IONOS.';
   setMailboxIssue(message+(requestId?' (Request ID: '+requestId+')':''));
  }
 }
 useEffect(()=>{if(liveToken)void refreshMailbox()},[]);
 async function syncPreferences() {
  if (!hosted||!account) return;
  const version=++prefsVersion.current;
  try {
   const data:{drafts:SavedDraft[];signature:string|null;signatureImage?:string|null}=await liveRequest('preferences');
   if (prefsVersion.current!==version) return;
   setSavedDrafts(data.drafts);
   if (data.signature!==null) setState(previous=>({...previous,signatures:{...previous.signatures,[account]:data.signature as string},signatureImages:{...previous.signatureImages,[account]:data.signatureImage||''}}));
   setDraftSyncError('');
  } catch(error) {
   if (prefsVersion.current===version) setDraftSyncError(error instanceof Error?error.message:'Could not load saved drafts.');
  }
 }
 useEffect(()=>{
  if (!account||!liveToken) return;
  const recovered=recoverDrafts(account);
  if (recovered.length) setState(previous=>({...previous,drafts:recovered}));
  if (hosted) void syncPreferences();
 },[account,hosted,liveToken]);
 const mail=state.mail;
 const mailRef=React.useRef(mail);
 mailRef.current=mail;
 const draft=state.drafts.find(d=>d.id===compose);
 const composeWindow=useComposePosition(draft?.id);
 const draftPayload=draft?JSON.stringify(draft):'';
 const isSavedDraft=Boolean(draft&&(reopenedDraft.current===draft.id||savedDrafts.some(item=>item.id===draft.id)));
 const shouldSaveDraft=Boolean(draft&&(isSavedDraft||draftHasContent(draft)));

 React.useLayoutEffect(()=>{
  latestDraftPayload.current=draftPayload;
  if (!liveToken||!draft) return;
  if (!shouldSaveDraft) {
   clearDraftRecovery(draft);
   return;
  }
  if (hosted&&lastSaved.current===draftPayload) return;
  try { sessionStorage.setItem(draftStoragePrefix(draft.identity)+draft.id,draftPayload); }
  catch { setDraftSaveState('Browser recovery unavailable'); }
 },[draftPayload,shouldSaveDraft,liveToken,hosted]);

 async function persistDraft(current:Draft) {
  const payload=JSON.stringify(current);
  if (lastSaved.current===payload) return;
  reopenedDraft.current=current.id;
  ++prefsVersion.current;
  await liveRequest('draft',current);
  lastSaved.current=payload;
  clearDraftRecovery(current,payload);
  const summary={id:current.id,subject:current.subject,to:current.to,updatedAt:new Date().toISOString()};
  setSavedDrafts(previous=>[summary,...previous.filter(item=>item.id!==current.id)]);
 }

 useEffect(()=>{
  if (!hosted || !draft || !shouldSaveDraft || saving || sending || lastSaved.current===draftPayload) return;
  setDraftSaveState('Unsaved changes');
  const timer=window.setTimeout(()=>{
   if (writing.current||sendingRef.current) return;
   const pending=(autoSave.current||Promise.resolve()).then(()=>{
    if (writing.current||sendingRef.current) return;
    setDraftSaveState('Saving draft…');
    return persistDraft(draft).then(()=>{
     if (latestDraftPayload.current===draftPayload) setDraftSaveState('Draft saved');
    }).catch(()=>{
     if (latestDraftPayload.current===draftPayload) setDraftSaveState('Draft not saved · use Save draft to retry');
    });
   });
   autoSave.current=pending;
   void pending.finally(()=>{if(autoSave.current===pending)autoSave.current=null});
  },700);
  return ()=>window.clearTimeout(timer);
 },[draftPayload,hosted,shouldSaveDraft,saving,sending]);

 const openDrafts=state.drafts.filter(item=>item.id!==draft?.id||shouldSaveDraft);
 const draftList=hosted?[...openDrafts,...savedDrafts.filter(item=>!openDrafts.some(open=>open.id===item.id))]:openDrafts;
 const [allSelected,setAllSelected]=useState(false);
 const [exportCount,setExportCount]=useState<number|null>(null);
 const stopExport=React.useRef(false);
 const [exportPaused,setExportPaused]=useState(false);
 const pauseExport=React.useRef(false);
 const resumeExport=React.useRef<(()=>void)|null>(null);
 const exportParts=React.useRef<{parts:string[];view:string;count:number}|null>(null);
 function setExportPause(paused:boolean) {
  pauseExport.current=paused;
  setExportPaused(paused);
  if (!paused) {resumeExport.current?.();resumeExport.current=null;}
 }
 async function waitWhilePaused() {
  while (pauseExport.current&&!stopExport.current) await new Promise<void>(resolve=>{resumeExport.current=resolve;});
 }
 function downloadExportSoFar() {
  const current=exportParts.current;
  if (!current) return;
  downloadMailCsv(current.parts.slice(),current.view+'-partial');
  setToast('Downloaded '+current.count+' email'+(current.count===1?'':'s')+' exported so far.');
 }
 function cancelExport() {stopExport.current=true;setExportPause(false);}
 const exportRunning=React.useRef(false);

 const inbox=mail.filter(m=>m.folder==='Inbox');
 const unreadIncoming=inbox.filter(m=>m.unread).length;
 const queues=dashboardQueues(mail) as Record<'bids'|'urgent'|'unanswered'|'invoices',Message[]>;
 const contacts=liveToken?knownContacts:samples.map(m=>({address:m.from,name:m.name}));
 const userName=profile?.name||mailboxName(account||demo);
 useEffect(()=>{if(liveToken)return;try{localStorage.setItem(storageKey,JSON.stringify(state))}catch{setToast('Browser storage is full. Changes are available until you reload.')}},[state]);
 useEffect(()=>{if(!toast)return;let id=setTimeout(()=>setToast(''),3200);return()=>clearTimeout(id)},[toast]);
 const customFolderPrefix='folder:';
 const temperaturePrefix='temperature:';
 const temperatureName=temperatures.find(([value])=>nav===temperaturePrefix+value)?.[1];
 const viewName=temperatureName||(nav.startsWith(customFolderPrefix)?nav.slice(customFolderPrefix.length):nav);
 const physicalFolders:string[]=[...new Set([...groups[1].links.map(([name])=>name).filter(name=>name!=='Drafts'&&name!=='Starred'),...mailFolders])];
 const currentSearchFolder=temperatureName?'Inbox':physicalFolders.includes(viewName)?viewName:undefined;
 const selectedSearchFolder=searchFilters.folder==='current'?currentSearchFolder:
  searchFilters.folder.startsWith('folder:')?searchFilters.folder.slice(7):undefined;
 const relativeStart=new Date();
 if (searchFilters.period!=='any'&&searchFilters.period!=='custom') {
  relativeStart.setDate(relativeStart.getDate()-(Number(searchFilters.period)-1));
 }
 const fromDate=searchFilters.period==='custom'?searchFilters.start||undefined:
  searchFilters.period==='any'?undefined:
  new Date(relativeStart.getTime()-relativeStart.getTimezoneOffset()*60000).toISOString().slice(0,10);
 const scope={folder:selectedSearchFolder,field:searchFilters.field,fromDate,
  toDate:searchFilters.period==='custom'?searchFilters.end||undefined:undefined};
 const activeSearch=query.trim();
 const searchKey=JSON.stringify([activeSearch,scope]);
 const row=mail.find(m=>m.id===selected)||(mailSearch.query===searchKey?mailSearch.mail.find(m=>m.id===selected):undefined);
 const searchScopeLabel=[scope.folder||'All folders',searchFilters.period==='any'?'Any time':searchFilters.period==='custom'?
  (scope.fromDate||'Any start')+' to '+(scope.toDate||'Any end'):'Last '+searchFilters.period+' days',
  {text:'Headers and body',from:'Sender',subject:'Subject',body:'Message body'}[scope.field]].join(' · ');
 useEffect(()=>{setAllSelected(false);cancelExport();},[nav,query,filter,projectFilter,searchKey]);
 function inFolder(message:Message, folder:string) {
  if (folder.startsWith(temperaturePrefix)) return message.folder==='Inbox'&&message.temperature===folder.slice(temperaturePrefix.length);
  if (folder.startsWith(customFolderPrefix)) return message.folder===folder.slice(customFolderPrefix.length);
  if (folder==='Starred') return message.star&&!['Trash','Spam'].includes(message.folder);
  if (folder==='Active Projects') return Boolean(message.project)&&message.category!=='Bid Invitations'&&!['Trash','Spam'].includes(message.folder);
  if (categories.includes(folder)) return message.category===folder&&!['Trash','Spam'].includes(message.folder);
  return message.folder===folder;
 }
 // Ask AI: hosted mode streams from the server; local and sandbox modes return one answer.
 const runAsk:AskRunner=async(body,signal,onEvent)=>{
  const input=body as {question:string;openId?:string};
  if (hosted&&liveToken) return hostedStream('ask-ai',body,liveToken,signal,onEvent);
  const data=await askAboutMail(input.openId,input.question,[]);
  onEvent('replace',{text:data.answer});
  onEvent('done',{content:data.answer,model:data.model||null,sources:[],actions:[],degraded:data.excerptsOnly?'unavailable':null});
 };
 // Opens an email cited by Ask AI, even if it is older than the loaded window.
 function openSource(source:AskSource) {
  if (!mail.some(item=>item.id===source.id)) {
   const stub:Message={id:source.id,thread:source.id,name:source.fromName||source.from,company:'',subject:source.subject,date:source.date||new Date().toISOString(),
    body:source.excerpt||'',needsBody:true,files:[],from:source.from,to:'',cc:'',category:'General',project:'',folder:source.folder,unread:false,star:false,older:true,
    headers:{messageId:'',references:[]}};
   setState(previous=>({...previous,mail:[...previous.mail,stub]}));
  }
  const standard=groups[1].links.some(([name])=>name===source.folder);
  go(standard?source.folder:customFolderPrefix+source.folder);
  setSelected(source.id);
  setMobileRead(true);
 }
 async function askAboutMail(id:string|undefined,question:string,history:object[]) {
  if (liveToken) {
   // Like Gemini in Gmail: read attachments, the whole thread, or unread mail when the question asks for it.
   const extra:Record<string,unknown>={};
   const open=id?mail.find(item=>item.id===id):undefined;
   const meta=(items:Message[])=>Object.fromEntries(items.map(item=>[item.id,{subject:item.subject,from:item.from,to:item.to,date:item.date,folder:item.folder}]));
   if (open?.attachments?.length&&/\b(attach\w*|pdfs?|plans?|drawings?|documents?|files?|specs?|scope sheet|bid form)\b/i.test(question)) extra.includeAttachments=true;
   if (open&&/\b(thread|conversation|back and forth|history|all (?:the )?(?:emails|messages|replies))\b/i.test(question)) {
    const thread=(threadFor(mail,open) as Message[]).filter(item=>item.id!==open.id&&!item.id.startsWith('out-')).slice(-8);
    if (thread.length) Object.assign(extra,{contextIds:thread.map(item=>item.id),contextMeta:meta(thread),contextKind:'thread'});
   }
   if (!id&&/\b(catch me up|unread|what did i miss|new (?:mail|emails|messages))\b/i.test(question)) {
    const unread=mail.filter(item=>item.folder==='Inbox'&&item.unread).slice(0,15);
    if (unread.length) Object.assign(extra,{contextIds:unread.map(item=>item.id),contextMeta:meta(unread),contextKind:'unread'});
   }
   return liveRequest('ask-ai',{id,question,history,...extra});
  }
  const chosen=mail.find(item=>item.id===id)||mail.find(item=>searchMail(item,question));
  return {answer:chosen?chosen.subject+'\n\n'+chosen.body:'Select a sample email to see sandbox excerpts.',
   provider:'Sandbox' as const,excerptsOnly:true};
 }
 const localList=useMemo(()=>mail.filter(m=>{
  if (activeSearch) return scopedMailMatches(m,scope)&&searchTerms(activeSearch).every((term:string)=>{
   if (scope.field==='text'||/^(from|to|subject|project|date|attachment):/i.test(term)) return searchMail(m,term);
   const value=scope.field==='from'?m.from+' '+m.name:scope.field==='subject'?m.subject:m.body;
   return value.toLowerCase().includes(term.replaceAll('"','').toLowerCase());
  });
  const inView=inFolder(m,nav);
  return inView&&(!projectFilter||m.project===projectFilter)&&(filter==='All mail'||(filter==='Unread'&&m.unread)||(filter==='Starred'&&m.star)||(filter==='Attachments'&&m.files.length>0)||(filter==='Incoming'&&m.folder==='Inbox'&&m.unread)||(filter==='Urgent'&&queues.urgent.some(item=>item.id===m.id)));
 }).sort((a,b)=>b.date.localeCompare(a.date)),[mail,nav,activeSearch,searchKey,projectFilter,filter]);
 const unreadCounts=Object.fromEntries(groups.flatMap(group=>group.links.map(([label])=>[
  label,mail.filter(message=>message.unread&&inFolder(message,label)).length
 ])));
 const list=useMemo(()=>{
  if (!activeSearch||mailSearch.query!==searchKey) return localList;
  const unique=new Map(mailSearch.mail.map(item=>[item.id,item]));
  for (const item of localList) unique.set(item.id,item);
  return [...unique.values()].sort((a,b)=>b.date.localeCompare(a.date));
 },[localList,activeSearch,searchKey,mailSearch]);
 const olderFolder=liveToken&&!activeSearch&&nav!=='Drafts'&&nav!=='Command Center'&&nav!=='Starred'?(currentSearchFolder||'Inbox'):'';
 const olderCursor=useMemo(()=>{
  if (!olderFolder) return null;
  if (Object.hasOwn(olderCursors,olderFolder)) return olderCursors[olderFolder];
  let oldest:OlderCursor|null=null;
  for (const message of mail) {
   if (message.folder!==olderFolder) continue;
   const match=message.id.match(/^(.+):(\d+):(\d+)$/s);
   if (!match) continue;
   const uid=Number(match[3]);
   if (!oldest||uid<oldest.before) oldest={path:match[1],generation:match[2],before:uid};
  }
  return oldest;
 },[olderFolder,olderCursors,mail]);
 // Starred pulls flagged mail from every IONOS folder, not only the recent window.
 const starredLoad=React.useRef<Promise<void>|null>(null);
 function loadStarred() {
  if (!liveToken||starredLoad.current) return;
  starredLoad.current=(async()=>{
   let positions:SearchCursor[]|undefined;
   try {
    for (let page=0;page<8;page++) {
     const data:{mail:Message[];next:SearchCursor[]}=await liveRequest('mail-search',{query:'is:starred',positions});
     const rows=data.mail.map(message=>({...message,older:true}));
     setState(previous=>{
      const known=new Set(previous.mail.map(message=>message.id));
      return {...previous,mail:[...previous.mail,...rows.filter(message=>!known.has(message.id))]};
     });
     positions=data.next;
     if (!positions.length) break;
    }
   } catch(error) {setToast(error instanceof Error?error.message:'Could not load starred mail.');}
   finally {window.setTimeout(()=>{starredLoad.current=null;},60000);}
  })();
 }
 useEffect(()=>{if(nav==='Starred')loadStarred();},[nav]);
 async function loadOlder() {
  if (!olderFolder||!olderCursor||olderBusy) return;
  const folder=olderFolder;
  setOlderBusy(true);
  try {
   const data:{mail:Message[];next:OlderCursor|null}=await liveRequest('mail-older',olderCursor);
   const rows=data.mail.map(message=>({...message,older:true}));
   setState(previous=>{
    const known=new Set(previous.mail.map(message=>message.id));
    return {...previous,mail:[...previous.mail,...rows.filter(message=>!known.has(message.id))]};
   });
   setOlderCursors(previous=>({...previous,[folder]:data.next}));
   setLimit(value=>value+rows.length);
   const bids=rows.filter(message=>message.category==='Bid Invitations').length;
   setToast(rows.length?'Loaded '+rows.length+' older '+folder+' messages'+(bids?' ('+bids+' bid invitations)':''):'No older messages in '+folder);
  } catch(error) {
   if ((error as {status?:number}|null)?.status===409) setOlderCursors({});
   setToast(error instanceof Error?error.message:'Could not load older mail.');
  } finally {setOlderBusy(false);}
 }
 async function searchOlder(term:string,revision:number,positions?:SearchCursor[]) {
  searchAbort.current?.abort();
  const controller=new AbortController();
  searchAbort.current=controller;
  setSearchBusy(true);
  setSearchError('');
  let cursor=positions;
  let resultsSeen=0;
  const failed=new Set<string>();
  try {
   for (let page=0;page<4;page++) {
    const data:{mail:Message[];next:SearchCursor[];failed:string[];deferred:boolean}=await liveRequest(
     'mail-search',{query:term,scope,positions:cursor},controller.signal);
    if (revision!==searchRevision.current||controller.signal.aborted) return;
    setMailSearch(previous=>{
     const rows=new Map((positions||page)&&previous.query===searchKey?previous.mail.map(item=>[item.id,item]):[]);
     for (const item of data.mail) rows.set(item.id,item);
     return {query:searchKey,mail:[...rows.values()],next:data.next};
    });
    for (const path of data.failed||[]) failed.add(path);
    resultsSeen+=data.mail.length;
    cursor=data.next;
    if (!cursor.length||positions||failed.size&&!data.deferred||(!data.deferred&&resultsSeen)) break;
   }
   if (positions) setLimit(value=>value+100);
   if (failed.size) setSearchError('Some folders did not respond. Use Fetch more matching messages to keep searching.');
  } catch(error) {
   if (revision!==searchRevision.current||controller.signal.aborted) return;
   const status=(error as {status?:number}|null)?.status;
   setSearchError(status===429?'Too many searches at once. Wait a moment, then retry.':
    status===502||status===503||status===504?'IONOS search did not finish. The results already loaded are still available.':
    error instanceof Error?error.message:'Full mailbox search could not complete.');
  } finally {
   if (revision===searchRevision.current&&!controller.signal.aborted) setSearchBusy(false);
  }
 }
 useEffect(()=>{
  const revision=++searchRevision.current;
  setSearchBusy(false);
  setSearchError('');
  if (!liveToken||!activeSearch) return;
  const timeout=window.setTimeout(()=>void searchOlder(activeSearch,revision),500);
  return ()=>{window.clearTimeout(timeout);searchAbort.current?.abort();};
 },[activeSearch,searchKey,liveToken]);
 async function exportSelection(dashboard=false) {
  if (exportRunning.current) return;
  exportRunning.current=true;
  stopExport.current=false;
  setExportPause(false);
  setExportCount(0);
  const parts=[mailCsvHeader];
  let count=0;
  exportParts.current={parts,view:dashboard?'Inbox':activeSearch?'Search':viewName,count:0};
  const draftsView=nav==='Drafts'&&!activeSearch&&!dashboard;
  function append(rows:Message[]) {
   parts.push(mailCsvRows(rows));
   count+=rows.length;
   if (exportParts.current) exportParts.current.count=count;
   setExportCount(count);
  }
  const selection=activeSearch?list:localList;
  const matches=(message:Message)=>activeSearch||dashboard||(
   inFolder(message,nav)&&(!projectFilter||message.project===projectFilter)&&
   (filter==='All mail'||(filter==='Unread'&&message.unread)||(filter==='Starred'&&message.star)||
    (filter==='Attachments'&&message.files.length>0)||(filter==='Incoming'&&message.folder==='Inbox'&&message.unread)||
    (filter==='Urgent'&&dashboardQueues([message]).urgent.length>0))
  );
  try {
   if (draftsView) {
    for (const draft of draftList) {
     await waitWhilePaused();
     if (stopExport.current) return;
     const local=state.drafts.find(item=>item.id===draft.id);
     const details=local||(hosted?await liveRequest('draft&id='+encodeURIComponent(draft.id)):null);
     if (!details) throw new Error('A draft is unavailable. Refresh drafts and try again.');
     const {to,cc,bcc,subject,body,id}=details;
     append([{id,subject,to,cc,bcc,body,folder:'Drafts',from:details.identity||account||demo,date:'updatedAt' in draft?draft.updatedAt:'',
      files:[...(details.files||[]),...(details.attachments||[]).map((item:Upload)=>item.name),
       ...(details.stagedAttachments||[]).map((item:StagedUpload)=>item.name),
       ...(details.forwardedAttachments||[]).map((item:ForwardedAttachment)=>item.name),
       ...(details.largeFiles||[]).map((item:LargeFile)=>item.name)],
      unread:false,star:false} as Message]);
    }
   } else if (!liveToken) append(dashboard?inbox:selection);
   else {
    const {folders}:{folders:{path:string;folder:string}[]}=await liveRequest('mail-export-folders');
    const chosen=folders.filter(item=>{
     if (activeSearch&&!dashboard) return !scope.folder||item.folder===scope.folder;
     if (dashboard||temperatureName) return item.folder==='Inbox';
     if (nav==='Active Projects'||nav==='Starred'||categories.includes(nav)) return true;
     return item.folder===viewName;
    });
    const currentById=new Map(mail.map(item=>[item.id,item]));
    for (const folder of chosen) {
     let positions:SearchCursor[]|undefined;
     do {
      await waitWhilePaused();
      if (stopExport.current) return;
      const data:{mail:Message[];next:SearchCursor[]}=await liveRequest('mail-export-page',{
       path:folder.path,query:dashboard?'':activeSearch,positions,temperature:!activeSearch&&Boolean(temperatureName),
       scope:activeSearch&&!dashboard?scope:undefined,
      });
      if (stopExport.current) return;
      append(data.mail.map(item=>{
       const current=currentById.get(item.id);
       return current?{...item,category:current.category,project:current.project,due:current.due}:item;
      }).filter(matches));
      positions=data.next;
      if (positions.length) await new Promise(resolve=>setTimeout(resolve,1200));
     } while(positions.length);
    }
   }
   if (!stopExport.current) {
    downloadMailCsv(parts,dashboard?'Inbox':activeSearch?'Search':viewName);
    setToast('Exported '+count+' email'+(count===1?'':'s')+'.');
   }
  } catch(error) {setToast(error instanceof Error?error.message:'CSV export could not complete.');}
  finally {exportRunning.current=false;exportParts.current=null;setExportPause(false);setExportCount(null);}
 }
 const currentRow=row&&list.some(m=>m.id===row.id)?row:undefined;
 const related=currentRow?threadFor(mail,currentRow) as Message[]:[];
 const newest=related.filter(m=>m.id!==currentRow?.id);
 const [bodies,setBodies]=useState<Record<string,MailBody|{error:string}>>({});
 const bodyRequests=React.useRef(new Map<string,Promise<MailBody>>());

 function loadBody(message:Message) {
  const cached=bodies[message.id];
  if (cached && 'body' in cached) return Promise.resolve(cached);
  const existing=bodyRequests.current.get(message.id);
  if (existing) return existing;
  if (cached) setBodies(previous=>{
   const next={...previous};
   delete next[message.id];
   return next;
  });
  const pending=liveRequest('body',{id:message.id}).then((result:MailBody)=>{
   setBodies(previous=>({...previous,[message.id]:result}));
   return result;
  }).catch(error=>{
   setBodies(previous=>({...previous,[message.id]:{error:error instanceof Error?error.message:'Could not load the message.'}}));
   throw error;
  }).finally(()=>bodyRequests.current.delete(message.id));
  bodyRequests.current.set(message.id,pending);
  return pending;
 }
 useEffect(()=>{
  if (currentRow?.needsBody) void loadBody(currentRow).catch(()=>{});
 },[currentRow?.id,currentRow?.needsBody]);

 function renderBody(message:Message) {
  const result=bodies[message.id];
  if (!message.needsBody) return <div className="body"><MessageText body={message.body}/>{message.sentSignatureImage&&<img className="signature-logo" src={message.sentSignatureImage} alt="Email signature"/>}</div>;
  if (result && 'error' in result) return <div className="body" role="status">{result.error} <button className="project-tag" onClick={()=>void loadBody(message).catch(()=>{})}>Retry</button></div>;
  if (!result) return <div className="body" role="status">Loading message from IONOS…</div>;
  return <div className="body">{result.html?<RichMail key={message.id} html={result.html} images={result.images} dark={theme==='dark'}/>:<MessageText body={result.body}/>}{result.truncated&&<p className="message-note">The text body is too long to display in full. Open this message in IONOS Webmail to read the rest.</p>}</div>;
 }

 function go(next:string){if(next==='Drafts')void syncPreferences();setNav(next);setQuery('');setFilter('All mail');setProjectFilter('');setMarked([]);setMenu('');setMobileRead(false);setSide(false);setLimit(liveToken&&next==='Inbox'?200:60)}
 async function change(ids:string[],patch:Partial<Message>) {
  if (liveToken) {
   const action=patch.folder?'move':patch.unread!==undefined?(patch.unread?'unread':'read'):(patch.star?'star':'unstar');
   let succeeded=0;
   const available=patch.folder?ids.filter(id=>!moving.current.has(id)):ids;
   if (!available.length) return false;
   if (patch.folder) available.forEach(id=>moving.current.add(id));
   try {
    for (const id of available) {
     await liveRequest('update',{id,action,destination:patch.folder});
     succeeded++;
     if (patch.folder) ++mailboxRevision.current;
     setState(previous=>({...previous,mail:patch.folder?previous.mail.filter(item=>item.id!==id):
      previous.mail.map(item=>item.id===id?rowActions(item,patch) as Message:item)}));
    }
   } catch(error) {
    setToast(error instanceof Error?error.message:'Mailbox action failed.');
   } finally {
    if (patch.folder) {
     available.forEach(id=>moving.current.delete(id));
     if (succeeded) {
      await refreshing.current;
      void refreshMailbox();
     }
    }
   }
   return succeeded===available.length;
  }
  setState(s=>({...s,mail:s.mail.map(m=>ids.includes(m.id)?rowActions(m,patch) as Message:m)}));
  return true;
 }
 function open(m:Message){setSelected(m.id);setMobileRead(true);setMenu('');if(m.unread&&filter==='All mail')void change([m.id],{unread:false})}
 async function move(ids:string[],folder:string) {
  setMenu('');
  if (!await change(ids,{folder})) return;
  setMarked([]);setMobileRead(false);
  setToast(folder==='Archive'?'Conversation archived':folder==='Trash'?'Moved to Trash':'Moved to '+folder);
 }
 async function deleteForever(message:Message) {
  if (message.folder!=='Trash') return;
  await performSave(async()=>{
   if (liveToken) {
    await liveRequest('update',{id:message.id,action:'delete-forever'});
    ++mailboxRevision.current;
   }
   setState(previous=>({...previous,mail:previous.mail.filter(item=>item.id!==message.id)}));
   setDeleteTarget(null);
   setMobileRead(false);
   setToast('Message deleted forever');
   if (liveToken) {
    await refreshing.current;
    void refreshMailbox();
   }
  });
 }
 function start(mode='new',m?:Message,prefill?:string){
  if(compose||(liveToken&&!account))return;
  if (mode==='Forward' && m?.needsBody) {
   const result=bodies[m.id];
   if (!result || 'error' in result) {
    void loadBody(m).catch(()=>{});
    setToast('Wait for the message to load before forwarding.');
    return;
   }
   if (result.truncated) {
    setToast('Open this message in IONOS Webmail to forward the complete text.');
    return;
   }
   m={...m,body:result.body};
  }
  const d:Draft={id:crypto.randomUUID(),to:m&&mode!=='Forward'?m.from:'',cc:mode==='Reply all'&&m?[m.to,m.cc].join(', ').split(',').map(s=>s.trim()).filter(s=>s&&!senderIdentities.includes(s)&&s!==m.from).join(', '):'',subject:m?(mode==='Forward'?'Fwd: ':'Re: ')+m.subject.replace(/^(Re: |Fwd: )+/i,''):'',body:prefill!==undefined?prefill:mode==='Forward'&&m?'\n\n---------- Forwarded message ----------\nFrom: '+m.from+'\nSubject: '+m.subject+'\n\n'+m.body:'',files:!liveToken&&mode==='Forward'&&m?[...m.files]:[],forwardedAttachments:liveToken&&mode==='Forward'&&m?m.attachments?.map(file=>({messageId:m.id,part:file.part,name:file.name})):undefined,thread:mode==='Forward'?undefined:m?.thread,parent:mode==='Forward'||!m?undefined:{headers:m.headers,project:m.project},identity:account||demo,includeSignature:true};
  setDraftSaveState('');
  setDraggingFiles(false);
  setState(s=>({...s,drafts:[...s.drafts,d]}));setCompose(d.id);setMenu('');
 }
 // Gemini-in-Gmail style writing help in Compose: Help me write, refine, proofread and translate, with undo.
 async function aiWrite(mode:string,instruction='') {
  if (!draft||aiWriting) return;
  setAiWriting(mode);
  try {
   const replyTo=draft.parent?mail.find(item=>item.headers.messageId===draft.parent?.headers.messageId&&!item.id.startsWith('out-'))?.id:undefined;
   const data:{body:string}=await liveRequest('ai-write',{mode,instruction,subject:draft.subject,body:draft.body.split('\n\n---------- Forwarded message')[0],replyToId:replyTo});
   const forwarded=draft.body.includes('\n\n---------- Forwarded message')?draft.body.slice(draft.body.indexOf('\n\n---------- Forwarded message')):'';
   setAiUndo({draft:draft.id,body:draft.body});
   edit({body:data.body+forwarded});
   if (mode==='write') {setAiPrompt('');setAiWriteOpen(false);}
  } catch(error) {setToast(error instanceof Error?error.message:'AI writing is unavailable.');}
  finally {setAiWriting('');}
 }
 async function suggestReplies(message:Message) {
  if (smartBusy) return;
  setSmartBusy(true);
  try {setSmartReplies({id:message.id,...await liveRequest('ai-replies',{id:message.id})});}
  catch(error) {setToast(error instanceof Error?error.message:'Suggested replies are unavailable.');}
  finally {setSmartBusy(false);}
 }
 function edit(patch:Partial<Draft>, fromUpload=false){if (!fromUpload&&(writing.current||sendingRef.current)) return;setState(s=>({...s,drafts:s.drafts.map(d=>d.id===compose?{...d,...patch}:d)}))}
 async function performSave(task:()=>Promise<void>) {
  if (writing.current||sendingRef.current) return;
  writing.current=true;
  setSaving(true);
  try { await task(); }
  catch (error) {setToast(error instanceof Error?error.message:'Could not save. Try again.');}
  finally {writing.current=false;setSaving(false);}
 }
 function closeDraft() {
  if (!draft||writing.current||sendingRef.current) return;
  if (!shouldSaveDraft) {
   if (liveToken) clearDraftRecovery(draft);
   setState(previous=>({...previous,drafts:previous.drafts.filter(item=>item.id!==draft.id)}));
   setCompose(null);
   return;
  }
  void performSave(async()=>{
   if (hosted) {
    await autoSave.current;
    await persistDraft(draft);
    setState(previous=>({...previous,drafts:previous.drafts.filter(item=>item.id!==draft.id)}));
   }
   setCompose(null);
   setToast(hosted?'Draft saved':liveToken?'Draft saved for this browser tab':'Draft saved locally');
  });
 }
 function reopenDraft(id:string) {
  if (compose) return;
  if (state.drafts.some(item=>item.id===id)) {
   reopenedDraft.current=id;
   lastSaved.current='';
   setDraftSaveState('');
   setCompose(id);
   return;
  }
  if (!hosted) return;
  void performSave(async()=>{
   const loaded:Draft=await liveRequest('draft&id='+encodeURIComponent(id));
   reopenedDraft.current=id;
   lastSaved.current=JSON.stringify(loaded);
   setDraftSaveState('Draft saved');
   setState(previous=>({...previous,drafts:[loaded,...previous.drafts.filter(item=>item.id!==id)]}));
   setCompose(id);
  });
 }
 function discard(id:string) {
  void performSave(async()=>{
   if (hosted) {
    await autoSave.current;
    ++prefsVersion.current;
    await liveRequest('draft',{id,discard:true});
    setSavedDrafts(previous=>previous.filter(item=>item.id!==id));
   }
   if (liveToken&&draft) clearDraftRecovery(draft);
   setState(previous=>({...previous,drafts:previous.drafts.filter(item=>item.id!==id)}));
   setCompose(null);
   setToast('Draft discarded');
  });
 }
 function openSignatures() {
  setSignatureImageForm({...state.signatureImages});
  setSignatureForm(Object.fromEntries(senderIdentities.map(identity=>[identity,signatureFor(identity)])));
  setMenu('');
 }
 function saveSignatures(event:React.FormEvent) {
  event.preventDefault();
  if (!signatureForm) return;
  void performSave(async()=>{
   if (hosted) {
    ++prefsVersion.current;
    await liveRequest('signature',{signature:signatureForm[account],image:signatureImageForm[account]||null});
   }
   const signatures={...state.signatures,...signatureForm};
   setState(previous=>({...previous,signatures,signatureImages:signatureImageForm}));
   if (liveToken&&!hosted) localStorage.setItem(liveSignatureKey,JSON.stringify(signatures));
   setSignatureForm(null);
   setToast('Email signature saved');
  });
 }
 function encodeFile(blob:Blob):Promise<string> {
  return new Promise((resolve,reject)=>{
   const reader=new FileReader();
   reader.onerror=()=>reject(new Error('Could not read the selected file.'));
   reader.onload=()=>resolve(String(reader.result).slice(String(reader.result).indexOf(',')+1));
   reader.readAsDataURL(blob);
  });
 }
 function addFiles(event:React.ChangeEvent<HTMLInputElement>,asLink=false) {
  const files=Array.from(event.currentTarget.files||[]);
  event.currentTarget.value='';
  attachFiles(files,asLink);
 }
 function attachFiles(files:File[],asLink=false) {
  if (!draft||!files.length||writing.current||sendingRef.current) return;
  const inline=draft.attachments||[];
  const staged=draft.stagedAttachments||[];
  const bytes=staged.reduce((sum,file)=>sum+file.size,0)+inline.reduce((sum,file)=>
   sum+(file.size??Math.floor(file.data.length*3/4)-(file.data.endsWith('==')?2:file.data.endsWith('=')?1:0)),0);
  const max=hosted?24:3;
  const incomingBytes=files.reduce((sum,file)=>sum+file.size,0);
  if (files.some(file=>!file.size||file.name.length>180)) {
   setToast('Choose non-empty files with names under 180 characters.');
   return;
  }
  if (asLink||bytes+incomingBytes>max*1024*1024) {
   if (!largeUploads) {
    setToast('Regular attachments can total up to '+max+' MB. Large-file links are not configured.');
    return;
   }
   const existing=draft.largeFiles||[];
   if (existing.length+files.length>10||existing.reduce((sum,file)=>sum+file.size,0)+incomingBytes>1024*1024*1024) {
    setToast('Download links can total up to 1 GB across 10 files.');
    return;
   }
   void performSave(async()=>{
    const controller=new AbortController();
    largeUploadAbort.current=controller;
    const complete=[...existing];
    try {
     for (const [index,file] of files.entries()) {
      setUploadProgress('Preparing file '+(index+1)+' of '+files.length+'…');
      complete.push(await uploadLargeFile(draft.id,file,liveRequest,percent=>{
       setUploadProgress('Uploading file '+(index+1)+' of '+files.length+' · '+percent+'%');
      },controller.signal));
      edit({largeFiles:[...complete]},true);
     }
     setToast('Download links added');
    } finally {largeUploadAbort.current=null;setUploadProgress('');}
   });
   return;
  }
  if (files.length+inline.length+staged.length+(draft.forwardedAttachments?.length||0)>10) {
   setToast('Choose up to 10 regular attachments.');
   return;
  }
  if (hosted&&inline.length) {setToast('Remove the older attachments before adding new files.');return;}
  void performSave(async()=>{
   if (!hosted) {
    const added=await Promise.all(files.map(async file=>({name:file.name,data:await encodeFile(file),size:file.size})));
    edit({attachments:[...inline,...added]},true);
    return;
   }
   const completed=[...staged];
   const chunkBytes=2*1024*1024;
   try {
    for (const [fileIndex,file] of files.entries()) {
     const descriptor={id:crypto.randomUUID(),name:file.name,size:file.size};
     const count=Math.ceil(file.size/chunkBytes);
     for (let index=0;index<count;index++) {
      setUploadProgress('Uploading '+(fileIndex+1)+' of '+files.length+' · '+Math.floor(100*index/count)+'%');
      const data=await encodeFile(file.slice(index*chunkBytes,(index+1)*chunkBytes));
      const payload={draftId:draft.id,file:descriptor,index,data};
      try {await liveRequest('upload',payload)}
      catch (error) {
       const status=(error as {status?:number}).status;
       if (status&&status<500) throw error;
       await liveRequest('upload',payload);
      }
     }
     completed.push(descriptor);
     edit({stagedAttachments:[...completed]},true);
    }
    setToast('Files attached');
   } finally {setUploadProgress('');}
  });
 }
 async function sendDraft(e:React.FormEvent){
  e.preventDefault();if(!draft||sendingRef.current||writing.current)return;
  const recipients=[draft.to,draft.cc,draft.bcc||''].flatMap(value=>value.split(/[,;]/)).map(value=>value.trim()).filter(Boolean);
  if(!recipients.length||recipients.length>50||recipients.some(s=>!/^\S+@[^@\s]+\.[^@\s]+$/.test(s))||!draft.subject.trim()||(!draft.body.trim()&&!draft.largeFiles?.length)){setToast('Enter valid recipients, a subject, and a message.');return}
  const id='out-'+draft.id;
  const body=appendSignature(draft.body,draftSignature(draft));
  const sentSignatureImage=draft.includeSignature===false?undefined:state.signatureImages?.[draft.identity];
  const references=draft.parent?[...draft.parent.headers.references,draft.parent.headers.messageId].filter(Boolean):[];
  let messageId='<'+id+'@a2z.example>';
  let rejected: string[] = [];
  let sentSaved=true;
  let accepted:string[]=[];
  let draftCleanupFailed=false;
  if(liveToken){
   sendingRef.current=true;
   setSending(true);
   try {
    await autoSave.current;
    const result=await liveRequest('send',{to:draft.to,cc:draft.cc,bcc:draft.bcc,subject:draft.subject,body,references,id,attachments:draft.attachments,stagedAttachments:draft.stagedAttachments,forwardedAttachments:draft.forwardedAttachments,largeFiles:draft.largeFiles,signatureImage:sentSignatureImage,savedDraft:hosted});
    messageId=result.messageId;
    rejected=result.rejected;
    accepted=result.accepted||[];
    sentSaved=result.sentSaved;
    draftCleanupFailed=result.draftCleanupFailed===true;
   } catch(error){
    setToast(error instanceof Error?error.message:'IONOS could not send this message.');
    return;
   } finally {
    sendingRef.current=false;
    setSending(false);
   }
  }
  const m:Message={id,thread:draft.thread||id,name:'A2Z Construction Services',company:'A2Z',subject:draft.subject,date:new Date().toISOString(),body,sentSignatureImage,files:[...draft.files,...(draft.attachments||[]).map(file=>file.name),...(draft.stagedAttachments||[]).map(file=>file.name),...(draft.forwardedAttachments||[]).map(file=>file.name)],from:draft.identity,to:draft.to,cc:draft.cc,bcc:draft.bcc,category:classify(draft.subject,draft.body,draft.identity,state.rules),project:draft.parent?.project||matchProject(draft.subject+' '+draft.body),folder:'Sent',unread:false,star:false,headers:{messageId,references}};
  if (liveToken) clearDraftRecovery(draft);
  if (!draftCleanupFailed) {
   ++prefsVersion.current;
   setSavedDrafts(previous=>previous.filter(item=>item.id!==draft.id));
  }
  setState(s=>({...s,mail:[m,...s.mail],drafts:s.drafts.filter(d=>d.id!==draft.id)}));setCompose(null);
  if (draftCleanupFailed) setToast('Message sent. Remove the saved draft manually.');
  setSendReceipt({subject:draft.subject,to:recipients,accepted:liveToken?accepted:recipients,rejected,sentSaved:liveToken?sentSaved:true,live:Boolean(liveToken),id,thread:Boolean(draft.thread)});
  if(!draft.thread){go('Sent');setSelected(id);setMobileRead(true)}
  // Swap the local copy for the IONOS Sent copy so its attachments can be opened.
  if (liveToken&&sentSaved) window.setTimeout(()=>{void (refreshing.current||Promise.resolve()).then(()=>refreshMailbox());},2500);
 }
 function refreshCurrentView() {
  if (liveToken) void refreshMailbox();
  else {setState(getState());setToast('Sandbox inbox refreshed');}
 }
 function receive(){const id=crypto.randomUUID(),s=samples[2];const subject='NTP — Riverside Warehouse field mobilization';const m:Message={...s,id,thread:id,subject,date:new Date().toISOString(),body:'Notice to proceed is approved. Please confirm the mobilization window with field operations.',category:classify(subject,'',s.from,state.rules),project:matchProject(subject),unread:true,star:false,files:[],headers:{messageId:'<'+id+'@a2z.example>',references:[]}};setState(s=>({...s,mail:[m,...s.mail]}));go('Inbox');setToast('Sample email received')}
 useEffect(()=>{function key(e:KeyboardEvent){if(e.key==='Escape'){if(livePreview)setLivePreview(null);else if(preview)setPreview(null);else if(deleteTarget){if(!saving)setDeleteTarget(null);}else if(signatureForm&&!saving)setSignatureForm(null);else if(compose&&!sending&&!saving)closeDraft();else if(help)setHelp(false);else {setMenu('');setMobileRead(false)}return}const editable=(e.target instanceof HTMLElement ? e.target : document.body).closest('input,textarea,select,[contenteditable="true"]');
  if(e.metaKey&&!e.ctrlKey&&!e.altKey){
   const letter=e.key.toLowerCase();
   if(letter==='r'&&e.shiftKey){
    e.preventDefault();
    refreshCurrentView();
    return;
   }
   if(!e.shiftKey&&!editable&&!compose&&!preview&&!livePreview&&!deleteTarget&&!help&&!signatureForm&&!teamOpen&&currentRow&&['r','f'].includes(letter)){
    e.preventDefault();
    start(letter==='r'?'Reply':'Forward',currentRow);
   }
   return;
  }
  if((e.target instanceof HTMLElement ? e.target : document.body).matches('input,textarea,select,button')||e.metaKey||e.ctrlKey||e.altKey||compose||preview||livePreview||deleteTarget||help||signatureForm||teamOpen)return;
 if(e.key==='c'){e.preventDefault();start()}if(e.key==='/'){e.preventDefault();document.getElementById('search')?.focus()}if(e.key==='?')setHelp(true);if(e.key==='e'&&currentRow)move([currentRow.id],'Archive');
 }document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key)});
 const tag=(m:Message)=><span className={'tag '+tones[m.category]}>{tags[m.category]}</span>;
 const project=projects.find(p=>p.id===currentRow?.project);
 function renderDraftFile(key:string,name:string,open:()=>void,remove:()=>void) {
  return <span className="draft-attachment" key={key}>
   <button type="button" onClick={open} aria-label={'Preview '+name}><FileText size={15}/><span>{name}</span></button>
   <button type="button" onClick={remove} disabled={saving||sending} aria-label={'Remove '+name}><X size={15}/></button>
  </span>;
 }
 // A message you just sent is a local copy until IONOS returns the Sent copy, which carries the real attachment parts.
 async function openSentAttachment(message:Message,name:string) {
  const find=()=>mailRef.current.find(item=>!item.id.startsWith('out-')&&item.folder==='Sent'&&
   item.headers.messageId===message.headers.messageId&&item.attachments?.some(file=>file.name===name));
  let copy=find();
  if (!copy) {
   setToast('Loading the Sent copy from IONOS…');
   await refreshing.current;
   await refreshMailbox();
   await new Promise(resolve=>setTimeout(resolve,50));
   copy=find();
  }
  const file=copy?.attachments?.find(item=>item.name===name);
  if (!copy||!file) {setToast('IONOS has not saved the Sent copy yet. Try again in a minute.');return;}
  setSelected(copy.id);
  setLivePreview({kind:'mail',id:copy.id,part:file.part,name:file.name,hosted});
 }
 function renderAttachments(messages:Message[]) {
  const cards=messages.flatMap(message=>liveToken
   ? (message.attachments?.length
    ? message.attachments.map(file=>({key:message.id+':'+file.part,name:file.name,message,open:()=>setLivePreview({kind:'mail',id:message.id,part:file.part,name:file.name,hosted})}))
    : message.files.map((name,index)=>({key:message.id+':file:'+index,name,message,open:()=>void openSentAttachment(message,name)})))
   : message.files.map((name,index)=>({key:message.id+':'+index,name,message,open:()=>setPreview(name)})));
  if (!cards.length) return null;
  return <section className="attachments thread-attachments"><h3><Paperclip size={15}/> Attachments <span>{cards.length}</span></h3>
   <div>{cards.map(({key,name,message,open})=><button type="button" key={key} onClick={open}>
    <span className="file-icon"><FileText size={19}/></span><span><b>{name}</b><small>{message.name} · <MessageTimestamp value={message.date}/></small></span><Download size={16}/>
   </button>)}</div>
  </section>;
 }
 async function pickSignatureImage(identity:string,event:React.ChangeEvent<HTMLInputElement>) {
  const file=event.currentTarget.files?.[0];
  event.currentTarget.value='';
  if (!file) return;
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)||file.size>256*1024||!file.size) {
   setToast('Choose a PNG, JPEG, GIF, or WebP under 256 KB.');
   return;
  }
  try {
   const data=await encodeFile(file);
   setSignatureImageForm(previous=>({...previous,[identity]:'data:'+file.type+';base64,'+data}));
  } catch {setToast('Could not read the signature image.');}
 }
 function replyButtons(message:Message) {
  return ([[Reply,'Reply'],[ReplyAll,'Reply all'],[Forward,'Forward']] as const).map(([Icon,label])=>
   <button key={label} onClick={()=>start(label,message)}><Icon size={18}/>{label}</button>);
 }
 useEffect(()=>{
  const viewport=window.visualViewport;
  if (!draft || !viewport) return;
  const update=()=>{
   document.documentElement.style.setProperty('--compose-height',viewport.height+'px');
   document.documentElement.style.setProperty('--compose-top',viewport.offsetTop+'px');
  };
  update();
  viewport.addEventListener('resize',update);
  viewport.addEventListener('scroll',update);
  return ()=>{
   viewport.removeEventListener('resize',update);
   viewport.removeEventListener('scroll',update);
   document.documentElement.style.removeProperty('--compose-height');
   document.documentElement.style.removeProperty('--compose-top');
  };
 },[Boolean(draft)]);
 return <div className={'app '+(mobileRead?'reading ':'')+(side?'sidebar-open':'')}>
 {side&&<button className="scrim" aria-label="Close navigation" onClick={()=>setSide(false)}/>}
 <aside className="sidebar">
 <div className="brand"><div className="mark">A<span>2</span>Z</div><div><strong>A2Z Construction</strong><small>OPERATIONS MAIL</small></div></div>
 <button className="compose" disabled={!!liveToken&&!account} onClick={()=>start()}><Plus size={19}/> Compose <kbd>C</kbd></button>
 <div className="nav">{groups.map(g=><section key={g.label}><h2>{g.label}</h2>{g.links.map(([label,Icon])=><button key={label} className={nav===label&&!query?'active':''} onClick={()=>go(label)}><Icon size={16}/><span>{label}</span>{label!=='Drafts'&&label!=='Command Center'&&label!=='Trash'&&label!=='Spam'&&unreadCounts[label]>0&&<b>{unreadCounts[label]}</b>}{label==='Drafts'&&draftList.length>0&&<b>{draftList.length}</b>}</button>)}</section>)}
 {mailFeatures.temperatureFolders&&<section><h2>CONTACT TEMPERATURE</h2>{mailFeatures.temperatureUnavailable&&<small className="temperature-unavailable" role="status">HighLevel unavailable. Refresh to retry.</small>}{temperatures.map(([value,label])=>{
  const key=temperaturePrefix+value;
  const count=inbox.filter(message=>message.temperature===value&&message.unread).length;
  return <button key={key} className={nav===key&&!query?'active':''} onClick={()=>go(key)}><FolderKanban size={16}/><span>{label}</span>{count>0&&<b>{count}</b>}</button>;
 })}</section>}
 {mailFolders.length>0&&<section><h2>FOLDERS</h2>{mailFolders.map(folder=>{
  const key=customFolderPrefix+folder;
  const count=mail.filter(message=>message.folder===folder&&message.unread).length;
  return <button key={key} className={nav===key&&!query?'active':''} onClick={()=>go(key)}><FolderKanban size={16}/><span>{folder}</span>{count>0&&<b>{count}</b>}</button>;
 })}</section>}</div>
 <div className="sidebar-end"><div className="env"><i/> {liveToken ? connection : 'Sandbox workspace'}</div><div className="profile"><div className="profile-avatar">{initials(userName).toUpperCase()}</div><div><b title={account||undefined}>{userName}</b><small>{profile?.admin?'Senior admin':'A2Z Construction'}</small></div>{profile?.admin&&hosted&&<button title="Admin console" aria-label="Admin console" onClick={()=>setTeamOpen(true)}><Users size={17}/></button>}<button title="Keyboard shortcuts" onClick={()=>setHelp(true)}><MoreHorizontal size={17}/></button></div></div>
 </aside>
 <main>
 <header className={'topbar'+((mailFeatures.askAi||!liveToken)?' topbar-with-ai':'')}><button className="icon nav-toggle" aria-label="Toggle navigation" onClick={()=>setSide(!side)}><Menu size={20}/></button><div className="crumb"><PanelLeft size={16}/> <span>Workspace</span><span className="slash">/</span><b>{query?'Search':viewName}</b></div>{(mailFeatures.askAi||!liveToken)&&<AskAi toolbar prefill={query} live={Boolean(liveToken&&hosted)} run={runAsk}
  request={hosted?(action,body)=>liveRequest(action,body):undefined}
  context={{openId:currentRow&&!currentRow.id.startsWith('out-')?currentRow.id:undefined,openSubject:currentRow?.subject,openCategory:currentRow?.category,view:query?'Search':viewName,folder:currentSearchFolder}}
  onOpenSource={openSource} onUseReply={currentRow&&!currentRow.id.startsWith('out-')?text=>start('Reply',currentRow,text):undefined}/>}<div className="search">
  <button className="icon search-filter-trigger" type="button" title="Search filters" aria-label="Search filters"
   aria-expanded={menu==='search-filters'} onClick={()=>setMenu(menu==='search-filters'?'':'search-filters')}><SlidersHorizontal size={17}/></button>
  <input id="search" placeholder="Search mail, projects, attachments…" value={query} onChange={e=>{setQuery(e.target.value);setMobileRead(false);setLimit(60)}}/>{query?<button className="icon" title="Clear search" onClick={()=>setQuery('')}><X size={14}/></button>:<kbd>/</kbd>}</div><button className="theme-toggle" aria-label={theme==='dark'?'Switch to color mode':'Switch to dark mode'} onClick={()=>setTheme(theme==='dark'?'color':'dark')}>{theme==='dark'?<Moon size={15}/>:<Palette size={15}/>}<span>{theme==='dark'?'Dark mode':'Color mode'}</span></button><button className="demo-pill" onClick={()=>setMenu(menu==='sandbox'?'':'sandbox')}><i/> {liveToken?'IONOS':'Sandbox'} <ChevronDown size={12}/></button>
 {menu==='search-filters'&&<SearchFilters value={searchFilters} onChange={value=>{setSearchFilters(value);setLimit(60);}}
  folders={physicalFolders} current={currentSearchFolder} onClose={()=>{setMenu('');document.getElementById('search')?.focus();}}/>}
 {menu==='sandbox'&&<div className="popover sandbox-menu"><b>{liveToken?'IONOS Mail':'Sandbox mode'}</b><p>{liveToken?(account||connection):'Changes stay in this browser.'}</p><a className="project-tag" href={liveToken?'?sandbox=1':location.pathname}>{liveToken?'Open sandbox':'Return to live inbox'}</a>{liveToken?<button onClick={()=>void refreshMailbox()}>Refresh mailbox <kbd>⌘⇧R</kbd></button>:<button onClick={receive}><Inbox size={15}/> Simulate incoming mail</button>}<button disabled={!senderIdentities.length} onClick={openSignatures}><Settings2 size={15}/> Email signatures</button><button onClick={()=>{setHelp(true);setMenu('')}}>Keyboard shortcuts</button>{onSignOut&&<button onClick={()=>void onSignOut().catch(error=>setToast(error.message))}>Sign out</button>}</div>}</header>
 {nav==='Command Center'&&!query?<div className="dashboard">
 <h1>Command Center</h1>
 <div className="mail-export-toolbar">
  <button type="button" className="project-tag" disabled={exportCount!==null} onClick={()=>void exportSelection(true)}><Download size={16}/> Export Inbox CSV</button>
  {exportCount!==null&&<><span role="status">{exportCount} rows ready{exportPaused?' · Paused':''}</span>
   <button type="button" className="project-tag" onClick={()=>setExportPause(!exportPaused)}>{exportPaused?'Resume export':'Pause export'}</button>
   <button type="button" className="project-tag" disabled={!exportCount} onClick={downloadExportSoFar}>Download current rows</button>
   <button type="button" className="project-tag" onClick={cancelExport}>Cancel export</button></>}
 </div>
 <div className="metrics">{([
  [Mail,'Unread incoming',unreadIncoming,'Incoming'],
  [ClipboardList,'Bid invitations',queues.bids.length,'Bid Invitations'],
  [FileQuestion,'Urgent & unread',queues.urgent.length,'Urgent'],
  [Receipt,'Unread invoice mail',queues.invoices.length,'Invoices'],
 ] as const).map(([Icon,label,n,dest])=><button key={label} onClick={()=>{go(dest==='Incoming'||dest==='Urgent'?'Inbox':dest);if(dest==='Incoming'||dest==='Urgent')setFilter(dest);if(dest==='Invoices')setFilter('Unread')}}><Icon size={20}/><strong>{n}</strong><span>{label}</span><ArrowUpRight size={16}/></button>)}</div>
 <div className="queues">{([
  [Clock3,'Bid deadlines',queues.bids,'No bid invitations in the inbox.'],
  [FileQuestion,'Urgent correspondence',queues.urgent,'No urgent unread mail.'],
  [Reply,'Awaiting a reply',queues.unanswered,'No open requests found.'],
  [Receipt,'Unread invoice mail',queues.invoices,'No unread invoice mail.'],
 ] as const).map(([Icon,label,items,empty])=><section className="queue" key={label}>
  <header><Icon size={17}/><h2>{label}</h2></header>
  {items.length ? items.slice(0,5).map(message=><button className="queue-row" key={message.id} onClick={()=>{go('Inbox');open(message)}}>
   <b>{message.subject}</b><small>{message.company||message.name}{message.due&&<> · <time dateTime={message.due}>Due {day(message.due+'T12:00:00')}</time></>}</small>
  </button>) : <p>{empty}</p>}
 </section>)}</div>
 {onSignOut&&liveToken&&<BidImportReport token={liveToken}/>}
 <section className="activity"><h2>Recent activity</h2>{[...mail].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,6).map(m=><button key={m.id} onClick={()=>{go('Inbox');open(m)}}>{tag(m)}<b>{m.subject}</b><span>{m.name}</span><ArrowRight size={16}/></button>)}</section></div>:
 <div className="workspace">
 <section className="message-list">
 <div className="list-head"><div className="eyebrow">{query?'GLOBAL SEARCH':'OPERATIONS MAIL'}</div><h1>{query?'Search results':viewName}</h1><p>{nav==='Inbox'&&!query?'Incoming messages, newest first.':nav==='Drafts'&&!query?'Pick up where you left off.':query?searchScopeLabel:nav==='Invoices'?'Invoices, payments, receipts, and purchase orders.':'Manage your construction correspondence.'}</p>
 {nav==='Active Projects'&&!query&&<select aria-label="Filter by project" value={projectFilter} onChange={e=>setProjectFilter(e.target.value)}><option value="">All projects</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>}</div>
 <div className="mail-export-toolbar">
  <label><input type="checkbox" checked={allSelected} onChange={event=>setAllSelected(event.target.checked)} disabled={exportCount!==null}/> Select all in this view</label>
  <button type="button" className="project-tag" disabled={!allSelected||exportCount!==null} onClick={()=>void exportSelection()}><Download size={16}/> Export email CSV</button>
  {exportCount!==null&&<><span role="status">{exportCount} rows ready{exportPaused?' · Paused':''}</span>
   <button type="button" className="project-tag" onClick={()=>setExportPause(!exportPaused)}>{exportPaused?'Resume export':'Pause export'}</button>
   <button type="button" className="project-tag" disabled={!exportCount} onClick={downloadExportSoFar}>Download current rows</button>
   <button type="button" className="project-tag" onClick={cancelExport}>Cancel export</button></>}
 </div>
 <div className="list-toolbar">{marked.length?<><button onClick={()=>setMarked([])}>{marked.length} selected ×</button><button title="Archive selected" className="icon" onClick={()=>move(marked,'Archive')}><Archive size={16}/></button><button title="Delete selected" className="icon" onClick={()=>move(marked,'Trash')}><Trash2 size={16}/></button></>:<><div className="tabs">{['All mail','Unread'].map(f=><button key={f} className={filter===f?'on':''} onClick={()=>{setFilter(f);setLimit(60)}} disabled={!!query}>{f}{f==='Unread'&&nav==='Inbox'&&<span>{unreadIncoming}</span>}</button>)}</div><button className={'icon '+(!['All mail','Unread'].includes(filter)?'accent':'')} title="Filter messages" onClick={()=>setMenu(menu==='filters'?'':'filters')}><SlidersHorizontal size={17}/></button></>}
 {menu==='filters'&&<div className="popover filters">{['All mail','Unread','Starred','Attachments','Incoming','Urgent'].map(f=><button key={f} onClick={()=>{setFilter(f);setMenu('')}}>{f}{filter===f&&<Check size={14}/>}</button>)}</div>}</div>
 <div className="rows">
 {mailboxIssue&&<div className="empty" role="alert">{mailboxIssue} <button type="button" className="project-tag" onClick={()=>void refreshMailbox()}>Retry mailbox</button></div>}
 {nav==='Drafts'&&!query?draftList.length?draftList.map(d=><button className="draft-row" key={d.id} disabled={saving} onClick={()=>reopenDraft(d.id)}><span className="tag rose">Draft</span><b>{d.subject||'(No subject)'}</b><span>{d.to||'No recipient'}</span></button>):<div className="empty">{draftSyncError||'No drafts yet.'}{draftSyncError&&<button className="project-tag" onClick={()=>void syncPreferences()}>Retry</button>}</div>:list.length?list.slice(0,limit).map((m,i)=><div key={m.id} className={'mail-row '+(m.id===currentRow?.id?'selected ':'')+(m.unread?'unread':'')}>
 <div className="row-side"><input type="checkbox" disabled={!!liveToken} aria-label={'Select '+m.subject} checked={marked.includes(m.id)} onChange={e=>setMarked(e.target.checked?[...marked,m.id]:marked.filter(x=>x!==m.id))}/><button className={'star '+(m.star?'starred':'')} disabled={!!liveToken&&m.id.startsWith('out-')} title={m.star?'Remove star':'Star message'} onClick={()=>change([m.id],{star:!m.star})}><Star size={14}/></button></div>
 <button className="row-content" onClick={()=>open(m)}><div className="row-top"><span className={'avatar mini '+avatarColors[i%5]}>{initials(m.name)}</span><b>{m.folder==='Sent'?'To: '+m.to:m.name}</b><MessageTimestamp value={m.date}/></div><strong>{m.subject}</strong><p>{m.body.replace(/\s+/g,' ')}</p><div className="row-foot">{tag(m)}{m.folder!=='Inbox'&&(m.folder==='Sent'&&liveToken?<span className={'tag delivery '+(deliveryLabels[m.delivery?.status||'sent']||deliveryLabels.sent)[1]} title={deliveryTitle(m.delivery)}>{(deliveryLabels[m.delivery?.status||'sent']||deliveryLabels.sent)[0]}</span>:<span className="tag gray">{m.folder}</span>)}{m.files.length>0&&<span className="paper-count"><Paperclip size={13}/>{m.files.length}</span>}{m.unread&&<i className="unread-dot"/>}</div></button>
 {(!liveToken||!m.id.startsWith('out-'))&&<div className="row-mail-actions">
  <button type="button" className="icon" title={m.unread?'Mark as read':'Mark as unread'}
   aria-label={(m.unread?'Mark as read: ':'Mark as unread: ')+m.subject}
   onClick={()=>void change([m.id],{unread:!m.unread})}>{m.unread?<MailOpen size={16}/>:<Mail size={16}/>}</button>
  {m.folder==='Trash'?<button type="button" className="icon" title="Delete forever"
   aria-label={'Delete forever: '+m.subject} onClick={()=>setDeleteTarget(m)}><Trash2 size={16}/></button>:
   <button type="button" className="icon" title="Move to Trash"
    aria-label={'Move to Trash: '+m.subject} onClick={()=>void move([m.id],'Trash')}><Trash2 size={16}/></button>}
 </div>}
 </div>):<div className="empty">No messages match this view.</div>}
 {list.length>limit&&<button className="load" onClick={()=>setLimit(limit+60)}>Show more loaded messages</button>}
 {list.length<=limit&&olderFolder&&olderCursor&&<button className="load" disabled={olderBusy} onClick={()=>void loadOlder()}>
  {olderBusy?'Loading older mail…':currentSearchFolder?'Load older '+olderFolder+' mail from IONOS':'Load older Inbox mail from IONOS'}</button>}
 {activeSearch&&liveToken&&<>
  {searchBusy&&<p role="status">Searching IONOS across all folders…</p>}
  {searchError&&<p role="alert">{searchError} {!searchBusy&&<button className="project-tag" type="button"
   onClick={()=>void searchOlder(activeSearch,searchRevision.current,mailSearch.query===searchKey&&mailSearch.next.length?mailSearch.next:undefined)}>Retry search</button>}</p>}
  {!searchBusy&&mailSearch.query===searchKey&&mailSearch.next.length>0&&<button className="load"
   onClick={()=>void searchOlder(activeSearch,searchRevision.current,mailSearch.next)}>Fetch more matching messages</button>}
 </>}</div>
 <footer className="list-footer">{nav==='Drafts'&&!query?draftList.length+' drafts':list.length+' messages'} <span>•</span> {liveToken?connection:'Local sandbox'}</footer>
 </section>
 <section className="reader">{currentRow?<><div className="reader-tools"><button className="icon back" title="Back to messages" onClick={()=>setMobileRead(false)}><ChevronLeft size={19}/></button><button className="icon" disabled={!!liveToken&&currentRow.id.startsWith('out-')} title="Archive" onClick={()=>move([currentRow.id],'Archive')}><Archive size={18}/></button><button className="icon" disabled={!!liveToken&&currentRow.id.startsWith('out-')} title={currentRow.folder==='Trash'?'Delete forever':'Move to Trash'} onClick={()=>currentRow.folder==='Trash'?setDeleteTarget(currentRow):void move([currentRow.id],'Trash')}><Trash2 size={18}/></button><button className="icon" disabled={!!liveToken&&currentRow.id.startsWith('out-')} title={currentRow.unread?'Mark read':'Mark unread'} onClick={()=>change([currentRow.id],{unread:!currentRow.unread})}>{currentRow.unread?<MailOpen size={18}/>:<Mail size={18}/>}</button><button className="icon" disabled={!!liveToken&&currentRow.id.startsWith('out-')} title="Move message" onClick={()=>setMenu(menu==='move'?'':'move')}><MoreHorizontal size={20}/></button>{currentRow.folder!=='Inbox'&&currentRow.folder!=='Sent'&&<button className="icon" title="Restore message" onClick={()=>move([currentRow.id],currentRow.previousFolder==='Sent'?'Sent':'Inbox')}><RotateCcw size={17}/></button>}{menu==='move'&&<div className="popover move">{['Inbox','Sent','Archive','Trash','Spam'].filter(f=>f!==currentRow.folder).map(f=><button key={f} onClick={()=>move([currentRow.id],f)}>Move to {f}</button>)}</div>}<span className="tool-space"/><span className="position">{list.findIndex(m=>m.id===currentRow.id)+1} of {list.length}</span><button className="icon next" title="Previous message" disabled={list[0]===currentRow} onClick={()=>{const p=list[list.indexOf(currentRow)-1];if(p)open(p)}}><ChevronLeft size={18}/></button><button className="icon next next-right" title="Next message" disabled={list.at(-1)===currentRow} onClick={()=>{const p=list[list.indexOf(currentRow)+1];if(p)open(p)}}><ChevronLeft size={18}/></button></div>
 <div className="reader-scroll"><div className="reader-content"><div className="subject-line"><h2>{currentRow.subject}</h2><button className={'star '+(currentRow.star?'starred':'')} disabled={!!liveToken&&currentRow.id.startsWith('out-')} title="Toggle message star" onClick={()=>change([currentRow.id],{star:!currentRow.star})}><Star size={20}/></button></div><div className="reader-tags">{tag(currentRow)}{currentRow.folder==='Sent'&&liveToken&&<span className={'tag delivery '+(deliveryLabels[currentRow.delivery?.status||'sent']||deliveryLabels.sent)[1]} title={deliveryTitle(currentRow.delivery)}>{(deliveryLabels[currentRow.delivery?.status||'sent']||deliveryLabels.sent)[0]}{currentRow.delivery?.recipients.some(item=>item.action==='failed')&&': '+currentRow.delivery.recipients.filter(item=>item.action==='failed').map(item=>item.address||'see bounce in Inbox').join(', ')}</span>}{project&&<button className="project-tag" onClick={()=>{go('Active Projects');setProjectFilter(project.id)}}><FolderKanban size={13}/>{project.name}</button>}</div>
 <div className="sender"><span className="avatar sand">{initials(currentRow.name)}</span><div><b>{currentRow.name}</b><span className="from"> &lt;{currentRow.from}&gt;</span><small>To: {currentRow.to}{currentRow.cc&&' · Cc: '+currentRow.cc}{currentRow.folder==='Sent'&&currentRow.bcc&&' · Bcc: '+currentRow.bcc}</small></div><MessageTimestamp value={currentRow.date}/></div>
   {renderAttachments([currentRow,...newest.slice().reverse()])}
 {currentRow.due&&<div className="deadline"><div className="deadline-icon"><Clock3 size={19}/></div><div><b>Bid submission deadline</b><span>{day(currentRow.due+'T12:00:00')}</span></div><span className="tag gold">Open bid</span></div>}
 {renderBody(currentRow)}
 <div className="reply-actions desktop-replies">{replyButtons(currentRow)}</div>
 {liveToken&&mailFeatures.askAi&&!currentRow.id.startsWith('out-')&&currentRow.folder!=='Sent'&&<div className="smart-replies">
  {smartReplies?.id===currentRow.id?smartReplies.replies.map((text,index)=><button type="button" key={index} title={text} onClick={()=>start('Reply',currentRow,text)}>{text}</button>)
   :<button type="button" className="smart-replies-get" disabled={smartBusy} onClick={()=>void suggestReplies(currentRow)}><Sparkles size={13}/> {smartBusy?'Thinking…':'Suggest replies'}</button>}
 </div>}
 {newest.length>0&&<section className="thread"><h3>Conversation · {related.length} messages</h3>{newest.map(m=><details key={m.id} onToggle={e=>{if(e.currentTarget.open&&m.needsBody&&!bodies[m.id])void loadBody(m).catch(()=>{})}}><summary>{m.name} · <MessageTimestamp value={m.date}/></summary>{renderBody(m)}</details>)}</section>}
 <div className="metadata" hidden={!!liveToken}><label>Project<select value={currentRow.project} onChange={e=>{change([currentRow.id],{project:e.target.value});setToast('Project assignment saved')}}><option value="">Unassigned</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Category<select value={currentRow.category} onChange={e=>{change([currentRow.id],{category:e.target.value});setToast('Category corrected')}}>{categories.map(c=><option key={c}>{c}</option>)}</select></label><button onClick={()=>{const domain=currentRow.from.split('@')[1];setState(s=>({...s,rules:{...s.rules,[domain]:currentRow.category}}));setToast('Rule saved for future messages from '+domain)}}>Remember sender domain rule</button></div>
 </div></div><nav className="mobile-dock mobile-replies" aria-label="Message actions">{replyButtons(currentRow)}</nav></>:<div className="reader-empty"><Inbox size={29}/><h2>Select a message</h2><p>Open a conversation to read it here.</p></div>}</section>
 </div>}
 {(!mobileRead||!currentRow)&&<nav className="mobile-dock mobile-mailbar" aria-label="Mailbox actions">
  <button aria-current={nav==='Inbox'&&!query?'page':undefined} onClick={()=>go('Inbox')}><Inbox size={19}/>Inbox</button>
  <button aria-current={nav==='Drafts'&&!query?'page':undefined} onClick={()=>go('Drafts')}><FileText size={19}/>Drafts</button>
  <button onClick={refreshCurrentView}><RotateCcw size={19}/>Refresh</button>
  <button className="mobile-compose" disabled={!!liveToken&&!account} onClick={()=>start()}><Plus size={19}/>Compose</button>
 </nav>}
 </main>
 {draft&&<div className="modal-back compose-overlay" onClick={closeDraft}><form ref={composeWindow.panel} style={composeWindow.position||undefined} className={"compose-panel"+(composeWindow.position?" compose-positioned":"")} role="dialog" aria-label="Compose message" aria-modal="true"
 onDragOver={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect=saving||sending?'none':'copy';setDraggingFiles(!saving&&!sending)}}}
 onDragLeave={event=>{if(!(event.relatedTarget instanceof Node)||!event.currentTarget.contains(event.relatedTarget))setDraggingFiles(false)}}
 onDrop={event=>{if(!event.dataTransfer.types.includes('Files'))return;event.preventDefault();setDraggingFiles(false);attachFiles(Array.from(event.dataTransfer.files))}} onClick={e=>e.stopPropagation()} onSubmit={sendDraft}
 onKeyDown={event=>{
  if (event.key!=='Enter'||!(event.metaKey||event.ctrlKey)||event.altKey||event.nativeEvent.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  if (saving||sending) return;
  const form=event.currentTarget;
  // Defer one tick so a recipient typed into To/Cc is committed before sending.
  window.setTimeout(()=>form.requestSubmit(),0);
 }}><header className="compose-titlebar" onPointerDown={composeWindow.begin} onPointerMove={composeWindow.move} onPointerUp={composeWindow.end} onLostPointerCapture={composeWindow.end} onDoubleClick={event=>{if(!(event.target as HTMLElement).closest("button"))composeWindow.reset()}}><b>New message</b><button type="button" className="icon" title="Save and close draft" disabled={sending||saving} onClick={closeDraft}><X size={19}/></button></header><label>From<select value={draft.identity} onChange={e=>edit({identity:e.target.value})}>{senderIdentities.map(i=><option key={i}>{i}</option>)}</select></label><RecipientInput label="To" autoFocus value={draft.to} onChange={to=>edit({to})} contacts={contacts} lookup={contactLookup?lookupContacts:undefined}/><RecipientInput label="Cc" value={draft.cc} onChange={cc=>edit({cc})} contacts={contacts}/><RecipientInput label="Bcc" value={draft.bcc||''} onChange={bcc=>edit({bcc})} contacts={contacts}/><label>Subject<input value={draft.subject} onChange={e=>edit({subject:e.target.value})}/></label>{liveToken&&mailFeatures.askAi&&<div className="ai-write-bar">
  <button type="button" className={'ai-write-main'+(aiWriteOpen?' on':'')} disabled={!!aiWriting||sending} onClick={()=>setAiWriteOpen(!aiWriteOpen)}><Sparkles size={14}/> Help me write</button>
  {draft.body.trim()&&[['polish','Polish'],['formalize','Formal'],['casual','Friendlier'],['shorten','Shorter'],['elaborate','Elaborate'],['proofread','Proofread']].map(([mode,label])=>
   <button type="button" key={mode} disabled={!!aiWriting||sending} onClick={()=>void aiWrite(mode)}>{aiWriting===mode?'Working…':label}</button>)}
  {draft.body.trim()&&<button type="button" disabled={!!aiWriting||sending} onClick={()=>{setAiWriteOpen(true);setAiPrompt('Translate to Spanish');}}>Translate</button>}
  {aiUndo?.draft===draft.id&&<button type="button" className="ai-write-undo" disabled={!!aiWriting} onClick={()=>{edit({body:aiUndo.body});setAiUndo(null);}}><RotateCcw size={13}/> Undo</button>}
  {aiWriteOpen&&<div className="ai-write-prompt">
   <input value={aiPrompt} maxLength={1000} autoFocus placeholder={draft.parent?'e.g. Confirm we will bid, ask for the plans link':'e.g. Ask Terri for the walk date and plans, friendly tone'}
    onChange={event=>setAiPrompt(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!(event.metaKey||event.ctrlKey)){event.preventDefault();event.stopPropagation();
     const translate=aiPrompt.match(/^translate(?: (?:it|this))? (?:to|into) (.+)$/i);void aiWrite(translate?'translate':'write',translate?translate[1]:aiPrompt);}}}/>
   <button type="button" className="send" disabled={!aiPrompt.trim()||!!aiWriting} onClick={()=>{const translate=aiPrompt.match(/^translate(?: (?:it|this))? (?:to|into) (.+)$/i);void aiWrite(translate?'translate':'write',translate?translate[1]:aiPrompt);}}>{aiWriting==='write'||aiWriting==='translate'?'Writing…':'Create'}</button>
  </div>}
 </div>}<textarea aria-label="Message body" placeholder="Write your message…" value={draft.body} onChange={e=>edit({body:e.target.value})}/><div className="signature"><label><input type="checkbox" checked={draft.includeSignature!==false} onChange={e=>edit({includeSignature:e.target.checked})}/> Include signature</label><div>{draftSignature(draft)}{draft.includeSignature!==false&&state.signatureImages?.[draft.identity]&&<img className="signature-logo" alt="Signature" src={state.signatureImages[draft.identity]}/>}</div><button type="button" className="project-tag" disabled={sending||saving} onClick={openSignatures}>Edit signature</button></div>
 {draft.files.length>0||draft.largeFiles?.length||draft.forwardedAttachments?.length||draft.stagedAttachments?.length||draft.attachments?.length?
  <div className="chips draft-attachment-list" aria-label="Draft attachments">
   {draft.files.map((name,index)=>renderDraftFile('sample:'+index,name,()=>setPreview(name),()=>edit({files:draft.files.filter((_,i)=>i!==index)})))}
   {draft.largeFiles?.map(file=>renderDraftFile('large:'+file.id,file.name+' · Download link',
    ()=>setLivePreview({kind:'large',draftId:draft.id,file,name:file.name}),
    ()=>edit({largeFiles:draft.largeFiles?.filter(item=>item.id!==file.id)})))}
   {draft.forwardedAttachments?.map(file=>renderDraftFile(file.messageId+':'+file.part,file.name,
    ()=>setLivePreview({kind:'mail',id:file.messageId,part:file.part,name:file.name,hosted}),
    ()=>edit({forwardedAttachments:draft.forwardedAttachments?.filter(item=>item!==file)})))}
   {draft.stagedAttachments?.map(file=>renderDraftFile('staged:'+file.id,file.name,
    ()=>setLivePreview({kind:'staged',draftId:draft.id,file,name:file.name}),
    ()=>edit({stagedAttachments:draft.stagedAttachments?.filter(item=>item.id!==file.id)})))}
   {draft.attachments?.map((file,index)=>renderDraftFile('inline:'+index,file.name,
    ()=>setLivePreview({kind:'inline',name:file.name,data:file.data}),
    ()=>edit({attachments:draft.attachments?.filter((_,i)=>i!==index)})))}
  </div>:null}
 <footer>
  {draggingFiles&&<span className="upload-progress" role="status">Drop files to attach them</span>}
  {uploadProgress&&<span className="upload-progress" role="status">{uploadProgress}{largeUploadAbort.current&&<button className="project-tag upload-cancel" type="button" onClick={()=>largeUploadAbort.current?.abort()}>Cancel upload</button>}</span>}
  {hosted&&!uploadProgress&&draftSaveState&&<span className="draft-status" role="status">{draftSaveState}</span>}
  <button className="send" type="submit" disabled={saving||sending}><Send size={16}/> {sending?'Sending…':liveToken?'Send email':'Send test email'}</button>
  <button className="project-tag" type="button" disabled={saving||sending} onClick={closeDraft}>{saving?'Working…':'Save draft'}</button>
  <input ref={attachmentPicker} type="file" hidden multiple onChange={event=>addFiles(event)}/>
  <button type="button" className="icon" title={hosted?"Attach files (24 MB total)":"Attach files (3 MB total)"} disabled={saving||sending} onClick={()=>attachmentPicker.current?.click()}><Paperclip size={18}/></button>
  {largeUploads&&<><input ref={linkPicker} type="file" hidden multiple onChange={event=>addFiles(event,true)}/>
   <button type="button" className="project-tag" disabled={saving||sending} onClick={()=>linkPicker.current?.click()}>Add download link</button></>}
  <button type="button" className="icon discard-draft" title="Discard draft" disabled={saving||sending} onClick={()=>discard(draft.id)}><Trash2 size={18}/></button>
 </footer></form></div>}
 {signatureForm&&<div className="modal-back centered" onClick={()=>{if(!saving)setSignatureForm(null)}}>
 <form className="signature-settings" role="dialog" aria-label="Email signatures" onClick={e=>e.stopPropagation()} onSubmit={saveSignatures}>
  <header><b>Email signatures</b><button type="button" className="icon" title="Close signatures" disabled={saving} onClick={()=>setSignatureForm(null)}><X size={19}/></button></header>
  <div className="signature-fields"><p>Set a plain text signature for each sender. Leave it blank to omit it.</p>
   {senderIdentities.map(identity=><div className="signature-editor-fields" key={identity}>
    <label>{identity}<textarea maxLength={2000} value={signatureForm[identity]} onChange={e=>setSignatureForm({...signatureForm,[identity]:e.target.value})}/></label>
    {signatureImageForm[identity]&&<><img className="signature-logo" alt="Signature image" src={signatureImageForm[identity]}/><button type="button" className="project-tag" onClick={()=>setSignatureImageForm(previous=>({...previous,[identity]:''}))}>Remove image</button></>}
    <label>Signature image <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={saving} onChange={event=>void pickSignatureImage(identity,event)}/></label>
   </div>)}
   <button type="submit" className="send" disabled={saving}>{saving?'Saving…':'Save signature'}</button>
  </div>
 </form></div>}
 {deleteTarget&&<div className="modal-back centered" onClick={()=>{if(!saving)setDeleteTarget(null)}}>
  <section className="signature-settings delete-confirmation" role="alertdialog" aria-modal="true"
   aria-labelledby="delete-forever-heading" aria-describedby="delete-forever-description" onClick={event=>event.stopPropagation()}>
   <header><b id="delete-forever-heading">Delete forever?</b></header>
   <div className="signature-fields">
    <p id="delete-forever-description">“{deleteTarget.subject}” will be permanently removed from this mailbox.</p>
    <div className="delete-confirmation-actions">
     <button type="button" className="project-tag" autoFocus disabled={saving} onClick={()=>setDeleteTarget(null)}>Cancel</button>
     <button type="button" className="send" disabled={saving} onClick={()=>void deleteForever(deleteTarget)}>Delete forever</button>
    </div>
   </div>
  </section>
 </div>}
 {livePreview&&<AttachmentPreview source={livePreview} request={liveRequest} close={()=>setLivePreview(null)}/>}
 {preview&&<div className="modal-back centered" onClick={()=>setPreview(null)}><section className="attachment-preview" role="dialog" aria-label="Attachment preview" onClick={e=>e.stopPropagation()}><header><b>{preview}</b><button className="icon" title="Close preview" onClick={()=>setPreview(null)}><X size={19}/></button></header><div className="preview-sheet"><div className="eyebrow">A2Z CONSTRUCTION SERVICES / DEMO DOCUMENT</div><FileText size={42}/><h2>{preview.replace(/\.pdf$/i,'')}</h2><p>This is a simulated attachment for the sandbox.</p></div><footer><a href="/samples/demo.pdf" download={preview}><Download size={16}/> Download sample PDF</a></footer></section></div>}
 {sendReceipt&&<section className={'send-receipt'+(sendReceipt.rejected.length?' warn':'')} role="status" aria-live="polite">
  <header><span className="send-receipt-icon">{sendReceipt.rejected.length?<X size={16}/>:<Check size={16}/>}</span>
   <b>{sendReceipt.rejected.length?'Sent with problems':'Email sent'}</b>
   <button type="button" className="icon" aria-label="Close" onClick={()=>setSendReceipt(null)}><X size={16}/></button></header>
  <p className="send-receipt-subject">{sendReceipt.subject}</p>
  <ul>
   <li><Check size={13}/> {sendReceipt.live?'Accepted by IONOS for '+(sendReceipt.accepted.length||sendReceipt.to.length)+' recipient'+((sendReceipt.accepted.length||sendReceipt.to.length)===1?'':'s'):'Sent in sandbox'}: {(sendReceipt.accepted.length?sendReceipt.accepted:sendReceipt.to).join(', ')}</li>
   {sendReceipt.rejected.length>0&&<li className="bad"><X size={13}/> Rejected: {sendReceipt.rejected.join(', ')}</li>}
   {sendReceipt.live&&<li className={sendReceipt.sentSaved?'':'bad'}>{sendReceipt.sentSaved?<Check size={13}/>:<X size={13}/>} {sendReceipt.sentSaved?'Saved to Sent':'Could not save a copy to Sent'}</li>}
   {sendReceipt.live&&<li className="muted">Delivery status shows on the message in Sent: Delivered, Delayed or Bounced.</li>}
  </ul>
  {sendReceipt.thread&&<button type="button" className="project-tag" onClick={()=>{go('Sent');setSendReceipt(null);}}>View in Sent</button>}
 </section>}
 {teamOpen&&liveToken&&<AdminConsole self={account} request={(path,body)=>liveRequest(path,body)} onClose={()=>setTeamOpen(false)}
  onChanged={()=>void liveRequest('profile').then((data:{profile?:Profile})=>{if(data.profile)setProfile(data.profile)}).catch(()=>{})}/>}
 {help&&<div className="modal-back centered" onClick={()=>setHelp(false)}><section className="shortcuts" role="dialog" aria-label="Keyboard shortcuts" onClick={e=>e.stopPropagation()}><header><b>Keyboard shortcuts</b><button className="icon" title="Close shortcuts" onClick={()=>setHelp(false)}><X size={19}/></button></header>{[['C','Compose'],['/','Search'],['⌘R','Reply'],['⌘⇧R','Refresh mailbox'],['⌘F','Forward'],['⌘/Ctrl+Enter','Send open draft'],['E','Archive selected message'],['Esc','Close dialog or message'],['?','Show shortcuts']].map(([k,l])=><p key={k}><kbd>{k}</kbd> {l}</p>)}</section></div>}
 {toast&&<div className="toast" role="status"><Check size={17}/>{toast}</div>}
 </div>
}
function HostedInbox({ready,highLevelOrigins,highLevelIssues,largeUploads,contactLookup}:{ready:boolean;highLevelOrigins:string[];highLevelIssues:string[];largeUploads:boolean;contactLookup:boolean}) {
 const [token,setToken]=useState('');
 const canAutoSignIn=ready&&window.parent!==window&&highLevelOrigins.length>0;
 const [attempt,setAttempt]=useState(canAutoSignIn?1:0);
 const canRestore=ready&&window.parent===window;
 const [restoring,setRestoring]=useState(canRestore);
 const [checking,setChecking]=useState(canAutoSignIn);
 const [signingOut,setSigningOut]=useState(false);
 const [notice,setNotice]=useState(()=>{
  if (window.parent===window||!ready||highLevelOrigins.length) return '';
  const detail=highLevelIssues.join('. ');
  return 'HighLevel auto sign-in is disabled on this deployment.'+(detail?' '+detail+'.':'');
 });

 useEffect(()=>{
  if (!canRestore) return;
  const controller=new AbortController();
  void hostedRequest('session',undefined,rememberedSession,controller.signal)
   .then(()=>{if(!controller.signal.aborted)setToken(rememberedSession)})
   .catch(()=>{})
   .finally(()=>{if(!controller.signal.aborted)setRestoring(false)});
  return ()=>controller.abort();
 },[canRestore]);

 async function signOut(error?:unknown) {
  if (signingOut) return;
  if (token===rememberedSession) {
   setSigningOut(true);
   try { await hostedRequest('logout',{},token); }
   catch {
    setSigningOut(false);
    throw new Error('Could not sign out. Check your connection and try again.');
   }
   setSigningOut(false);
  }
  setNotice(error?highLevelSignInNotice(error):'');
  setToken('');
  setAttempt(0);
 }

 useEffect(()=>{
  if (!attempt) return;
  const controller=new AbortController();
  requestHighLevelContext(highLevelOrigins,controller.signal)
   .then(context=>hostedRequest('ghl-login',context))
   .then(result=>{if(!controller.signal.aborted)setToken(result.token)})
   .catch(error=>{if(!controller.signal.aborted)setNotice(highLevelSignInNotice(error))})
   .finally(()=>{if(!controller.signal.aborted)setChecking(false)});
  return ()=>controller.abort();
 },[attempt,highLevelOrigins]);

 if (token) return <App liveToken={token} largeUploads={largeUploads} contactLookup={contactLookup} onSignOut={signOut}/>;
 if (restoring) return <div className="login-page" role="status">Checking your saved sign-in…</div>;
 if (checking) return <div className="login-page" role="status">
  <div className="signature-settings signature-fields"><h1>Signing in through HighLevel…</h1>
  <button className="project-tag" onClick={()=>{setAttempt(0);setChecking(false)}}>Use mailbox password instead</button></div>
 </div>;
 return <MailboxLogin ready={ready} onLogin={setToken} notice={notice} retry={canAutoSignIn?()=>{
  setChecking(true);setNotice('');setAttempt(n=>n+1);
 }:undefined}/>;
}

const root=createRoot(document.getElementById('root')!);
if (new URLSearchParams(location.search).get('sandbox')==='1') root.render(<App/>);
else if (localToken) root.render(<App liveToken={localToken}/>);
else if (import.meta.env.PROD && !['127.0.0.1','localhost','[::1]'].includes(location.hostname)) {
 hostedRequest('status').then(status=>{
  root.render(status.live?<HostedInbox ready={status.ready} highLevelOrigins={status.highLevelOrigins||[]} highLevelIssues={status.highLevelIssues||[]} largeUploads={status.largeFiles===true} contactLookup={status.contactLookup===true}/>:<App/>);
 }).catch(()=>root.render(<div className="login-page" role="alert">The mailbox service is unavailable. Reload to try again.</div>));
} else root.render(<App/>);
