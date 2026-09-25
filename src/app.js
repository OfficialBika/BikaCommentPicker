const express=require('express');
const TelegramBot=require('node-telegram-bot-api');
const mongoose=require('mongoose');
const {loadConfig}=require('./config');
const {createLogger}=require('./utils/logger');
const {esc,mention,progress}=require('./utils/format');
const {User,Group,Giveaway,Entry,PaidReaction,Winner,BroadcastJob,AuditEvent}=require('./models');
const {pickWinners,reroll,rerollStarWinners,pickStarWinners}=require('./services/picker');
const {recordComment}=require('./services/entry');
const {runBroadcast}=require('./services/broadcast');
const {cleanupTemporaryGiveawayData}=require('./services/cleanup');
const {createPaidStarClient,syncPaidStarReactors,paidStarMtStatus}=require('./services/paidStars');

async function start(){
 const cfg=loadConfig();const logger=createLogger(cfg.logLevel);
 await mongoose.connect(cfg.mongoUri,{serverSelectionTimeoutMS:10000});logger.info('MongoDB connected');
 await cleanupTemporaryGiveawayData({retentionDays:cfg.tempDataRetentionDays,logger}).catch(e=>logger.warn('Initial temporary-data cleanup failed: '+(e.message||e)));
 const cleanupTimer=setInterval(()=>cleanupTemporaryGiveawayData({retentionDays:cfg.tempDataRetentionDays,logger}).catch(e=>logger.warn('Scheduled temporary-data cleanup failed: '+(e.message||e))),cfg.cleanupIntervalMinutes*60*1000);
 cleanupTimer.unref?.();
 const bot=new TelegramBot(cfg.botToken);const app=express();app.use(express.json({limit:'1mb'}));
 const paidStarClient=await createPaidStarClient(cfg,logger);
 app.get('/',(_,res)=>res.type('text').send('Cmt Picker V2 Pro is running.'));
 app.get('/health',(_,res)=>res.json({ok:true,status:'healthy',uptime:process.uptime(),mongo:mongoose.connection.readyState===1}));
 app.get('/ready',(_,res)=>res.status(mongoose.connection.readyState===1?200:503).json({ok:mongoose.connection.readyState===1}));
 const path='/telegram/comments_picker_v2_webhook';
 const allowedUpdates=['message','channel_post','callback_query','message_reaction','message_reaction_count'];
 app.post(path,(req,res)=>{
  // A Telegram webhook must receive a fast 2xx response. Never make Telegram
  // wait for MongoDB or winner-processing work before acknowledging the update.
  if(!res.headersSent)res.status(200).json({ok:true});
  Promise.resolve(handleUpdate(req.body)).catch(e=>{
   logger.error('update error',e.stack||e.message);
  });
 });
 const server=app.listen(cfg.port);
 await new Promise((resolve,reject)=>{
  server.once('listening',resolve);
  server.once('error',reject);
 });
 logger.info('HTTP server listening on '+cfg.port);
 if(cfg.publicUrl){
  const webhookUrl=cfg.publicUrl.replace(/\/$/,'')+path;
  try{
   const result=await bot.setWebHook(webhookUrl,{allowed_updates:allowedUpdates});
   logger.info('Telegram webhook configured',{url:webhookUrl,result,allowedUpdates});
  }catch(e){
   logger.error('Telegram webhook setup failed: '+(e.message||e));
   throw e;
  }
  try{
   const wh=await bot.getWebHookInfo();
   const actualAllowed=Array.isArray(wh.allowed_updates)?wh.allowed_updates:[];
   logger.info('Telegram webhook ready',{
    url:wh.url||'',
    pending:wh.pending_update_count||0,
    allowed:actualAllowed,
    lastError:wh.last_error_message||null
   });
   if(wh.url!==webhookUrl)logger.warn('Telegram webhook URL mismatch');
   if(!actualAllowed.includes('message_reaction'))logger.warn('Telegram webhook is missing message_reaction');
   if(!actualAllowed.includes('message_reaction_count'))logger.warn('Telegram webhook is missing message_reaction_count');
   if(wh.last_error_message)logger.warn('Telegram reports a previous webhook delivery error; verify /health and the POST endpoint before treating this as a current failure.');
  }catch(e){
   logger.warn('Unable to verify Telegram webhook: '+(e.message||e));
  }
 }else{
  logger.warn('PUBLIC_URL is not configured; Telegram reaction updates cannot reach this webhook.');
 }
 async function saveUser(f){if(!f)return;await User.updateOne({id:String(f.id)},{$set:{username:f.username||'',firstName:f.first_name||'',lastName:f.last_name||'',lastSeenAt:new Date()}},{upsert:true}).catch(()=>{});}
 async function saveGroup(c){if(!c||!['group','supergroup'].includes(c.type))return;await Group.updateOne({id:String(c.id)},{$set:{title:c.title||'',type:c.type,username:c.username||'',lastSeenAt:new Date()}},{upsert:true}).catch(()=>{});}
 async function handleUpdate(u){if(u.callback_query)return callback(u.callback_query);if(u.message_reaction)return reactionUpdate(u.message_reaction);if(u.message_reaction_count)return reactionCountUpdate(u.message_reaction_count);const m=u.message||u.channel_post;if(u.message?.text&&(/^(?:\/|\.s(?:\s|$))/i.test(u.message.text))){if(m?.from)await saveUser(m.from);if(m?.chat)await saveGroup(m.chat);return command(u.message);}if(u.channel_post){if(m?.chat)await saveGroup(m.chat);return channelPost(u.channel_post);}if(m?.reply_to_message)return comment(m);}
 async function channelPost(p){const text=p.text||p.caption||'';if(!text.toLowerCase().includes(cfg.mentionTag.toLowerCase()))return;await Giveaway.findOneAndUpdate({channelId:String(p.chat.id),channelPostId:p.message_id},{$setOnInsert:{channelId:String(p.chat.id),channelPostId:p.message_id,title:text.slice(0,120),status:'active',winnerCount:1,durationSeconds:cfg.rollDurationSeconds,createdAt:new Date()}},{upsert:true,new:true});}
 function extractChannelOrigin(msg){
  const r=msg?.reply_to_message;
  if(!r)return null;
  const o=r.forward_origin;
  if(o?.type==='channel'&&o.chat?.id&&o.message_id){
   return {channelId:String(o.chat.id),channelPostId:Number(o.message_id)};
  }
  // Compatibility with older Bot API payloads.
  if(r.forward_from_chat?.id&&r.forward_from_message_id){
   return {channelId:String(r.forward_from_chat.id),channelPostId:Number(r.forward_from_message_id)};
  }
  // Newer Bot API can expose cross-chat reply information here.
  const e=r.external_reply;
  const eo=e?.origin;
  if(eo?.type==='channel'&&e.chat?.id&&e.message_id){
   return {channelId:String(e.chat.id),channelPostId:Number(e.message_id)};
  }
  return null;
 }
 async function findGiveaway(msg,explicitId){
  if(explicitId){
   const byId=await Giveaway.findById(explicitId).catch(()=>null);
   if(byId&&(!byId.discussionChatId||String(byId.discussionChatId)===String(msg.chat.id)))return byId;
  }
  const origin=extractChannelOrigin(msg);
  if(origin){
   const g=await Giveaway.findOne({channelId:origin.channelId,channelPostId:origin.channelPostId}).sort({createdAt:-1});
   if(g){
    if(!g.discussionChatId&&['group','supergroup'].includes(msg.chat?.type)){
     g.discussionChatId=String(msg.chat.id);
     await g.save();
    }
    return g;
   }
  }
  const r=msg.reply_to_message;
  if(r){
   const postId=r.forward_from_message_id||r.message_id;
   const ch=String(r.forward_from_chat?.id||r.chat?.id||'');
   const g=await Giveaway.findOne({channelPostId:postId,$or:[{channelId:ch},{discussionChatId:String(msg.chat.id)}]}).sort({createdAt:-1});
   if(g)return g;
  }
  // Commands posted anywhere in the giveaway discussion chat should resolve
  // to the active giveaway even when the command replies to another comment.
  if(['group','supergroup'].includes(msg.chat?.type)){
   const g=await Giveaway.findOne({
    discussionChatId:String(msg.chat.id),
    status:{$in:['active','picking']}
   }).sort({createdAt:-1});
   if(g)return g;
  }
  return null;
 }
 async function comment(m){if(!['group','supergroup'].includes(m.chat.type))return;const g=await findGiveaway(m);if(g?.status==='active'){if(!g.discussionChatId){g.discussionChatId=String(m.chat.id);await g.save();}await recordComment(g,m);}}
function customEmoji(id,fallback){return fallback;}
function winnerDisplay(w){
 return mention({
  id:w.userId,
  firstName:w.firstName,
  lastName:w.lastName,
  username:w.username
 });
}
function hasPaidReaction(reactions){return Array.isArray(reactions)&&reactions.some(r=>r&&r.type==='paid');}
 async function reactionUpdate(r){
  const channelId=r?.chat?.id!=null?String(r.chat.id):'';
  const postId=Number(r?.message_id||0);
  if(!channelId||!Number.isInteger(postId)||postId<1)return;

  const g=await Giveaway.findOne({channelId,channelPostId:postId});
  if(!g){
   await AuditEvent.create({
    action:'paid_star_reaction_orphan',
    actorId:r.user?.id!=null?String(r.user.id):'anonymous',
    targetId:String(postId),
    meta:{channelId,hasUser:!!r.user,hasPaidReaction:hasPaidReaction(r.new_reaction)}
   }).catch(()=>{});
   return;
  }

  const now=new Date();
  await Giveaway.updateOne({_id:g._id},{$set:{lastReactionUpdateAt:now}}).catch(()=>{});

  // Telegram omits user for anonymous reactions and supplies actor_chat instead.
  // Anonymous reactions are counted for diagnostics, but cannot be selected as  // individual winners because there is no Telegram user ID to persist.
  if(!r.user?.id){
   await AuditEvent.create({
    action:hasPaidReaction(r.new_reaction)?'paid_star_anonymous_reaction':'anonymous_reaction_changed',
    actorId:'anonymous',
    giveawayId:g._id,
    targetId:String(postId),
    meta:{channelId,actorChatId:r.actor_chat?.id!=null?String(r.actor_chat.id):null}
   }).catch(()=>{});
   return;
  }

  const active=hasPaidReaction(r.new_reaction);
  const user=r.user;
  const existing=await PaidReaction.findOne({giveawayId:g._id,userId:String(user.id)})
   .select('manualOverride')
   .lean();
  const effectiveActive=existing?.manualOverride===true?true:active;
  await PaidReaction.findOneAndUpdate(
   {giveawayId:g._id,userId:String(user.id)},
   {$set:{
    channelId,channelPostId:postId,userId:String(user.id),
    username:user.username||'',firstName:user.first_name||'',lastName:user.last_name||'',
    active:effectiveActive,lastReactionAt:now
   },$setOnInsert:{starCount:1,manualOverride:false}},
   {upsert:true,new:true}
  );
  await saveUser(user);
  await AuditEvent.create({
   action:active?'paid_star_reaction_added':'paid_star_reaction_removed',
   actorId:String(user.id),giveawayId:g._id,targetId:String(postId),
   meta:{channelId,oldPaidReaction:hasPaidReaction(r.old_reaction),newPaidReaction:active}
  }).catch(()=>{});
 }
 async function reactionCountUpdate(r){
  const channelId=r?.chat?.id!=null?String(r.chat.id):'';
  const postId=Number(r?.message_id||0);
  if(!channelId||!Number.isInteger(postId)||postId<1)return;
  const g=await Giveaway.findOne({channelId,channelPostId:postId});
  if(!g)return;

  const paid=r.reactions?.find(x=>x?.type==='paid');
  const anonymousPaidStarCount=Number(paid?.total_count||0);
  const now=new Date();
  await Giveaway.updateOne({_id:g._id},{$set:{
   anonymousPaidStarCount,
   anonymousPaidStarCountUpdatedAt:now,
   lastReactionUpdateAt:now
  }}).catch(()=>{});
  await AuditEvent.create({
   action:'paid_star_anonymous_count_updated',
   actorId:'telegram',
   giveawayId:g._id,
   targetId:String(postId),
   meta:{channelId,anonymousPaidStarCount}
  }).catch(()=>{});
 }
 async function owner(id){return cfg.ownerId&&String(id)===cfg.ownerId;}
 async function admin(m){if(await owner(m.from.id))return true;if(!['group','supergroup'].includes(m.chat.type))return false;try{const x=await bot.getChatMember(m.chat.id,m.from.id);return ['administrator','creator'].includes(x.status);}catch{return false;}}
 async function command(m){const parts=(m.text||'').trim().split(/\s+/);const cmd=(parts[0]||'').split('@')[0].toLowerCase();
  if(cmd==='/start')return bot.sendMessage(m.chat.id,'🎟️ <b>CMT PICKER V2 PRO</b>\n━━━━━━━━━━━━━━━━━━\n\n🎁 <b>Giveaway Picker</b>\n⭐ <b>Paid Star Picker</b>\n🔄 <b>Reroll & Winner History</b>\n🛡️ <b>Secure Admin Controls</b>\n\n━━━━━━━━━━━━━━━━━━\n✅ <i>System ready for secure winner selection.</i>',{parse_mode:'HTML'});
  if(cmd==='/approve'){if(!await owner(m.from.id))return bot.sendMessage(m.chat.id,'⛔ <b>OWNER ONLY</b>\n\nYou do not have permission to use this command.');await Group.updateOne({id:String(m.chat.id)},{$set:{approved:true}},{upsert:true});return bot.sendMessage(m.chat.id,'✅ Group approved for comment collection.');}
  if(cmd==='/admin'){if(!await owner(m.from.id))return bot.sendMessage(m.chat.id,'⛔ <b>OWNER ONLY</b>\n\nYou do not have permission to use this command.');const [u,g,w,e]=await Promise.all([User.countDocuments(),Group.countDocuments(),Giveaway.countDocuments(),Entry.countDocuments()]);return bot.sendMessage(m.chat.id,'<b>V2 PRO DASHBOARD</b>\n\n👤 Users: <b>'+u+'</b>\n👥 Groups: <b>'+g+'</b>\n🎁 Giveaways: <b>'+w+'</b>\n💬 Entries: <b>'+e+'</b>\n\n/status - system health',{parse_mode:'HTML'});}
  if(cmd==='/status'){if(!await owner(m.from.id))return bot.sendMessage(m.chat.id,'⛔ <b>OWNER ONLY</b>\n\nYou do not have permission to use this command.');return bot.sendMessage(m.chat.id,'🟢 <b>V2 Pro Online</b>\nUptime: '+Math.floor(process.uptime())+'s\nMongo: '+(mongoose.connection.readyState===1?'connected':'disconnected')+'\nNode: '+process.version,{parse_mode:'HTML'});}  if(cmd==='/giveaway')return createGiveaway(m,parts[1],parts.slice(2).join(' '));
  if(cmd==='/pickwinner')return pick(m,parts[1]);
  if(cmd==='/pickstarwinner')return pickStar(m,parts[1]);
  if(cmd==='/cleanstar')return cleanStar(m,parts[1]);
  if(cmd==='.s')return setManualStars(m,parts[1]);
  if(cmd==='/reroll')return rerollCmd(m,parts[1]);
  if(cmd==='/winnerlist')return winnerList(m);
  if(cmd==='/starstatus')return starStatus(m);
  if(cmd==='/starsync')return starSync(m);
  if(cmd==='/broadcast')return broadcast(m,parts.slice(1).join(' '));
 }
 async function cleanStar(m,arg){
  if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ <b>ADMIN ACCESS REQUIRED</b>\n\nOnly the group admin or bot owner can use this command.');
  const g=await findGiveaway(m,arg);
  if(!g)return bot.sendMessage(m.chat.id,'❌ <b>GIVEAWAY NOT FOUND</b>\n\nReply to the giveaway post or provide a valid Giveaway ID.',{parse_mode:'HTML',reply_to_message_id:m.message_id});

  const winners=await Winner.find({giveawayId:g._id}).select('userId selectionMode status round').lean();
  const hasNonPaid=winners.some(w=>w.selectionMode!=='paid_star');
  if(hasNonPaid){
   return bot.sendMessage(m.chat.id,'⚠️ <b>CLEAN STAR BLOCKED</b>\n\nThis giveaway already contains a normal/comment winner record. I will not delete that winner history. Use this only to reset a Paid Star draw.',{parse_mode:'HTML',reply_to_message_id:m.message_id});
  }
  const paidWinners=winners.filter(w=>w.selectionMode==='paid_star');
  const paidReactions=await PaidReaction.countDocuments({giveawayId:g._id});
  if(!paidWinners.length&&!paidReactions){
   return bot.sendMessage(m.chat.id,'ℹ️ <b>NOTHING TO CLEAN</b>\n\nThere is no Paid Star list or Paid Star winner record for this giveaway.',{parse_mode:'HTML',reply_to_message_id:m.message_id});
  }

  const [deletedReactions,deletedWinners]=await Promise.all([
   PaidReaction.deleteMany({giveawayId:g._id}),
   Winner.deleteMany({giveawayId:g._id,selectionMode:'paid_star'})
  ]);
  await Giveaway.updateOne(
   {_id:g._id},
   {$set:{status:'active',pickRound:0,pickedAt:null},$inc:{stateVersion:1}}
  );
  await AuditEvent.create({
   action:'clean_paid_star',
   actorId:String(m.from.id),
   giveawayId:g._id,
   meta:{
    deletedPaidReactions:deletedReactions.deletedCount||0,
    deletedPaidStarWinners:deletedWinners.deletedCount||0,
    source:'owner_or_admin_command'
   }
  }).catch(()=>{});

  return bot.sendMessage(m.chat.id,
   '🧹 <b>PAID STAR RESET COMPLETE</b>\n━━━━━━━━━━━━━━━━━━\n\n'+
   '🆔 <b>Giveaway Post</b>\n└ #'+esc(g.channelPostId)+'\n\n'+
   '⭐ <b>Old Star Records Removed</b>\n└ '+(deletedReactions.deletedCount||0)+'\n'+
   '🏆 <b>Old Star Winners Removed</b>\n└ '+(deletedWinners.deletedCount||0)+'\n\n'+
   '🔄 Giveaway is <b>ACTIVE</b> again.\n\n'+
   'Next:\n'+
   '└ Reply to each participant and use <code>.s N</code>\n'+
   '└ Then use <code>/pickstarwinner 5</code>\n'+
   '━━━━━━━━━━━━━━━━━━',
   {parse_mode:'HTML',reply_to_message_id:m.message_id}
  );
 }

 async function setManualStars(m,value){
  if(!await owner(m.from.id))return bot.sendMessage(m.chat.id,'⛔ <b>OWNER ONLY</b>\n\nYou do not have permission to use this command.');

  const reply=m.reply_to_message;
  if(!reply)return bot.sendMessage(m.chat.id,'❌ <b>PAID STAR RECORDING</b>\n\nReply to the participant comment.\n\nUsage: <code>.s 4</code>');

  const raw=String(value||'').trim();
  if(!/^\d+$/.test(raw)){
   return bot.sendMessage(m.chat.id,'❌ <b>INVALID STAR AMOUNT</b>\n\nEnter a whole number.\n\nExample: <code>.s 4</code>');
  }

  const starCount=Number(raw);
  if(!Number.isSafeInteger(starCount)||starCount<1||starCount>100000){
   return bot.sendMessage(m.chat.id,'❌ <b>INVALID STAR AMOUNT</b>\n\nStar amount must be between <b>1</b> and <b>100,000</b>.');
  }

  const target=reply.from;
  if(!target?.id){
   return bot.sendMessage(m.chat.id,'❌ <b>INVALID PARTICIPANT</b>\n\nReply to a comment sent by a Telegram user.');
  }
  if(target.is_bot){
   return bot.sendMessage(m.chat.id,'❌ <b>INVALID PARTICIPANT</b>\n\nBot accounts cannot be recorded as Paid Star participants.');
  }

  let g=null;
  // Most reliable path: the bot already stored this exact discussion comment.
  const entry=await Entry.findOne({
   groupChatId:String(m.chat.id),
   commentMessageId:Number(reply.message_id)
  }).select('giveawayId').lean();
  if(entry?.giveawayId)g=await Giveaway.findById(entry.giveawayId);

  // Fallback to the normal giveaway resolver for forwarded/cross-chat replies.
  if(!g)g=await findGiveaway(m);

  if(!g)return bot.sendMessage(m.chat.id,'❌ <b>GIVEAWAY NOT FOUND</b>\n\nReply directly to a participant comment under the giveaway post.');

  if(['cancelled','expired'].includes(g.status)){
   return bot.sendMessage(m.chat.id,'⚠️ <b>GIVEAWAY CLOSED</b>\n\nPaid Star recording is no longer available for this giveaway.');
  }

  const now=new Date();
  const userId=String(target.id);
  const doc=await PaidReaction.findOneAndUpdate(
   {giveawayId:g._id,userId},
   {$set:{
    channelId:String(g.channelId),
    channelPostId:Number(g.channelPostId),
    userId,
    username:target.username||'',
    firstName:target.first_name||'',
    lastName:target.last_name||'',
    starCount,
    manualOverride:true,
    active:true,
    lastReactionAt:now
   }},
   {upsert:true,new:true,setDefaultsOnInsert:true}
  );

  await saveUser(target);
  await AuditEvent.create({
   action:'manual_paid_star_set',
   actorId:String(m.from.id),
   giveawayId:g._id,
   targetId:userId,
   meta:{
    starCount,
    source:'owner_reply_command',
    replyMessageId:Number(reply.message_id)
   }
  }).catch(()=>{});

  const display=doc.username?'@'+esc(doc.username):esc([doc.firstName,doc.lastName].filter(Boolean).join(' ')||'User');
  return bot.sendMessage(
   m.chat.id,
   '⭐ <b>PAID STAR RECORDED</b>\n\n'+
   '━━━━━━━━━━━━━━━━━━\n'+
   '👤 <b>User</b>\n└ '+display+'\n\n'+
   '⭐ <b>Star Amount</b>\n└ <b>'+starCount+'</b> Stars\n\n'+
   '🆔 <b>Giveaway Post</b>\n└ #'+esc(g.channelPostId)+'\n'+
   '━━━━━━━━━━━━━━━━━━\n'+
   '✅ Successfully recorded\n'+
   '🔄 Previous amount replaced',
   {parse_mode:'HTML',reply_to_message_id:m.message_id}
  );
 }
 async function createGiveaway(m,countArg,keyword){if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ <b>ADMIN ACCESS REQUIRED</b>\n\nOnly the group admin or bot owner can use this command.');const r=m.reply_to_message;if(!r)return bot.sendMessage(m.chat.id,'❌ <b>GIVEAWAY SETUP</b>\n\nReply to the forwarded channel post.\n\nUsage: <code>/giveaway 3 keyword</code>');const origin=extractChannelOrigin(m);const postId=origin?.channelPostId||r.forward_from_message_id||r.message_id;const channelId=origin?.channelId||String(r.forward_from_chat?.id||r.chat?.id||'');const rawCount=Number(countArg||1);if(!Number.isInteger(rawCount)||rawCount<1)return bot.sendMessage(m.chat.id,'❌ Winner count must be a whole number greater than 0.');if(rawCount>cfg.pickCountMax)return bot.sendMessage(m.chat.id,'❌ Maximum winners per giveaway is '+cfg.pickCountMax+'.');const count=rawCount;const g=await Giveaway.findOneAndUpdate({channelId,channelPostId:postId},{$set:{discussionChatId:String(m.chat.id),winnerCount:count,rules:{keyword:keyword||undefined,requireUsername:false,requireBotStart:false,excludeAdmins:true}},$setOnInsert:{title:(r.text||r.caption||'Giveaway').slice(0,120),status:'active',durationSeconds:cfg.rollDurationSeconds,createdBy:String(m.from.id),createdAt:new Date()}},{upsert:true,new:true});await bot.sendMessage(m.chat.id,'🎁 <b>GIVEAWAY CONFIGURED</b>\n━━━━━━━━━━━━━━━━━━\n\n🆔 <b>Giveaway ID</b>\n└ <code>'+g._id+'</code>\n\n🏆 <b>Winners</b>\n└ '+count+'\n\n🔑 <b>Keyword</b>\n└ '+esc(keyword||'None')+'\n\n━━━━━━━━━━━━━━━━━━\n✅ Comments replying to this post are now collected automatically.',{parse_mode:'HTML'});await AuditEvent.create({action:'create_giveaway',actorId:String(m.from.id),giveawayId:g._id,meta:{count,keyword:keyword||null}});}
 async function pick(m,arg){
  if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ <b>ADMIN ACCESS REQUIRED</b>\n\nOnly the group admin or bot owner can use this command.');
  const g=await findGiveaway(m,arg);
  if(!g)return bot.sendMessage(m.chat.id,'❌ <b>GIVEAWAY NOT FOUND</b>\n\nReply to the giveaway post or provide a valid Giveaway ID.');
  const parsed=Number(arg||g.winnerCount||1);
  if(!Number.isInteger(parsed)||parsed<1)return bot.sendMessage(m.chat.id,'❌ Winner count must be a whole number greater than 0.');
  if(parsed>cfg.pickCountMax)return bot.sendMessage(m.chat.id,'❌ Maximum winners per pick is '+cfg.pickCountMax+'.');const n=parsed;
  const rollEmoji='<tg-emoji emoji-id="'+esc(cfg.rollingEmojiId)+'">🎰</tg-emoji>';
  const barSize=10;
  const rollDurationMs=20000;
  const rollStepMs=2000;
  let p;
  try{
    const rollTitle=customEmoji('5188344996356448758','🏆')+' <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • 𝐃𝐑𝐀𝐖𝐈𝐍𝐆</b>';
    const selectEmoji=customEmoji('5314336934271663511','🌟');
    const roundEmoji=customEmoji('5260547274957672345','🎲');
    const candidateEmoji=customEmoji('5985525762973768278','👥');
    const winnerEmoji=customEmoji('4978994451964757181','🎖️');
    const secureEmoji=customEmoji('5224607267797606837','☄️');
    const waitEmoji=customEmoji('5399850755337240950','⏳');
    const renderRolling=(filled,candidates)=>[
  rollTitle,
  '━━━━━━━━━━━━━━━━━━',
  '',
  selectEmoji+' <b>SELECTING WINNERS</b>',
  progress(filled,barSize),
  '',
  roundEmoji+' <b>Round</b>',
  '└ <b>1</b>',
  '',
  candidateEmoji+' <b>Candidates</b>',
  '└ <b>'+candidates+'</b>',
  '',
  winnerEmoji+' <b>Winners</b>',
  '└ <b>'+n+'</b>',
  '',
  secureEmoji+' <b>Secure random selection</b>',
  waitEmoji+' <i>Please wait...</i>'
].join('\n');
    p=await bot.sendMessage(m.chat.id,renderRolling(0,'Preparing...'),{parse_mode:'HTML',reply_to_message_id:m.message_id});
    let nextStep=1;
    let nextEditAt=Date.now()+rollStepMs;
    let latestCandidates='Preparing...';
    const r=await pickWinners(g._id,n,{
      durationSeconds:20,
      onProgress:async state=>{
        latestCandidates=state.candidateCount;
        const now=Date.now();
        while(nextStep<=barSize&&now>=nextEditAt){
          const filled=nextStep;
          nextStep++;
          nextEditAt+=rollStepMs;
          const text=renderRolling(filled,latestCandidates);
          try{await bot.editMessageText(text,{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});}catch(e){if(!String(e.message||e).includes('message is not modified'))throw e;}
        }
      }
    });
    if(nextStep<=barSize){
      const text=renderRolling(barSize,latestCandidates);
      try{await bot.editMessageText(text,{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});}catch(e){if(!String(e.message||e).includes('message is not modified'))throw e;}
    }    const winnerIds=r.winners.map(w=>String(w.userId));
    const entries=await Entry.find({giveawayId:g._id,userId:{$in:winnerIds}}).select('userId commentText commentType').lean();
    const comments=new Map(entries.map(e=>[String(e.userId),{text:e.commentText||'',type:e.commentType||'text'}]));
    const displayComment=(userId)=>{const c=comments.get(String(userId));if(!c)return '—';if(c.type==='sticker')return 'Sticker';if(c.type!=='text')return 'Media';const text=String(c.text||'').trim();if(text&&!/[A-Za-z0-9]/.test(text))return 'Emoji';return esc(text||'—');};
    const medalIds=['5440539497383087970','5447203607294265305','5453902265922376865'];
    const defaultMedal=['🥇','🥈','🥉'];
    const rankEmoji=(i)=>i<3?customEmoji(medalIds[i],defaultMedal[i]):customEmoji('5150415989841593609','🎖️');
    const lines=r.winners.map((w,i)=>rankEmoji(i)+' <b>#'+(i+1)+'</b>  '+winnerDisplay(w)+'\n   '+customEmoji('5215334566549540768','💬')+' '+displayComment(w.userId));
    const header=customEmoji('5188344996356448758','🏆')+' <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • 𝐑𝐄𝐒𝐔𝐋𝐓</b>\n\n'+
      '━━━━━━━━━━━━━━━━━━\n\n'+
      customEmoji('5461151367559141950','🎉')+' <b>WINNERS SELECTED</b>\n\n';
    const stats=
      customEmoji('5444856076954520455','🧾')+' <b>Giveaway Post</b>\n'+
      '└ <b>#'+esc(g.channelPostId)+'</b>\n\n'+
      '👥 <b>Total Entries</b>\n'+
      '└ <b>'+r.entryCount+'</b>\n\n'+
      customEmoji('4978994451964757181','🎖️')+' <b>Winners</b>\n'+
      '└ <b>'+r.winners.length+'</b>\n\n'+
      customEmoji('5280816565657300091','🎲')+' <b>Round</b>\n'+
      '└ <b>'+r.winners[0].round+'</b>\n\n';
    const footer='━━━━━━━━━━━━━━━━━━\n'+
      customEmoji('5197288647275071607','🛡️')+' <b>Secure Random Draw</b>\n'+
      customEmoji('6129931368148243023','⚡')+' <b>CMT PICKER V2 PRO</b>\n'+
      customEmoji('4907231385309152742','🪪')+' @CommentsPickerBot';
    await bot.editMessageText(header+stats+lines.join('\n\n')+'\n\n'+footer,{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});
    await AuditEvent.create({action:'pick',actorId:String(m.from.id),giveawayId:g._id,meta:{count:n}});
  }catch(e){
    if(p){try{await bot.editMessageText('⚠️ <b>DRAW COULD NOT BE COMPLETED</b>\n\n'+esc(e.message)+'\n\n<i>No winner result was published.</i>',{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});}catch{}}
    else await bot.sendMessage(m.chat.id,'❌ <b>PICK FAILED</b>\n\n'+esc(e.message),{parse_mode:'HTML'});
  }
}
 async function pickStar(m,arg){
  if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ <b>ADMIN ACCESS REQUIRED</b>\n\nOnly the group admin or bot owner can use this command.');
  const reply=m.reply_to_message;
  let g=null,n=null;
  if(reply){
   g=await findGiveaway(m);
   if(!g)return bot.sendMessage(m.chat.id,'❌ <b>GIVEAWAY NOT FOUND</b>\n\nReply to the giveaway post or provide a valid Giveaway ID.');
   n=arg===undefined?Number(g.winnerCount||1):Number(arg);
  }else{   const raw=String(arg||'');
   if(/^[0-9]+$/.test(raw)){
    const possibleCount=Number(raw);
    if(possibleCount>=1&&possibleCount<=cfg.pickCountMax)return bot.sendMessage(m.chat.id,'❌ Reply to the giveaway post when using a winner count. Example: /pickstarwinner 3');
   }
   g=await findGiveaway(m,raw);
   if(!g)return bot.sendMessage(m.chat.id,'❌ <b>GIVEAWAY NOT FOUND</b>\n\nReply to the giveaway post or provide a valid Giveaway ID.');
   n=Number(g.winnerCount||1);
  }
  if(!Number.isInteger(n)||n<1)return bot.sendMessage(m.chat.id,'❌ Winner count must be a whole number greater than 0.');
  if(n>cfg.pickCountMax)return bot.sendMessage(m.chat.id,'❌ Maximum winners per pick is '+cfg.pickCountMax+'.');
  const star='⭐';let p;
  try{
   p=await bot.sendMessage(m.chat.id,[
  customEmoji('5188344996356448758','🏆')+' <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • 𝐏𝐀𝐈𝐃 𝐒𝐓𝐀𝐑</b>',
  '━━━━━━━━━━━━━━━━━━',
  '',
  customEmoji('5314336934271663511','🌟')+' <b>SELECTING WINNERS</b>',
  progress(0,10),
  '',
  customEmoji('5260547274957672345','🎲')+' <b>Round</b>',
  '└ <b>1</b>',
  '',  customEmoji('5985525762973768278','👥')+' <b>Candidates</b>',
  '└ <b>Preparing...</b>',
  '',
  customEmoji('4978994451964757181','🎖️')+' <b>Winners</b>',
  '└ <b>'+n+'</b>',
  '',
  customEmoji('5224607267797606837','☄️')+' <b>Secure random selection</b>',
  customEmoji('5399850755337240950','⏳')+' <i>Please wait...</i>'
].join('\n'),{parse_mode:'HTML',reply_to_message_id:m.message_id});
   const barSize=10;
   const rollStepMs=2000;
   let nextStep=1;
   let nextEditAt=Date.now()+rollStepMs;
   let latestCandidates='Preparing...';
   if(paidStarClient){
      try{
       const sync=await syncPaidStarReactors(paidStarClient,g,{logger});
       if(sync.synced>0)logger.info('Paid Star MTProto sync completed',{giveawayId:String(g._id),synced:sync.synced,total:sync.total});
      }catch(syncError){
       logger.warn('Paid Star MTProto sync failed; continuing with live Bot API tracking: '+(syncError.message||syncError));
      }
    }
    const r=await pickStarWinners(g._id,n,{durationSeconds:20,onProgress:async state=>{
    latestCandidates=state.candidateCount;
    const now=Date.now();
    while(nextStep<=barSize&&now>=nextEditAt){
     const filled=nextStep++;
     nextEditAt+=rollStepMs;
     const text=[
  customEmoji('5188344996356448758','🏆')+' <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • 𝐏𝐀𝐈𝐃 𝐒𝐓𝐀𝐑</b>',
  '━━━━━━━━━━━━━━━━━━',
  '',
  customEmoji('5314336934271663511','🌟')+' <b>SELECTING WINNERS</b>',
  progress(filled,10),
  '',
  customEmoji('5260547274957672345','🎲')+' <b>Round</b>',
  '└ <b>1</b>',
  '',
  customEmoji('5985525762973768278','👥')+' <b>Candidates</b>',
  '└ <b>'+state.candidateCount+'</b>',
  '',
  customEmoji('4978994451964757181','🎖️')+' <b>Winners</b>',
  '└ <b>'+n+'</b>',
  '',
  customEmoji('5224607267797606837','☄️')+' <b>Secure random selection</b>',
  customEmoji('5399850755337240950','⏳')+' <i>Please wait...</i>'
].join('\n');
     try{await bot.editMessageText(text,{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});}catch(e){if(!String(e.message||e).includes('message is not modified'))throw e;}
    }
   }});
   if(nextStep<=barSize){
    const text=[
     customEmoji('5188344996356448758','🏆')+' <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • 𝐏𝐀𝐈𝐃 𝐒𝐓𝐀𝐑</b>',
     '━━━━━━━━━━━━━━',
     '',
     customEmoji('5314336934271663511','🌟')+' <b>𝐒𝐄𝐋𝐄𝐂𝐓𝐈𝐍𝐆 WINNERS...</b>',
     progress(barSize,barSize),
     '',
     customEmoji('5260547274957672345','🎲')+' Round <b>1</b>',
     customEmoji('5985525762973768278','👥')+' Candidates: <b>'+latestCandidates+'</b>',
     customEmoji('4978994451964757181','🎖️')+' Winners: <b>'+n+'</b>',
     customEmoji('5224607267797606837','☄️')+' Secure random selection',
     customEmoji('5399850755337240950','⏳')+' Please wait...'
    ].join('\n');
    try{await bot.editMessageText(text,{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});}catch(e){if(!String(e.message||e).includes('message is not modified'))throw e;}
   }
   const starWinnerIds=r.winners.map(w=>String(w.userId));
   const starEntries=await Entry.find({giveawayId:g._id,userId:{$in:starWinnerIds}}).select('userId commentText commentType').lean();
   const starComments=new Map(starEntries.map(e=>[String(e.userId),{text:e.commentText||'',type:e.commentType||'text'}]));
   const displayStarComment=(userId)=>{const c=starComments.get(String(userId));if(!c)return '—';if(c.type==='sticker')return 'Sticker';if(c.type!=='text')return 'Media';const text=String(c.text||'').trim();if(text&&!/[A-Za-z0-9]/.test(text))return 'Emoji';return esc(text||'—');};
   const lines=r.winners.map((w,i)=>customEmoji('5150415989841593609','🎖️')+' <b>#'+(i+1)+'</b>  '+winnerDisplay(w)+'\n   '+customEmoji('5215334566549540768','💬')+' '+displayStarComment(w.userId));
   const header=customEmoji('5188344996356448758','🏆')+' <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • 𝐏𝐀𝐈𝐃 𝐒𝐓𝐀𝐑</b>\n\n'+
     '━━━━━━━━━━━━━━━━━━\n\n'+
     customEmoji('5461151367559141950','🎉')+' <b>WINNERS SELECTED</b>\n\n';
   const stats=
     customEmoji('5444856076954520455','🧾')+' <b>Giveaway Post</b>\n'+
     '└ <b>#'+esc(g.channelPostId)+'</b>\n\n'+
     customEmoji('5280816565657300091','🎲')+' <b>Round</b>\n'+
     '└ <b>'+r.winners[0].round+'</b>\n\n'+
     customEmoji('4978994451964757181','🎖️')+' <b>Winners</b>\n'+
     '└ <b>'+r.winners.length+'</b>\n\n'+
     customEmoji('6129931368148243023','⚡')+' <b>Active Star Participants</b>\n'+
     '└ <b>'+r.candidateCount+'</b>\n\n';
   const footer='━━━━━━━━━━━━━━━━━━\n'+
     customEmoji('5197288647275071607','🛡️')+' <b>Paid Star Random Draw</b>\n'+
     customEmoji('6129931368148243023','⚡')+' <b>CMT PICKER V2 PRO</b>\n'+
     customEmoji('4907231385309152742','🪪')+' @CommentsPickerBot';
   await bot.editMessageText(header+stats+lines.join('\n\n')+'\n\n'+footer,{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});
   await AuditEvent.create({action:'pick_star_winners',actorId:String(m.from.id),giveawayId:g._id,meta:{count:n,paidReaction:true}});
  }catch(e){
   const [trackedActive,trackedInactive]=await Promise.all([
    PaidReaction.countDocuments({giveawayId:g._id,active:true}).catch(()=>0),
    PaidReaction.countDocuments({giveawayId:g._id,active:false}).catch(()=>0)
   ]);
   const diagnostic='\n\n'+customEmoji('5985525762973768278','👥')+' Tracked Active: <b>'+trackedActive+'</b>\n↩️ Tracked Inactive: <b>'+trackedInactive+'</b>\n👤 Anonymous Paid Stars: <b>'+Number(g.anonymousPaidStarCount||0)+'</b>\n\n<i>Use /starstatus for webhook and reaction diagnostics.</i>';
   if(p){try{await bot.editMessageText('⚠️ <b>PAID STAR DRAW FAILED</b>\n\n'+esc(e.message)+diagnostic+'\n\n<i>No winner result was published.</i>',{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});}catch{}}else await bot.sendMessage(m.chat.id,'❌ <b>PAID STAR PICK FAILED</b>\n\n'+esc(e.message)+diagnostic,{parse_mode:'HTML'});
  }
 }
 async function rerollCmd(m,arg){if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ <b>ADMIN ACCESS REQUIRED</b>\n\nOnly the group admin or bot owner can use this command.');const g=await findGiveaway(m,arg);if(!g)return bot.sendMessage(m.chat.id,'❌ <b>GIVEAWAY NOT FOUND</b>\n\nReply to the giveaway post or provide its ID.');const raw=Number(arg||g.winnerCount||1);if(!Number.isInteger(raw)||raw<1)return bot.sendMessage(m.chat.id,'❌ Reroll count must be a whole number greater than 0.');if(raw>cfg.pickCountMax)return bot.sendMessage(m.chat.id,'❌ Maximum winners per reroll is '+cfg.pickCountMax+'.');const n=raw;try{const latestWinner=await Winner.findOne({giveawayId:g._id,status:'winner'}).sort({round:-1}).lean();const r=latestWinner?.selectionMode==='paid_star'?await rerollStarWinners(g._id,n):await reroll(g._id,n);const lines=r.winners.map((w,i)=>(i+1)+'. '+mention({id:w.userId,firstName:w.firstName,lastName:w.lastName,username:w.username}));await bot.sendMessage(m.chat.id,
  '🔄 <b>REROLL COMPLETE</b>\n\n'+
  '━━━━━━━━━━━━━━━━━━\n\n'+
  '🎲 <b>Round</b>\n└ <b>'+r.round+'</b>\n\n'+
  '🏆 <b>New Winners</b>\n'+lines.map((x,i)=>'└ '+x).join('\n')+'\n\n'+
  '━━━━━━━━━━━━━━━━━━\n'+
  '🛡️ <i>Previous winners are excluded from this draw.</i>',
  {parse_mode:'HTML',reply_to_message_id:m.message_id});await AuditEvent.create({action:'reroll',actorId:String(m.from.id),giveawayId:g._id,meta:{count:n,round:r.round}});}catch(e){await bot.sendMessage(m.chat.id,'⚠️ <b>REROLL FAILED</b>\n\n'+esc(e.message),{parse_mode:'HTML',reply_to_message_id:m.message_id});}}
 async function winnerList(m){const parts=(m.text||'').trim().split(/\s+/);const g=await findGiveaway(m,parts[1]);if(!g)return bot.sendMessage(m.chat.id,'❌ <b>GIVEAWAY NOT FOUND</b>\n\nReply to the giveaway post or provide its ID.');const rows=await Winner.find({giveawayId:g._id,status:'winner'}).sort({round:-1,rank:1}).limit(20).lean();if(!rows.length)return bot.sendMessage(m.chat.id,'ℹ️ <b>NO ACTIVE WINNERS</b>\n\nThere are no current winners for this giveaway.');const winnerIds=[...new Set(rows.map(w=>String(w.userId)))];const entries=await Entry.find({giveawayId:g._id,userId:{$in:winnerIds}}).select('userId commentText commentType').lean();const comments=new Map(entries.map(e=>[String(e.userId),{text:e.commentText||'',type:e.commentType||'text'}]));const displayComment=(userId)=>{const c=comments.get(String(userId));if(!c)return '—';if(c.type==='sticker')return 'Sticker';if(c.type!=='text')return 'Media';const text=String(c.text||'').trim();if(text&&!/[A-Za-z0-9]/.test(text))return 'Emoji';return esc(text||'—');};const body=rows.map((w,i)=>'🎖️ <b>#'+(i+1)+'</b>  '+mention({id:w.userId,firstName:w.firstName,lastName:w.lastName,username:w.username})+'\n   💬 '+displayComment(w.userId)+'\n   🎲 Round <b>'+w.round+'</b>').join('\n\n');return bot.sendMessage(m.chat.id,'🏆 <b>WINNER LIST</b>\n━━━━━━━━━━━━━━━━━━\n\n🆔 <b>Giveaway Post</b>\n└ #'+esc(g.channelPostId)+'\n\n'+body+'\n\n━━━━━━━━━━━━━━━━━━\n🏆 <b>'+rows.length+'</b> winner record(s) shown',{parse_mode:'HTML',reply_to_message_id:m.message_id});}
 async function starSync(m){
  if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ <b>ADMIN ACCESS REQUIRED</b>\n\nOnly the group admin or bot owner can use this command.');
  if(!paidStarClient)return bot.sendMessage(m.chat.id,'⚠️ Paid Star historical sync is not configured. Set TG_API_ID and TG_API_HASH in Render, then redeploy.');
  const g=await findGiveaway(m);
  if(!g)return bot.sendMessage(m.chat.id,'❌ <b>GIVEAWAY NOT FOUND</b>\n\nReply to the giveaway post or provide a valid Giveaway ID.');
  try{
   const sync=await syncPaidStarReactors(paidStarClient,g,{logger});
   const active=await PaidReaction.countDocuments({giveawayId:g._id,active:true});
   return bot.sendMessage(m.chat.id,
    '🔄 <b>PAID STAR SYNC COMPLETE</b>\n━━━━━━━━━━━━━━━━━━\n\n'+
    '🆔 <b>Giveaway Post</b>\n└ #'+esc(g.channelPostId)+'\n'+
    '👥 <b>Leaderboard Reactors</b>\n└ '+sync.total+'\n'+
    '✅ <b>Synced Active</b>\n└ '+sync.synced+'\n'+
    '⭐ <b>Tracked Active Total</b>\n└ '+active+'\n\n━━━━━━━━━━━━━━━━━━\n'+
    '💡 <i>/pickstarwinner can now use the synced identifiable reactors.</i>',
    {parse_mode:'HTML',reply_to_message_id:m.message_id}
   );
  }catch(e){
   return bot.sendMessage(m.chat.id,'⚠️ <b>PAID STAR SYNC FAILED</b>\n\n'+esc(e.message||String(e)),{parse_mode:'HTML',reply_to_message_id:m.message_id});
  }
 }
 async function starStatus(m){
  if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ <b>ADMIN ACCESS REQUIRED</b>\n\nOnly the group admin or bot owner can use this command.');
  const g=await findGiveaway(m);
  if(!g)return bot.sendMessage(m.chat.id,'❌ <b>GIVEAWAY NOT FOUND</b>\n\nReply to the giveaway post or provide a valid Giveaway ID.');
  let mtStatus=paidStarMtStatus(paidStarClient);
  const [active,inactive]=await Promise.all([
   PaidReaction.countDocuments({giveawayId:g._id,active:true}),
   PaidReaction.countDocuments({giveawayId:g._id,active:false})
  ]);
  let webhook='Not verified';
  let webhookDetail='';
  try{
   const wh=await bot.getWebHookInfo();
   webhook=wh.url?'🟢 Connected':'🔴 Not configured';
   const allowed=Array.isArray(wh.allowed_updates)?wh.allowed_updates:[];
   webhookDetail='Reaction: '+(allowed.includes('message_reaction')?'🟢':'🔴')+'  Anonymous count: '+(allowed.includes('message_reaction_count')?'🟢':'🔴')+'\nMTProto Star Sync: '+(mtStatus.enabled?'🟢 Enabled':'🔴 Disabled');
   if(wh.last_error_message)webhookDetail+='\nLast error: '+esc(wh.last_error_message);
  }catch(e){webhookDetail='Webhook check failed: '+esc(e.message||String(e));}
  const last=g.lastReactionUpdateAt?new Date(g.lastReactionUpdateAt).toISOString():'Never';
  const anon=Number(g.anonymousPaidStarCount||0);
  const text=[
   customEmoji('5188344996356448758','🏆')+' <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • 𝐏𝐀𝐈𝐃 𝐒𝐓𝐀𝐑 𝐒𝐓𝐀𝐓𝐔𝐒</b>',
   '━━━━━━━━━━━━━━━',
   '',
   customEmoji('5985525762973768278','👥')+' Tracked Active: <b>'+active+'</b>',
   '↩️ Tracked Inactive: <b>'+inactive+'</b>',
   '👤 Anonymous Paid Stars: <b>'+anon+'</b>',
   '🆔 Post ID: <b>'+esc(g.channelPostId)+'</b>',
   '',
   customEmoji('5224607267797606837','☄️')+' Webhook: <b>'+webhook+'</b>',
   webhookDetail,
   '🕒 Last Reaction Update: <b>'+esc(last)+'</b>',
   '',
   '💡 Only identifiable users can be selected as winners.'
  ].join('\n');  return bot.sendMessage(m.chat.id,text,{parse_mode:'HTML',reply_to_message_id:m.message_id});
 }
 async function broadcast(m,text){if(!await owner(m.from.id))return bot.sendMessage(m.chat.id,'⛔ <b>OWNER ONLY</b>\n\nYou do not have permission to use this command.');if(!text)return bot.sendMessage(m.chat.id,'❌ <b>BROADCAST</b>\n\nUsage: <code>/broadcast your message</code>');const groups=await Group.find({approved:true}).select('id').lean();const job=await BroadcastJob.create({text,createdBy:String(m.from.id),targets:groups.map(g=>({chatId:g.id,status:'pending',attempts:0}))});await bot.sendMessage(m.chat.id,'📣 <b>BROADCAST QUEUED</b>\n━━━━━━━━━━━━━━━━━━\n\n🆔 <b>Job</b>\n└ <code>'+job._id+'</code>\n\n👥 <b>Targets</b>\n└ '+groups.length,{parse_mode:'HTML'});runBroadcast(bot,job._id,cfg,logger).catch(e=>logger.error('broadcast',e));}
 async function callback(q){try{await bot.answerCallbackQuery(q.id);}catch{}}
 const shutdown=async()=>{logger.info('graceful shutdown');clearInterval(cleanupTimer);server.close();await paidStarClient?.disconnect?.().catch(()=>{});await mongoose.disconnect().catch(()=>{});process.exit(0);};process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);return {app,bot,server};
}
module.exports={start};