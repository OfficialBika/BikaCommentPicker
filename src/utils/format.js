function esc(v=''){return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function mention(u){
 const id=String(u?.id??'').trim();
 const name=[u?.firstName,u?.lastName].filter(Boolean).join(' ')||u?.username||'User';
 const label=u?.username?'@'+u.username:name;
 // Telegram officially supports tg://user?id=... as an inline HTML mention.
 // Always using the stable numeric user ID avoids breaking when a username
 // changes or is absent. The visible label remains the username when available.
 if(/^\d+$/.test(id))return '<a href="tg://user?id='+id+'">'+esc(label)+'</a>';
 return esc(label);
}
function progress(done,total,size=12){const f=total?Math.round(done/total*size):0;return '▰'.repeat(Math.min(size,f))+'▱'.repeat(Math.max(0,size-f));}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
module.exports={esc,mention,progress,sleep};