function esc(v=''){return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function mention(u){const n=esc([u.firstName,u.lastName].filter(Boolean).join(' ')||u.username||'User');return u.id?'<a href="tg://user?id='+u.id+'">'+n+'</a>':n;}
function progress(done,total,size=12){const f=total?Math.round(done/total*size):0;return '▰'.repeat(Math.min(size,f))+'▱'.repeat(Math.max(0,size-f));}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
module.exports={esc,mention,progress,sleep};