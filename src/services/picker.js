const crypto=require('crypto');
const {Giveaway,Entry,Winner}=require('../models');

function sampleUnique(items,count){
 const a=items.slice(),out=[];
 for(let i=0;i<count&&a.length;i++){const j=crypto.randomInt(a.length);out.push(a[j]);a[j]=a[a.length-1];a.pop();}
 return out;
}

function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

async function pickWinners(id,count,options={}){
 const g=await Giveaway.findOneAndUpdate(
  {_id:id,status:'active'},
  {$set:{status:'picking',pickedAt:null},$inc:{stateVersion:1}},
  {new:true}
 );
 if(!g)throw new Error('Giveaway is not active or is already being picked.');

 try{
  const entries=await Entry.find({giveawayId:id,eligible:true}).lean();
  const prior=await Winner.find({giveawayId:id}).select('userId').lean();
  const blocked=new Set(prior.map(x=>String(x.userId)));
  const candidates=entries.filter(x=>!blocked.has(String(x.userId)));
  if(candidates.length<count)throw new Error('Not enough eligible entries: '+candidates.length+' available, '+count+' requested.');

  const durationMs=Math.max(0,Number(options.durationSeconds||0)*1000);
  const onProgress=typeof options.onProgress==='function'?options.onProgress:null;
  if(onProgress&&durationMs>0){
   const started=Date.now();
   let tick=0;
   while(Date.now()-started<durationMs){
    const elapsed=Date.now()-started;
    const ratio=Math.min(1,elapsed/durationMs);
    tick++;
    await onProgress({elapsedMs:elapsed,durationMs,ratio,tick,candidateCount:candidates.length});
    const remaining=durationMs-(Date.now()-started);
    if(remaining<=0)break;
    await sleep(Math.min(1000,remaining));
   }
  }

  const chosen=sampleUnique(candidates,count);
  const round=(g.pickRound||0)+1;
  const docs=chosen.map((u,i)=>({giveawayId:id,round,userId:u.userId,username:u.username,firstName:u.firstName,lastName:u.lastName,rank:i+1,status:'winner'}));
  await Winner.insertMany(docs);
  await Giveaway.updateOne({_id:id,status:'picking'},{$set:{status:'completed',pickRound:round,pickedAt:new Date()},$inc:{stateVersion:1}});
  return {giveaway:g,winners:docs,entryCount:entries.length,candidateCount:candidates.length};
 }catch(e){
  await Giveaway.updateOne({_id:id,status:'picking'},{$set:{status:'active'},$inc:{stateVersion:1}}).catch(()=>{});
  throw e;
 }
}

async function reroll(id,count){
 const g=await Giveaway.findById(id);
 if(!g)throw new Error('Giveaway not found.');
 if(g.status!=='completed')throw new Error('Giveaway must be completed before reroll.');
 const entries=await Entry.find({giveawayId:id,eligible:true}).lean();
 const prior=await Winner.find({giveawayId:id}).select('userId').lean();
 const blocked=new Set(prior.map(x=>String(x.userId)));
 const candidates=entries.filter(x=>!blocked.has(String(x.userId)));
 if(candidates.length<count)throw new Error('Not enough unused eligible entries for reroll.');
 await Winner.updateMany({giveawayId:id,status:'winner'},{$set:{status:'rerolled'}});
 const round=(g.pickRound||0)+1;
 const docs=sampleUnique(candidates,count).map((u,i)=>({giveawayId:id,round,userId:u.userId,username:u.username,firstName:u.firstName,lastName:u.lastName,rank:i+1,status:'winner'}));
 await Winner.insertMany(docs);
 await Giveaway.updateOne({_id:id},{$set:{pickRound:round,pickedAt:new Date()},$inc:{stateVersion:1}});
 return {giveaway:g,winners:docs,entryCount:entries.length,candidateCount:candidates.length,round};
}

module.exports={pickWinners,reroll,sampleUnique};
