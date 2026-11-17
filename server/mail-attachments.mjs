export const ATTACHMENT_LIMIT = 3 * 1024 * 1024;
export const REQUEST_LIMIT = 5_400_000;

export function mailAttachments(input) {
 if (input===undefined) return [];
 if (!Array.isArray(input)||input.length>10) throw new TypeError('Attach up to 10 files.');
 let total=0;
 return input.map(file=>{
  if (typeof file?.name!=='string'||!file.name.trim()||file.name.length>180||/[\u0000-\u001f\u007f/\\]/.test(file.name)||
      typeof file.data!=='string'||file.data.length>ATTACHMENT_LIMIT*1.34||!/^([A-Za-z0-9+/]+={0,2})?$/.test(file.data)||
      file.data.length%4!==0) throw new TypeError('Invalid attachment.');
  const content=Buffer.from(file.data,'base64');
  total+=content.length;
  if (!content.length || total>ATTACHMENT_LIMIT) throw new TypeError('Attachments must total 3 MB or less.');
  return {name:file.name,data:file.data};
 });
}
