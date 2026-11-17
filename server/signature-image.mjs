export function safeRasterType(content) {
 if (content.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) return 'image/png';
 if (content[0]===255&&content[1]===216&&content[2]===255) return 'image/jpeg';
 if (/^GIF8[79]a$/.test(content.subarray(0,6).toString('ascii'))) return 'image/gif';
 if (content.subarray(0,4).toString('ascii')==='RIFF'&&content.subarray(8,12).toString('ascii')==='WEBP') return 'image/webp';
 return '';
}
export function signatureImage(value) {
 if (value==null||value==='') return null;
 if (typeof value!=='string'||value.length>350000) throw new TypeError('Signature image must be under 256 KB.');
 const match=value.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([a-zA-Z0-9+/]+={0,2})$/);
 const content=match&&Buffer.from(match[2],'base64');
 if (!content||content.length>256*1024||safeRasterType(content)!==match[1]) {
  throw new TypeError('Choose a PNG, JPEG, GIF, or WebP signature image under 256 KB.');
 }
 return {url:value,type:match[1],content};
}
