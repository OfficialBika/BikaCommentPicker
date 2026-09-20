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
async function recordComment(giveaway,msg){
 const from=msg.from;
 if(!from||from.is_bot)return {ok:false,reason:'bot'};
 const content=commentContent(msg);
 const rules=giveaway.rules||{};
 if(rules.keyword&&!content.text.toLowerCase().includes(String(rules.keyword).toLowerCase()))return {ok:false,reason:'keyword'};
 if(rules.requireUsername&&!from.username)return {ok:false,reason:'username'};
 try{
  const doc=await Entry.findOneAndUpdate(
   {giveawayId:giveaway._id,userId:String(from.id)},
   {$setOnInsert:{
    giveawayId:giveaway._id,channelId:giveaway.channelId,channelPostId:giveaway.channelPostId,
    groupChatId:String(msg.chat.id),userId:String(from.id),username:from.username||'',
    firstName:from.first_name||'',lastName:from.last_name||'',
    commentMessageId:msg.message_id,commentText:content.text,commentType:content.type,
    enteredAt:new Date(),eligible:true
   }},
   {upsert:true,new:true,rawResult:true}
  );
  return {ok:true,duplicate:!doc.lastErrorObject?.upserted};
 }catch(e){
  if(e.code===11000)return {ok:true,duplicate:true};
  return {ok:false,reason:'db'};
 }
}
module.exports={recordComment,detectCommentType,commentContent};