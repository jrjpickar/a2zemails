export type SearchField='text'|'subject'|'from'|'body';
export type SearchFiltersValue={folder:string;period:'30'|'7'|'90'|'any'|'custom';field:SearchField;start:string;end:string};
export const defaultSearchFilters:SearchFiltersValue={folder:'current',period:'30',field:'text',start:'',end:''};

export function SearchFilters({value,onChange,folders,current,onClose}:{
 value:SearchFiltersValue;onChange:(value:SearchFiltersValue)=>void;folders:string[];current?:string;onClose:()=>void;
}) {
 const set=<Key extends keyof SearchFiltersValue>(key:Key,next:SearchFiltersValue[Key])=>onChange({...value,[key]:next});
 return <section className="search-filters-panel" aria-label="Search filters">
  <label>Folder<select value={value.folder} onChange={event=>set('folder',event.target.value)}>
   <option value="current">Current folder{current?' ('+current+')':''}</option>
   <option value="all">All folders</option>
   {folders.map(folder=><option key={folder} value={'folder:'+folder}>{folder}</option>)}
  </select></label>
  <label>Date range<select value={value.period} onChange={event=>set('period',event.target.value as SearchFiltersValue['period'])}>
   <option value="30">Last 30 days</option><option value="7">Last 7 days</option><option value="90">Last 90 days</option>
   <option value="any">Any time</option><option value="custom">Custom range</option>
  </select></label>
  <label>Search in<select value={value.field} onChange={event=>set('field',event.target.value as SearchField)}>
   <option value="text">Headers and message body</option><option value="subject">Subject</option>
   <option value="from">Sender</option><option value="body">Message body</option>
  </select></label>
  {value.period==='custom'&&<div className="search-filter-dates">
   <label>From<input type="date" value={value.start} max={value.end||undefined} onChange={event=>set('start',event.target.value)}/></label>
   <label>Through<input type="date" value={value.end} min={value.start||undefined} onChange={event=>set('end',event.target.value)}/></label>
  </div>}
  <footer>
   <button type="button" className="project-tag" onClick={()=>onChange({...defaultSearchFilters,folder:'all',period:'any'})}>All folders · Any time</button>
   <button type="button" className="send" onClick={onClose}>Done</button>
  </footer>
 </section>;
}
