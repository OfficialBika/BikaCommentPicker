const {Entry}=require('../models');
function detectCommentType(msg){
 if(msg?.sticker)return 'sticker';
 if(msg?.animation)return 'animation';
 if(msg?.photo)return 'photo';
 if(msg?.video)return 'video';
 if(msg?.video_note)return 'video_note';
 if(msg?.document)return 'document';
 if(msg?.voice)return 'voice';
 if(msg?.audio)return 'audio';
 if(msg?.contact)return 'contact';
 if(msg?.location)return 'location';
 if(msg?.venue)return 'venue';
 if(msg?.poll)return 'poll';
 if(msg?.dice)return 'dice';
 return 'text';
}
function commentContent(msg){
 const text=msg?.text||msg?.caption||'';
 if(text)return {text,type:'text'};
 const type=detectCommentType(msg);
 const labels={
  sticker:'Sticker',
  animation:'Media',
  photo:'Media',
  video:'Media',
  video_note:'Media',
  document:'Media',
  voice:'Media',
  audio:'Media',
  contact:'Media',
  location:'Media',
  venue:'Media',
  poll:'Media',
  dice:'Emoji'
 };
 return {text:labels[type]||'Media',type};
}
function isEarlierMessageId(candidateId,currentId){
 const candidate=Number(candidateId),current=Number(currentId);
 return Number.isSafeInteger(candidate)&&candidate>0&&Number.isSafeInteger(current)&&current>0&&candidate<current;
}
function rejectionReason(giveaway,msg,content,forceRejectReason){
 if(forceRejectReason)return String(forceRejectReason);
 const rules=giveaway.rules||{};
 if(rules.keyword&&!content.text.toLowerCase().includes(String(rules.keyword).toLowerCase()))return 'keyword';
 if(rules.requireUsername&&!msg.from?.username)return 'username';
 if(rules.requireBotStart)return 'bot_start_not_implemented';
 return null;
}
async function recordComment(giveaway,msg,{forceRejectReason=null}={}){
 const from=msg.from;
 if(!from||from.is_bot)return {ok:false,reason:'bot'};
 const content=commentContent(msg);
 const rejectedReason=rejectionReason(giveaway,msg,content,forceRejectReason);
 const messageId=Number(msg.message_id);
 if(!Number.isSafeInteger(messageId)||messageId<1)return {ok:false,reason:'invalid_message_id'};
 const fields={
  giveawayId:giveaway._id,channelId:giveaway.channelId,channelPostId:giveaway.channelPostId,
  groupChatId:String(msg.chat.id),userId:String(from.id),username:from.username||'',
  firstName:from.first_name||'',lastName:from.last_name||'',
  commentMessageId:messageId,commentText:content.text,commentType:content.type,
  enteredAt:Number.isInteger(msg.date)?new Date(msg.date*1000):new Date(),
  eligible:!rejectedReason,rejectedReason:rejectedReason||''
 };
 const filter={giveawayId:giveaway._id,userId:String(from.id)};
 try{
  const result=await Entry.findOneAndUpdate(filter,{$setOnInsert:fields},{upsert:true,new:true,rawResult:true});
  const inserted=!!result.lastErrorObject?.upserted;
  if(!inserted){
   const existing=await Entry.findOne(filter).select('commentMessageId').lean();
   if(existing&&isEarlierMessageId(messageId,existing.commentMessageId)){
    await Entry.updateOne({...filter,commentMessageId:{$gt:messageId}},{$set:fields});
   }
  }
  return {ok:true,duplicate:!inserted,rejectedReason};
 }catch(e){
  if(e.code===11000){
   const existing=await Entry.findOne(filter).select('commentMessageId').lean().catch(()=>null);
   if(existing&&isEarlierMessageId(messageId,existing.commentMessageId)){
    await Entry.updateOne({...filter,commentMessageId:{$gt:messageId}},{$set:fields}).catch(()=>{});
   }
   return {ok:true,duplicate:true,rejectedReason};
  }
  return {ok:false,reason:'db'};
 }
}
module.exports={recordComment,detectCommentType,commentContent,isEarlierMessageId,rejectionReason};