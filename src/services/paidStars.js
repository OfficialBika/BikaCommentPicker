const {TelegramClient,Api}=require('telegram');
const {StringSession}=require('telegram/sessions');

async function createPaidStarClient(cfg,logger){
 if(!cfg.telegramApiId||!cfg.telegramApiHash){
  logger.warn('Paid Star MTProto sync disabled: TG_API_ID/TG_API_HASH are not configured.');
  return null;
 }
 const client=new TelegramClient(new StringSession(''),cfg.telegramApiId,cfg.telegramApiHash,{connectionRetries:5});
 await client.start({botAuthToken:cfg.botToken});
 logger.info('Paid Star MTProto client ready');
 return client;
}

function paidStarMtStatus(client){
 return {enabled:!!client};
}

function getUpdatesArray(result){
 return Array.isArray(result?.updates)?result.updates:[];
}

function findReactionContainers(value,seen=new Set(),out=[]){
 if(value==null||typeof value!=='object'||seen.has(value))return out;
 seen.add(value);
 if(Array.isArray(value)){
  for(const item of value)findReactionContainers(item,seen,out);
  return out;
 }
 if(Array.isArray(value.topReactors))out.push(value);
 for(const key of ['updates','update','reactions','results','recentReactions']){
  if(value[key]!=null)findReactionContainers(value[key],seen,out);
 }
 return out;
}

function peerIdToString(peer){
 if(!peer)return null;
 for(const key of ['userId','userID']){
  if(peer[key]!=null)return String(peer[key]);
 }
 if(peer.userId!=null)return String(peer.userId);
 return null;
}

function userIdToString(user){
 return user?.id!=null?String(user.id):null;
}

async function syncPaidStarReactors(client,g,{logger}={}){
 if(!client)throw new Error('MTProto client is not configured.');
 const channelId=String(g.channelId||'');
 const postId=Number(g.channelPostId||0);
 if(!channelId||!Number.isInteger(postId)||postId<1)throw new Error('Giveaway is missing channelId/channelPostId.');

 const peer=await client.getEntity(channelId);
 const result=await client.invoke(new Api.messages.GetMessagesReactions({
  peer,
  id:[postId]
 }));

 const containers=findReactionContainers(result);
 const top=[];
 const seen=new Set();
 for(const container of containers){
  for(const reactor of container.topReactors||[]){
   const id=peerIdToString(reactor?.peerId);
   if(!id||seen.has(id)||reactor?.anonymous)continue;
   seen.add(id);
   top.push({id,count:Number(reactor.count||0)});
  }
 }
 const users=Array.isArray(result?.users)?result.users:[];
 const userMap=new Map(users.map(u=>[userIdToString(u),u]));
 const {PaidReaction}=require('../models');
 let synced=0;
 for(const reactor of top){
  const u=userMap.get(reactor.id);
  if(!u)continue;
  await PaidReaction.findOneAndUpdate(
   {giveawayId:g._id,userId:reactor.id},
   {$set:{
    channelId,channelPostId:postId,userId:reactor.id,
    username:u.username||'',
    firstName:u.firstName||'',
    lastName:u.lastName||'',
    active:true,
    starCount:Math.max(1,Math.min(100000,Number(reactor.count)||1)),
    lastReactionAt:new Date()
   }},
   {upsert:true,new:true}
  );
  synced++;
 }
 if(logger)logger.info('Paid Star leaderboard synced',{channelId,postId,topReactors:top.length,synced});
 return {total:top.length,synced,reactors:top};
}

module.exports={createPaidStarClient,syncPaidStarReactors,paidStarMtStatus};
