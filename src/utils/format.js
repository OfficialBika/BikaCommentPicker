function esc(v=''){return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function mention(u){
 const id=String(u?.id??'').trim();
 const name=[u?.firstName,u?.lastName].filter(Boolean).join(' ')||u?.username||'User';
 const label=u?.username?'@'+u.username:name;
 if(/^\d+$/.test(id))return '<a href="tg://user?id='+id+'">'+esc(label)+'</a>';
 return esc(label);
}
function progress(done,total,size=12){const f=total?Math.round(done/total*size):0;return '▰'.repeat(Math.min(size,f))+'▱'.repeat(Math.max(0,size-f));}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function paginate(items,page=1,pageSize=10){
 const n=Number(page),s=Number(pageSize);
 const safePage=Math.max(1,Number.isSafeInteger(n)?n:1);
 const safeSize=Math.max(1,Math.min(100,Number.isSafeInteger(s)?s:10));
 const totalPages=Math.max(1,Math.ceil(items.length/safeSize));
 const currentPage=Math.min(safePage,totalPages);
 return {items:items.slice((currentPage-1)*safeSize,currentPage*safeSize),page:currentPage,totalPages,totalItems:items.length,pageSize:safeSize};
}
function normalizeMessageText(value){
 const text=String(value??'');
 return text.replace(/\\\\n/g,'\n').replace(/\\r\n/g,'\n').replace(/\\r/g,'\n').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
}
function formatMessage(lines,{maxBlankLines=1}={}){
 const input=Array.isArray(lines)?lines:[lines];
 const normalized=input.map(normalizeMessageText).join('\n').split('\n');
 const output=[];let blanks=0;
 for(const line of normalized){
  const trimmed=line.trim();
  if(!trimmed){blanks++;if(blanks>maxBlankLines)continue;output.push('');}
  else{blanks=0;output.push(trimmed);}
 }
 return output.join('\n').trim();
}
module.exports={esc,mention,progress,sleep,paginate,normalizeMessageText,formatMessage};
