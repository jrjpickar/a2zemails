export function dateOnly(value) {
 if (typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
 const date=new Date(value+'T12:00:00Z');
 return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value?date:null;
}

export function scopedMailMatches(message,scope) {
 if (scope.folder&&message.folder!==scope.folder) return false;
 const day=message.date?.slice(0,10)||'';
 return (!scope.fromDate||day>=scope.fromDate)&&(!scope.toDate||day<=scope.toDate);
}

export function searchTerms(query) {
 return query.match(/(?:[^\s"]+|"[^"]*")+/g)||[];
}
