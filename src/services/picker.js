const crypto=require('crypto');
const {Giveaway,Entry,PaidReaction,Winner}=require('../models');

function sampleUnique(items,count){
 const a=items.slice(),out=[];
 for(let i=0;i<count&&a.length;i++){
  const j=crypto.randomInt(a.length);
  out.push(a[j]);
  a[j]=a[a.length-1];
  a.pop();
 }
 return out;
}

function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

/*
 * Reservoir sampling keeps memory proportional to winner count instead of
 * loading every participant into Node.js. Every eligible participant has the
 * same probability of being selected, while MongoDB streams the entries.
 */
async function selectRandomEntries(giveawayId,count,blockedIds){
 const filter={giveawayId,eligible:true};
 if(blockedIds?.size)filter.userId={$nin:[...blockedIds]};
 const cursor=Entry.find(filter)
  .select('userId username firstName lastName')
  .lean()
  .cursor({batchSize:1000});

 const reservoir=[];
 let seen=0;
 try{
  for await(const entry of cursor){
   seen++;
   if(reservoir.length<count){
    reservoir.push(entry);
    continue;
   }
   const j=crypto.randomInt(seen);
   if(j<count)reservoir[j]=entry;
  }
 }finally{
  await cursor.close().catch(()=>{});
 }
 return {candidates:reservoir,candidateCount:seen};
}

async function pickWinners(id,count,options={}){
 const g=await Giveaway.findOneAndUpdate(
  {_id:id,status:'active'},
  {$set:{status:'picking',pickedAt:null},$inc:{stateVersion:1}},
  {new:true}
 );
 if(!g)throw new Error('Giveaway is not active or is already being picked.');

 try{
  const prior=await Winner.find({giveawayId:id}).select('userId').lean();
  const blocked=new Set(prior.map(x=>String(x.userId)));
  const selected=await selectRandomEntries(id,count,blocked);
  if(selected.candidateCount<count){
   throw new Error('Not enough eligible entries: '+selected.candidateCount+' available, '+count+' requested.');
  }

  const durationMs=Math.max(0,Number(options.durationSeconds||0)*1000);
  const onProgress=typeof options.onProgress==='function'?options.onProgress:null;
  if(onProgress&&durationMs>0){
   const started=Date.now();
   let tick=0;
   while(Date.now()-started<durationMs){
    const elapsed=Date.now()-started;
    const ratio=Math.min(1,elapsed/durationMs);
    tick++;
    await onProgress({
     phase:'rolling',
     elapsedMs:elapsed,
     durationMs,
     ratio,
     tick,
     candidateCount:selected.candidateCount
    });
    const remaining=durationMs-(Date.now()-started);
    if(remaining<=0)break;
    await sleep(Math.min(1000,remaining));
   }
  }

  const round=(g.pickRound||0)+1;
  const docs=selected.candidates.map((u,i)=>({
   giveawayId:id,round,userId:u.userId,username:u.username,
   firstName:u.firstName,lastName:u.lastName,selectionMode:'normal',rank:i+1,status:'winner'
  }));
  await Winner.insertMany(docs,{ordered:true});
  const updated=await Giveaway.updateOne(
   {_id:id,status:'picking'},
   {$set:{status:'completed',pickRound:round,pickedAt:new Date()},$inc:{stateVersion:1}}
  );
  if(!updated.modifiedCount)throw new Error('Giveaway state changed before winners could be finalized.');
  return {
   giveaway:g,winners:docs,entryCount:selected.candidateCount,
   candidateCount:selected.candidateCount
  };
 }catch(e){
  await Giveaway.updateOne(
   {_id:id,status:'picking'},
   {$set:{status:'active'},$inc:{stateVersion:1}}
  ).catch(()=>{});
  throw e;
 }
}

async function reroll(id,count){
 const g=await Giveaway.findById(id);
 if(!g)throw new Error('Giveaway not found.');
 if(g.status!=='completed')throw new Error('Giveaway must be completed before reroll.');

 const prior=await Winner.find({giveawayId:id}).select('userId').lean();
 const blocked=new Set(prior.map(x=>String(x.userId)));
 const selected=await selectRandomEntries(id,count,blocked);
 if(selected.candidateCount<count){
  throw new Error('Not enough unused eligible entries for reroll: '+selected.candidateCount+' available, '+count+' requested.');
 }

 await Winner.updateMany({giveawayId:id,status:'winner'},{$set:{status:'rerolled'}});
 const round=(g.pickRound||0)+1;
 const docs=selected.candidates.map((u,i)=>({
  giveawayId:id,round,userId:u.userId,username:u.username,
  firstName:u.firstName,lastName:u.lastName,rank:i+1,status:'winner'
 }));
 await Winner.insertMany(docs,{ordered:true});
 await Giveaway.updateOne(
  {_id:id},
  {$set:{pickRound:round,pickedAt:new Date()},$inc:{stateVersion:1}}
 );
 return {
  giveaway:g,winners:docs,entryCount:selected.candidateCount,
  candidateCount:selected.candidateCount,round
 };
}


