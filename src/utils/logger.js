const levels={debug:10,info:20,warn:30,error:40};
function createLogger(level='info'){const threshold=levels[level]??20;return Object.fromEntries(Object.keys(levels).map(k=>[k,(...a)=>{if(levels[k]>=threshold)console[k==='debug'?'log':k](new Date().toISOString(),'['+k.toUpperCase()+']',...a);} ]));}
module.exports={createLogger};