async function selectRandomPaidReactors(giveawayId,count,blockedIds){
 const filter={giveawayId,active:true};
 if(blockedIds?.size)filter.userId={$nin:[...blockedIds]};
 const cursor=PaidReaction.find(filter)
  .select('userId username firstName lastName')
  .lean()
  .cursor({batchSize:1000});
 const reservoir=[];
 let seen=0;
 try{
  for await(const reactor of cursor){
   seen++;
   if(reservoir.length<count){reservoir.push(reactor);continue;}
   const j=crypto.randomInt(seen);
   if(j<count)reservoir[j]=reactor;
  }
 }finally{await cursor.close().catch(()=>{});}
 return {candidates:reservoir,candidateCount:seen};
}

async function pickStarWinners(id,count,options={}){
 const g=await Giveaway.findOneAndUpdate(
  {_id:id,status:'active'},
  {$set:{status:'picking',pickedAt:null},$inc:{stateVersion:1}},
  {new:true}
 );
 if(!g)throw new Error('Giveaway is not active or is already being picked.');
 try{
  const prior=await Winner.find({giveawayId:id}).select('userId').lean();
  const blocked=new Set(prior.map(x=>String(x.userId)));
  let selected=null;
  const excludedDuringValidation=new Set();
  for(let attempt=0;attempt<5;attempt++){
   const scanBlocked=new Set([...blocked,...excludedDuringValidation]);
   const result=await selectRandomPaidReactors(id,count,scanBlocked);
   if(result.candidateCount<count)throw new Error('Not enough active paid Star reactors: '+result.candidateCount+' available, '+count+' requested.');
   const ids=result.candidates.map(x=>String(x.userId));
   const stillActive=await PaidReaction.find({giveawayId:id,active:true,userId:{$in:ids}}).select('userId').lean();
   const activeIds=new Set(stillActive.map(x=>String(x.userId)));
   const invalid=ids.filter(x=>!activeIds.has(x));
   if(!invalid.length){selected=result;break;}
   invalid.forEach(x=>excludedDuringValidation.add(x));
  }
  if(!selected)throw new Error('Paid Star reactions changed during picking. Please run /pickstarwinner again.');

  const durationMs=Math.max(0,Number(options.durationSeconds||0)*1000);
  const onProgress=typeof options.onProgress==='function'?options.onProgress:null;
  if(onProgress&&durationMs>0){
   const started=Date.now();
   let tick=0;
   while(Date.now()-started<durationMs){
    const elapsed=Date.now()-started,ratio=Math.min(1,elapsed/durationMs);
    await onProgress({phase:'rolling',elapsedMs:elapsed,durationMs,ratio,tick:++tick,candidateCount:selected.candidateCount});
    const remaining=durationMs-(Date.now()-started);
    if(remaining<=0)break;
    await sleep(Math.min(1000,remaining));
   }
  }
  const round=(g.pickRound||0)+1;
  const docs=selected.candidates.map((u,i)=>({giveawayId:id,round,userId:u.userId,username:u.username,firstName:u.firstName,lastName:u.lastName,selectionMode:'paid_star',rank:i+1,status:'winner'}));
  await Winner.insertMany(docs,{ordered:true});
  const updated=await Giveaway.updateOne({_id:id,status:'picking'},{$set:{status:'completed',pickRound:round,pickedAt:new Date()},$inc:{stateVersion:1}});
  if(!updated.modifiedCount)throw new Error('Giveaway state changed before winners could be finalized.');
  return {giveaway:g,winners:docs,entryCount:selected.candidateCount,candidateCount:selected.candidateCount};
 }catch(e){
  await Giveaway.updateOne({_id:id,status:'picking'},{$set:{status:'active'},$inc:{stateVersion:1}}).catch(()=>{});
  throw e;
 }
}


async function rerollStarWinners(id,count){
 const g=await Giveaway.findById(id);
 if(!g)throw new Error('Giveaway not found.');
 if(g.status!=='completed')throw new Error('Giveaway must be completed before reroll.');
 const prior=await Winner.find({giveawayId:id}).select('userId').lean();
 const blocked=new Set(prior.map(x=>String(x.userId)));
 const selected=await selectRandomPaidReactors(id,count,blocked);
 if(selected.candidateCount<count)throw new Error('Not enough unused active paid Star reactors for reroll: '+selected.candidateCount+' available, '+count+' requested.');
 const ids=selected.candidates.map(x=>String(x.userId));
 const active=await PaidReaction.countDocuments({giveawayId:id,active:true,userId:{$in:ids}});
 if(active<count)throw new Error('Paid Star reactions changed during reroll. Please try again.');
 await Winner.updateMany({giveawayId:id,status:'winner'},{$set:{status:'rerolled'}});
 const round=(g.pickRound||0)+1;
 const docs=selected.candidates.map((u,i)=>({giveawayId:id,round,userId:u.userId,username:u.username,firstName:u.firstName,lastName:u.lastName,selectionMode:'paid_star',rank:i+1,status:'winner'}));
 await Winner.insertMany(docs,{ordered:true});
 await Giveaway.updateOne({_id:id},{$set:{pickRound:round,pickedAt:new Date()},$inc:{stateVersion:1}});
 return {giveaway:g,winners:docs,entryCount:selected.candidateCount,candidateCount:selected.candidateCount,round};
}

module.exports={pickWinners,reroll,rerollStarWinners,pickStarWinners,sampleUnique,selectRandomEntries,selectRandomPaidReactors};
