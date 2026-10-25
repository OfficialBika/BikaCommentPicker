const express=require('express');
const TelegramBot=require('node-telegram-bot-api');
const mongoose=require('mongoose');
const {loadConfig}=require('./config');
const {createLogger}=require('./utils/logger');
const {esc,mention,progress,paginate,formatMessage}=require('./utils/format');
const {User,Group,Giveaway,Entry,PaidReaction,Winner,BroadcastJob,AuditEvent,CommentMessage,repairLegacyGroupIndexes}=require('./models');
const {pickWinners,reroll,rerollStarWinners,pickStarWinners}=require('./services/picker');
const {recordComment}=require('./services/entry');
const {runBroadcast}=require('./services/broadcast');
const {cleanupTemporaryGiveawayData}=require('./services/cleanup');
const {createPaidStarClient,syncPaidStarReactors,paidStarMtStatus}=require('./services/paidStars');

async function start(){
 const cfg=loadConfig();const logger=createLogger(cfg.logLevel);
 await mongoose.connect(cfg.mongoUri,{serverSelectionTimeoutMS:10000});
 const groupIndexStatus=await repairLegacyGroupIndexes({logger});
 await Promise.all([Entry.createIndexes(),CommentMessage.createIndexes()]);
 logger.info('MongoDB connected; model indexes ready',{groupIndexReady:groupIndexStatus.indexReady,duplicateGroupIds:groupIndexStatus.duplicateIds});
 await cleanupTemporaryGiveawayData({retentionDays:cfg.tempDataRetentionDays,logger}).catch(e=>logger.warn('Initial temporary-data cleanup failed: '+(e.message||e)));
 const cleanupTimer=setInterval(()=>cleanupTemporaryGiveawayData({retentionDays:cfg.tempDataRetentionDays,logger}).catch(e=>logger.warn('Scheduled temporary-data cleanup failed: '+(e.message||e))),cfg.cleanupIntervalMinutes*60*1000);
 cleanupTimer.unref?.();
 const bot=new TelegramBot(cfg.botToken);const app=express();app.use(express.json({limit:'1mb'}));
 const paidStarClient=await createPaidStarClient(cfg,logger);

 // Keep the original custom emoji markup when Telegram accepts it; retry using
 // the visible Unicode fallback if Telegram rejects an unsupported entity.
 const rawSendMessage=bot.sendMessage.bind(bot);
 const rawEditMessageText=bot.editMessageText.bind(bot);
 const stripCustomEmojiTags=value=>String(value??'').replace(/<tg-emoji\b[^>]*>([\s\S]*?)<\/tg-emoji>/gi,'$1');
 bot.sendMessage=async(...args)=>{
  try{return await rawSendMessage(...args);}
  catch(error){
   const text=String(args[1]??''),options=args[2];
   if(options?.parse_mode==='HTML'&&/<tg-emoji\b/i.test(text)){
    const fallbackText=stripCustomEmojiTags(text);
    if(fallbackText!==text){try{const retryArgs=args.slice();retryArgs[1]=fallbackText;return await rawSendMessage(...retryArgs);}catch{}}
   }
   throw error;
  }
 };
 bot.editMessageText=async(...args)=>{
  try{return await rawEditMessageText(...args);}
  catch(error){
   const text=String(args[0]??''),options=args[1];
   if(options?.parse_mode==='HTML'&&/<tg-emoji\b/i.test(text)){
    const fallbackText=stripCustomEmojiTags(text);
    if(fallbackText!==text){try{const retryArgs=args.slice();retryArgs[0]=fallbackText;return await rawEditMessageText(...retryArgs);}catch{}}
   }
   throw error;
  }
 };
 app.get('/',(_,res)=>res.type('text').send('Cmt Picker V2 Pro is running.'));
 app.get('/health',(_,res)=>res.json({ok:true,status:'healthy',uptime:process.uptime(),mongo:mongoose.connection.readyState===1}));
 app.get('/ready',(_,res)=>res.status(mongoose.connection.readyState===1?200:503).json({ok:mongoose.connection.readyState===1}));
 const path='/telegram/comments_picker_v2_webhook';
 const allowedUpdates=['message','channel_post','callback_query','message_reaction','message_reaction_count'];
 const updateQueues=new Map();
 function updateQueueKey(u){const chatId=u?.message?.chat?.id??u?.channel_post?.chat?.id??u?.message_reaction?.chat?.id??u?.message_reaction_count?.chat?.id;return chatId==null?'other':String(chatId);}
 function enqueueUpdate(u){
  const key=updateQueueKey(u),previous=updateQueues.get(key)||Promise.resolve();
  const task=previous.catch(()=>{}).then(()=>handleUpdate(u));updateQueues.set(key,task);
  task.then(()=>{if(updateQueues.get(key)===task)updateQueues.delete(key);},()=>{if(updateQueues.get(key)===task)updateQueues.delete(key);});
  return task;
 }
 app.post(path,(req,res)=>{
  const supplied=req.get('X-Telegram-Bot-Api-Secret-Token')||'';
  const expected=Buffer.from(cfg.webhookSecretToken),received=Buffer.from(supplied);
  if(!cfg.webhookSecretToken||received.length!==expected.length||!require('crypto').timingSafeEqual(received,expected)){
   logger.warn('Rejected webhook request with invalid secret token',{ip:req.ip});
   return res.status(403).json({ok:false});
  }
  res.status(200).json({ok:true});
  Promise.resolve(enqueueUpdate(req.body)).catch(e=>logger.error('update error',e.stack||e.message));
 });
 const server=app.listen(cfg.port);
 await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
 logger.info('HTTP server listening on '+cfg.port);
 if(cfg.publicUrl){
  const webhookUrl=cfg.publicUrl.replace(/\/$/,'')+path;
  try{
   const result=await bot.setWebHook(webhookUrl,{allowed_updates:allowedUpdates,secret_token:cfg.webhookSecretToken,max_connections:1});
   logger.info('Telegram webhook configured',{url:webhookUrl,result,allowedUpdates});
  }catch(e){logger.error('Telegram webhook setup failed: '+(e.message||e));throw e;}
  try{
   const wh=await bot.getWebHookInfo();
   const actualAllowed=Array.isArray(wh.allowed_updates)?wh.allowed_updates:null;
   logger.info('Telegram webhook ready',{url:wh.url||'',pending:wh.pending_update_count||0,allowed:actualAllowed,lastError:wh.last_error_message||null});
   if(wh.url!==webhookUrl)logger.warn('Telegram webhook URL mismatch');
   // Telegram may omit allowed_updates when the effective setting is its default;
   // do not incorrectly report missing reaction updates when no explicit list is returned.
   if(actualAllowed && !actualAllowed.includes('message_reaction'))logger.warn('Telegram webhook explicitly excludes message_reaction');
   if(actualAllowed && !actualAllowed.includes('message_reaction_count'))logger.warn('Telegram webhook explicitly excludes message_reaction_count');
   if(wh.last_error_message)logger.warn('Telegram reports a previous webhook delivery error; verify /health and the POST endpoint before treating this as a current failure.');
  }catch(e){logger.warn('Unable to verify Telegram webhook: '+(e.message||e));}
 }else logger.warn('PUBLIC_URL is not configured; Telegram reaction updates cannot reach this webhook.');

 async function saveUser(f){if(!f)return;await User.updateOne({id:String(f.id)},{$set:{username:f.username||'',firstName:f.first_name||'',lastName:f.last_name||'',lastSeenAt:new Date()}},{upsert:true}).catch(()=>{});}
 async function saveGroup(c){if(!c||!['group','supergroup','channel'].includes(c.type))return;await Group.updateOne({id:String(c.id)},{$set:{title:c.title||'',type:c.type,username:c.username||'',lastSeenAt:new Date()}},{upsert:true}).catch(()=>{});}
 async function isApprovedGroup(chatId){if(chatId==null)return false;const group=await Group.findOne({id:String(chatId)}).select('approved').lean();return group?.approved===true;}
 async function handleUpdate(u){
  if(u.callback_query){const chat=u.callback_query.message?.chat;if(chat&&['group','supergroup','channel'].includes(chat.type)&&!(await isApprovedGroup(chat.id)))return;return callback(u.callback_query);}
  if(u.message_reaction){const chat=u.message_reaction.chat;if(!chat||chat.type!=='channel'||!(await isApprovedGroup(chat.id))||!(await Giveaway.exists({channelId:String(chat.id),channelPostId:Number(u.message_reaction.message_id)})))return;return reactionUpdate(u.message_reaction);}
  if(u.message_reaction_count){const chat=u.message_reaction_count.chat;if(!chat||chat.type!=='channel'||!(await isApprovedGroup(chat.id))||!(await Giveaway.exists({channelId:String(chat.id),channelPostId:Number(u.message_reaction_count.message_id)})))return;return reactionCountUpdate(u.message_reaction_count);}
  const m=u.message||u.channel_post;if(!m?.chat)return;
  if(m.chat.type==='private'){if(u.message?.text&&(/^(?:\/|\.s(?:\s|$))/i.test(u.message.text))){if(m.from)await saveUser(m.from);return command(u.message);}return;}
  if(!['group','supergroup','channel'].includes(m.chat.type))return;
  if(!(await isApprovedGroup(m.chat.id))){
   // Only the configured owner may approve a group in place; this path is silent.
   if(['group','supergroup'].includes(m.chat.type)&&u.message?.text&&m.from&&String(m.from.id)===String(cfg.ownerId)&&/^\/(?:approvec|approve)(?:@\w+)?$/i.test(String(m.text).trim())){
    await Group.updateOne({id:String(m.chat.id)},{$set:{approved:true,title:m.chat.title||'',type:m.chat.type,username:m.chat.username||'',lastSeenAt:new Date()}},{upsert:true});
   }
   return;
  }
  await saveGroup(m.chat);
  if(u.message?.text&&(/^(?:\/|\.s(?:\s|$))/i.test(u.message.text))){if(m.from)await saveUser(m.from);return command(u.message);}
  if(u.channel_post)return channelPost(u.channel_post);
  if(m.reply_to_message)return comment(m);
 }
 async function channelPost(p){
  if(!p?.chat||p.chat.type!=='channel')return;
  // Posts carrying the configured bot tag are discovered only from channels
  // approved by the owner; save the channel metadata first for clear diagnostics.
  if(!(await isApprovedGroup(p.chat.id)))return;
  const text=p.text||p.caption||'';
  if(!text.toLowerCase().includes(cfg.mentionTag.toLowerCase()))return;
  const g=await Giveaway.findOneAndUpdate(
   {channelId:String(p.chat.id),channelPostId:p.message_id},
   {$setOnInsert:{channelId:String(p.chat.id),channelPostId:p.message_id,title:text.slice(0,120),status:'active',winnerCount:1,durationSeconds:cfg.rollDurationSeconds,createdAt:new Date()}},
   {upsert:true,new:true}
  );
  logger.info('Mention-tag giveaway post registered',{channelId:String(p.chat.id),channelPostId:p.message_id,giveawayId:String(g._id)});
}
 function extractChannelOrigin(msg){
  const r=msg?.reply_to_message;if(!r)return null;const o=r.forward_origin;
  if(o?.type==='channel'&&o.chat?.id&&o.message_id)return {channelId:String(o.chat.id),channelPostId:Number(o.message_id)};
  if(r.forward_from_chat?.id&&r.forward_from_message_id)return {channelId:String(r.forward_from_chat.id),channelPostId:Number(r.forward_from_message_id)};
  const e=r.external_reply,eo=e?.origin;
  if(eo?.type==='channel'&&e.chat?.id&&e.message_id)return {channelId:String(e.chat.id),channelPostId:Number(e.message_id)};
  return null;
 }
 async function findGiveaway(msg,explicitId){
  const chatId=msg?.chat?.id==null?null:String(msg.chat.id);
  if(explicitId){
   const byId=await Giveaway.findById(explicitId).catch(()=>null);
   if(byId&&(!byId.discussionChatId||chatId===null||String(byId.discussionChatId)===chatId))return byId;
  }
  const origin=extractChannelOrigin(msg);
  if(origin){
   const exact=await Giveaway.findOne({channelId:origin.channelId,channelPostId:origin.channelPostId}).sort({createdAt:-1});
   if(!exact)return null;
   if(exact.discussionChatId&&chatId!==null&&String(exact.discussionChatId)!==chatId)return null;
   if(!exact.discussionChatId&&['group','supergroup'].includes(msg.chat?.type)){exact.discussionChatId=chatId;await exact.save();}
   return exact;
  }
  if(chatId===null)return null;
  const groupChatId=chatId,parent=msg?.reply_to_message;
  // A command may reply to a comment instead of the original channel post.
  // Follow the stored mapping first, then legacy entries.
  const messageIds=[];
  const threadId=Number(msg.message_thread_id);
  if(Number.isSafeInteger(threadId)&&threadId>0)messageIds.push(threadId);
  const parentId=Number(parent?.message_id);
  if(Number.isSafeInteger(parentId)&&parentId>0&&!messageIds.includes(parentId))messageIds.push(parentId);
  for(const messageId of messageIds){
   const link=await CommentMessage.findOne({groupChatId,messageId}).select('giveawayId').lean();
   if(link){
    const g=await Giveaway.findOne({_id:link.giveawayId,discussionChatId:groupChatId});
    if(g)return g;
   }
   const legacy=await Entry.findOne({groupChatId,commentMessageId:messageId}).select('giveawayId').lean();
   if(legacy){
    const g=await Giveaway.findOne({_id:legacy.giveawayId,discussionChatId:groupChatId});
    if(g)return g;
   }
  }
  // When replying directly to the mapped root discussion message, use it.
  if(parent&&Number.isSafeInteger(parentId)&&parentId>0){
   const byRoot=await Giveaway.findOne({discussionChatId:groupChatId,discussionRootMessageId:parentId,status:{$in:['active','completed','picking']}}).sort({createdAt:-1});
   if(byRoot)return byRoot;
  }
  return null;
 }
 async function resolveCommentGiveaway(msg){
  const parent=msg?.reply_to_message;if(!parent||!['group','supergroup'].includes(msg.chat?.type))return null;
  const chatId=String(msg.chat.id),origin=extractChannelOrigin(msg);
  if(origin){
   const g=await Giveaway.findOne({channelId:origin.channelId,channelPostId:origin.channelPostId}).sort({createdAt:-1});
   if(!g)return null;if(g.discussionChatId&&String(g.discussionChatId)!==chatId)return null;
   if(!g.discussionChatId){g.discussionChatId=chatId;await g.save();}return g;
  }
  const threadId=Number(msg.message_thread_id);
  if(Number.isSafeInteger(threadId)&&threadId>0){
   const link=await CommentMessage.findOne({groupChatId:chatId,messageId:threadId}).select('giveawayId').lean();
   if(link){const g=await Giveaway.findOne({_id:link.giveawayId,discussionChatId:chatId});if(g)return g;}
  }
  const parentId=Number(parent.message_id);if(!Number.isSafeInteger(parentId)||parentId<1)return null;
  const linked=await CommentMessage.findOne({groupChatId:chatId,messageId:parentId}).select('giveawayId').lean();
  if(linked){const g=await Giveaway.findOne({_id:linked.giveawayId,discussionChatId:chatId});if(g)return g;}
  const legacy=await Entry.findOne({groupChatId:chatId,commentMessageId:parentId}).select('giveawayId').lean();
  return legacy?Giveaway.findOne({_id:legacy.giveawayId,discussionChatId:chatId}):null;
 }
async function rememberCommentMessage(giveaway,msg){
  const groupChatId=String(msg.chat.id),messageId=Number(msg.message_id);
  if(!Number.isSafeInteger(messageId)||messageId<1)throw new Error('Invalid comment message ID.');
  const key={groupChatId,messageId};
  try{await CommentMessage.updateOne(key,{$setOnInsert:{...key,giveawayId:giveaway._id,channelId:giveaway.channelId,channelPostId:giveaway.channelPostId}},{upsert:true});}catch(e){if(e.code!==11000)throw e;}
  const mapping=await CommentMessage.findOne(key).select('giveawayId').lean();
  if(!mapping||String(mapping.giveawayId)!==String(giveaway._id))throw new Error('Comment message is already linked to a different giveaway.');
 }
 async function comment(m){
  if(!['group','supergroup'].includes(m.chat.type)||!m.reply_to_message)return;
  const group=await Group.findOne({id:String(m.chat.id)}).select('approved').lean();if(group?.approved!==true)return;
  const g=await resolveCommentGiveaway(m);if(!g)return;
  if(extractChannelOrigin(m))await rememberCommentMessage(g,m.reply_to_message);
  await rememberCommentMessage(g,m);if(g.status!=='active')return;
  if(!m.from||m.from.is_bot)return;
  let forceRejectReason=null;
  if(g.rules?.excludeAdmins){const member=await bot.getChatMember(m.chat.id,m.from.id).catch(()=>null);if(member&&['administrator','creator'].includes(member.status)){forceRejectReason='admin';await AuditEvent.create({action:'entry_rejected_admin',actorId:String(m.from.id),giveawayId:g._id,targetId:String(m.message_id),meta:{chatId:String(m.chat.id)}}).catch(()=>{});}}
  await recordComment(g,m,{forceRejectReason});
 }
 function customEmoji(id,fallback){
  const safeId=String(id??'').trim(),safeFallback=String(fallback??'⭐');
  if(!/^\d+$/.test(safeId)||/[<&>]/.test(safeFallback))return esc(safeFallback);
  return '<tg-emoji emoji-id="'+safeId+'">'+safeFallback+'</tg-emoji>';
 }
 function winnerDisplay(w){return mention({id:w.userId,firstName:w.firstName,lastName:w.lastName,username:w.username});}
 function hasPaidReaction(reactions){return Array.isArray(reactions)&&reactions.some(r=>r&&r.type==='paid');}
 async function reactionUpdate(r){
  const channelId=r?.chat?.id!=null?String(r.chat.id):'',postId=Number(r?.message_id||0);
  if(!channelId||!Number.isInteger(postId)||postId<1)return;
  const g=await Giveaway.findOne({channelId,channelPostId:postId});
  if(!g){await AuditEvent.create({action:'paid_star_reaction_orphan',actorId:r.user?.id!=null?String(r.user.id):'anonymous',targetId:String(postId),meta:{channelId,hasUser:!!r.user,hasPaidReaction:hasPaidReaction(r.new_reaction)}}).catch(()=>{});return;}
  const now=new Date();await Giveaway.updateOne({_id:g._id},{$set:{lastReactionUpdateAt:now}}).catch(()=>{});
  // Anonymous reactions are counted for diagnostics, but cannot select an individual winner without a Telegram user ID.
  if(!r.user?.id){await AuditEvent.create({action:hasPaidReaction(r.new_reaction)?'paid_star_anonymous_reaction':'anonymous_reaction_changed',actorId:'anonymous',giveawayId:g._id,targetId:String(postId),meta:{channelId,actorChatId:r.actor_chat?.id!=null?String(r.actor_chat.id):null}}).catch(()=>{});return;}
  const active=hasPaidReaction(r.new_reaction),user=r.user;
  const existing=await PaidReaction.findOne({giveawayId:g._id,userId:String(user.id)}).select('manualOverride').lean();
  const effectiveActive=existing?.manualOverride===true?true:active;
  await PaidReaction.findOneAndUpdate({giveawayId:g._id,userId:String(user.id)},{$set:{channelId,channelPostId:postId,userId:String(user.id),username:user.username||'',firstName:user.first_name||'',lastName:user.last_name||'',active:effectiveActive,lastReactionAt:now},$setOnInsert:{starCount:1,manualOverride:false}},{upsert:true,new:true});
  await saveUser(user);
  await AuditEvent.create({action:active?'paid_star_reaction_added':'paid_star_reaction_removed',actorId:String(user.id),giveawayId:g._id,targetId:String(postId),meta:{channelId,oldPaidReaction:hasPaidReaction(r.old_reaction),newPaidReaction:active}}).catch(()=>{});
 }
 async function reactionCountUpdate(r){
  const channelId=r?.chat?.id!=null?String(r.chat.id):'',postId=Number(r?.message_id||0);
  if(!channelId||!Number.isInteger(postId)||postId<1)return;
  const g=await Giveaway.findOne({channelId,channelPostId:postId});if(!g)return;
  const paid=r.reactions?.find(x=>x?.type==='paid'),anonymousPaidStarCount=Number(paid?.total_count||0),now=new Date();
  await Giveaway.updateOne({_id:g._id},{$set:{anonymousPaidStarCount,anonymousPaidStarCountUpdatedAt:now,lastReactionUpdateAt:now}}).catch(()=>{});
  await AuditEvent.create({action:'paid_star_anonymous_count_updated',actorId:'telegram',giveawayId:g._id,targetId:String(postId),meta:{channelId,anonymousPaidStarCount}}).catch(()=>{});
 }
 async function owner(id){return cfg.ownerId&&String(id)===cfg.ownerId;}
 async function admin(m){if(await owner(m.from?.id))return true;if(!['group','supergroup'].includes(m.chat?.type)||!m.from?.id)return false;try{const x=await bot.getChatMember(m.chat.id,m.from.id);return ['administrator','creator'].includes(x.status);}catch{return false;}}
 async function requireApprovedGroup(m){return ['group','supergroup','channel'].includes(m.chat?.type)&&await isApprovedGroup(m.chat.id);}
 async function resolveApprovalTarget(m,arg){if(arg){const raw=String(arg).trim();return /^-?\d+$/.test(raw)?raw:null;}if(['group','supergroup'].includes(m.chat?.type))return String(m.chat.id);return null;}
 async function command(m){
  const parts=(m.text||'').trim().split(/\s+/),cmd=(parts[0]||'').split('@')[0].toLowerCase();
  if(cmd==='/approve'||cmd==='/approvec'){
   if(!await owner(m.from?.id))return;
   const target=await resolveApprovalTarget(m,parts[1]);if(!target)return;
   let chat=m.chat;if(String(m.chat.id)!==target){try{chat=await bot.getChat(target);}catch{return;}}
   if(String(chat.id)!==target||!['group','supergroup','channel'].includes(chat.type))return;
   await Group.updateOne({id:target},{$set:{approved:true,title:chat.title||'',type:chat.type,username:chat.username||'',lastSeenAt:new Date()}},{upsert:true});
   if(m.chat.type==='private')return bot.sendMessage(m.chat.id,'✅ Approved: <b>'+esc(chat.title||target)+'</b>\n🆔 <code>'+esc(target)+'</code>',{parse_mode:'HTML'});
   return;
  }
  if(cmd==='/unapprove'){
   if(!await owner(m.from?.id))return;
   const target=await resolveApprovalTarget(m,parts[1]);if(!target)return;
   await Group.updateOne({id:target},{$set:{approved:false}},{upsert:true});
   if(m.chat.type==='private')return bot.sendMessage(m.chat.id,'🚫 Unapproved: <code>'+esc(target)+'</code>',{parse_mode:'HTML'});
   return;
  }
  if(cmd==='/approvegclist'){
   if(!await owner(m.from?.id))return;
   const groups=await Group.find({approved:true}).sort({title:1}).limit(100).lean();
   if(!groups.length)return bot.sendMessage(m.chat.id,'📋 No approved groups or channels yet.');
   const lines=groups.map((g,i)=>(i+1)+'. <b>'+esc(g.title||'Untitled')+'</b>\n   <code>'+esc(g.id)+'</code> · '+esc(g.type||'unknown')).join('\n');
   return bot.sendMessage(m.chat.id,'📋 <b>APPROVED GROUP / CHANNEL LIST</b>\n━━━━━━━━━━━━━━━━━━\n'+lines+'\n\nShowing '+groups.length+' (max 100).',{parse_mode:'HTML'});
  }
  if(m.chat.type!=='private'&&!(await requireApprovedGroup(m)))return;
  if(cmd==='/start')return bot.sendMessage(m.chat.id,'🎟️ <b>CMT PICKER V2 PRO</b>\n━━━━━━━━━━━━━━━━━━\n\n🎁 <b>Giveaway Picker</b>\n⭐ <b>Paid Star Picker</b>\n🔄 <b>Reroll & Winner History</b>\n🛡️ <b>Secure Admin Controls</b>\n\n━━━━━━━━━━━━━━━━━━\n✅ <i>System ready for secure winner selection.</i>',{parse_mode:'HTML'});
  if(cmd==='/admin'){if(!await owner(m.from.id))return bot.sendMessage(m.chat.id,'⛔ <b>OWNER ONLY</b>\n\nYou do not have permission to use this command.');const [u,g,w,e]=await Promise.all([User.countDocuments(),Group.countDocuments(),Giveaway.countDocuments(),Entry.countDocuments()]);return bot.sendMessage(m.chat.id,'<b>V2 PRO DASHBOARD</b>\n\n👤 Users: <b>'+u+'</b>\n👥 Groups: <b>'+g+'</b>\n🎁 Giveaways: <b>'+w+'</b>\n💬 Entries: <b>'+e+'</b>\n\n/status - system health',{parse_mode:'HTML'});}
  if(cmd==='/status'){if(!await owner(m.from.id))return bot.sendMessage(m.chat.id,'⛔ <b>OWNER ONLY</b>\n\nYou do not have permission to use this command.');return bot.sendMessage(m.chat.id,'🟢 <b>V2 Pro Online</b>\nUptime: '+Math.floor(process.uptime())+'s\nMongo: '+(mongoose.connection.readyState===1?'connected':'disconnected')+'\nNode: '+process.version,{parse_mode:'HTML'});}
  if(cmd==='/giveaway')return createGiveaway(m,parts[1],parts.slice(2).join(' '));
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
 async function createGiveaway(m,countArg,keyword){
  if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ <b>ADMIN ACCESS REQUIRED</b>\n\nOnly the group admin or bot owner can use this command.');
  if(!await requireApprovedGroup(m))return;
  const r=m.reply_to_message;
  if(!r)return bot.sendMessage(m.chat.id,'❌ <b>GIVEAWAY SETUP</b>\n\nReply to the forwarded channel post.\n\nUsage: <code>/giveaway 3 keyword</code>');
  const origin=extractChannelOrigin(m);
  if(!origin)return bot.sendMessage(m.chat.id,'❌ <b>INVALID GIVEAWAY POST</b>\n\nReply directly to the forwarded channel post in its discussion group.');
  const postId=origin.channelPostId,channelId=origin.channelId,rawCount=Number(countArg||1);
  if(!Number.isInteger(rawCount)||rawCount<1)return bot.sendMessage(m.chat.id,'❌ Winner count must be a whole number greater than 0.');
  if(rawCount>cfg.pickCountMax)return bot.sendMessage(m.chat.id,'❌ Maximum winners per giveaway is '+cfg.pickCountMax+'.');
  const count=rawCount;
  const g=await Giveaway.findOneAndUpdate({channelId,channelPostId:postId},{$set:{discussionChatId:String(m.chat.id),winnerCount:count,rules:{keyword:keyword||undefined,requireUsername:false,requireBotStart:false,excludeAdmins:true}},$setOnInsert:{title:(r.text||r.caption||'Giveaway').slice(0,120),status:'active',durationSeconds:cfg.rollDurationSeconds,createdBy:String(m.from.id),createdAt:new Date()}},{upsert:true,new:true});
  await rememberCommentMessage(g,r);
  const text=formatMessage([
   customEmoji('5188344996356448758','🎁')+' <b>GIVEAWAY CONFIGURED</b>',
   '━━━━━━━━━━━━━━━━━━','',
   '🆔 <b>Giveaway ID</b>','└ <code>'+g._id+'</code>','',
   customEmoji('4978994451964757181','🏆')+' <b>Winners</b>','└ '+count,'',
   '🔑 <b>Keyword</b>','└ '+esc(keyword||'None'),'',
   '━━━━━━━━━━━━━━━━━━',
   '✅ Comments replying to this post are now collected automatically.'
  ]);
  await bot.sendMessage(m.chat.id,text,{parse_mode:'HTML'});
  await AuditEvent.create({action:'create_giveaway',actorId:String(m.from.id),giveawayId:g._id,meta:{count,keyword:keyword||null}});
 }
 async function pick(m,arg){
  if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ <b>ADMIN ACCESS REQUIRED</b>\n\nOnly the group admin or bot owner can use this command.');
  if(!await requireApprovedGroup(m))return;
  const g=await findGiveaway(m,arg);
  if(!g)return bot.sendMessage(m.chat.id,'❌ <b>GIVEAWAY NOT FOUND</b>\n\nReply to the giveaway post or provide a valid Giveaway ID.');
  const parsed=String(arg||'')===String(g._id)?Number(g.winnerCount||1):Number(arg||g.winnerCount||1);
  if(!Number.isInteger(parsed)||parsed<1)return bot.sendMessage(m.chat.id,'❌ Winner count must be a whole number greater than 0.');
  if(parsed>cfg.pickCountMax)return bot.sendMessage(m.chat.id,'❌ Maximum winners per pick is '+cfg.pickCountMax+'.');
  const n=parsed,rollEmoji='<tg-emoji emoji-id="'+esc(cfg.rollingEmojiId)+'">🎰</tg-emoji>';
  const barSize=10,rollDurationMs=20000,rollStepMs=2000;
  let p;
  try{
   const rollTitle=customEmoji('5188344996356448758','🏆')+' <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • 𝐃𝐑𝐀𝐖𝐈𝐍𝐆</b>';
   const selectEmoji=customEmoji('5314336934271663511','🌟'),roundEmoji=customEmoji('5260547274957672345','🎲');
   const candidateEmoji=customEmoji('5985525762973768278','👥'),winnerEmoji=customEmoji('4978994451964757181','🎖️');
   const secureEmoji=customEmoji('5224607267797606837','☄️'),waitEmoji=customEmoji('5399850755337240950','⏳');
   const renderRolling=(filled,candidates)=>formatMessage([
    rollTitle,'━━━━━━━━━━━━━━━━━━','',
    selectEmoji+' <b>SELECTING WINNERS</b>',progress(filled,barSize),'',
    roundEmoji+' <b>Round</b>','└ <b>1</b>','',
    candidateEmoji+' <b>Candidates</b>','└ <b>'+candidates+'</b>','',
    winnerEmoji+' <b>Winners</b>','└ <b>'+n+'</b>','',
    secureEmoji+' <b>Secure random selection</b>',waitEmoji+' <i>Please wait...</i>'
   ]);
   p=await bot.sendMessage(m.chat.id,renderRolling(0,'Preparing...'),{parse_mode:'HTML',reply_to_message_id:m.message_id});
   let nextStep=1,nextEditAt=Date.now()+rollStepMs,latestCandidates='Preparing...';
   const r=await pickWinners(g._id,n,{durationSeconds:20,onProgress:async state=>{
    latestCandidates=state.candidateCount;const now=Date.now();
    while(nextStep<=barSize&&now>=nextEditAt){
     const filled=nextStep++;nextEditAt+=rollStepMs;
     const text=renderRolling(filled,latestCandidates);
     try{await bot.editMessageText(text,{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});}catch(e){if(!String(e.message||e).includes('message is not modified'))throw e;}
    }
   }});
   if(nextStep<=barSize){try{await bot.editMessageText(renderRolling(barSize,latestCandidates),{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});}catch(e){if(!String(e.message||e).includes('message is not modified'))throw e;}}
   const winnerIds=r.winners.map(w=>String(w.userId));
   const entries=await Entry.find({giveawayId:g._id,userId:{$in:winnerIds}}).select('userId commentText commentType').lean();
   const comments=new Map(entries.map(e=>[String(e.userId),{text:e.commentText||'',type:e.commentType||'text'}]));
   const displayComment=userId=>{const c=comments.get(String(userId));if(!c)return '—';if(c.type==='sticker')return 'Sticker';if(c.type!=='text')return 'Media';const text=String(c.text||'').trim();if(text&&!/[A-Za-z0-9]/.test(text))return 'Emoji';return esc(text||'—');};
   const medalIds=['5440539497383087970','5447203607294265305','5453902265922376865'],defaultMedal=['🥇','🥈','🥉'];
   const rankEmoji=i=>i<3?customEmoji(medalIds[i],defaultMedal[i]):customEmoji('5150415989841593609','🎖️');
   const lines=r.winners.map((w,i)=>rankEmoji(i)+' <b>#'+(i+1)+'</b>  '+winnerDisplay(w)+'\n   '+customEmoji('5215334566549540768','💬')+' '+displayComment(w.userId));
   const header=customEmoji('5188344996356448758','🏆')+' <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • 𝐑𝐄𝐒𝐔𝐋𝐓</b>\n\n'+'━━━━━━━━━━━━━━━━━━\n\n'+customEmoji('5461151367559141950','🎉')+' <b>WINNERS SELECTED</b>\n\n';
   const stats=customEmoji('5444856076954520455','🧾')+' <b>Giveaway Post</b>\n'+'└ <b>#'+esc(g.channelPostId)+'</b>\n\n'+'👥 <b>Total Entries</b>\n'+'└ <b>'+r.entryCount+'</b>\n\n'+customEmoji('4978994451964757181','🎖️')+' <b>Winners</b>\n'+'└ <b>'+r.winners.length+'</b>\n\n'+customEmoji('5280816565657300091','🎲')+' <b>Round</b>\n'+'└ <b>'+r.winners[0].round+'</b>\n\n';
   const footer='━━━━━━━━━━━━━━━━━━\n'+customEmoji('5197288647275071607','🛡️')+' <b>Secure Random Draw</b>\n'+customEmoji('6129931368148243023','⚡')+' <b>CMT PICKER V2 PRO</b>\n'+customEmoji('4907231385309152742','🪪')+' @CommentsPickerBot';
   await bot.editMessageText(formatMessage([header,stats,lines.join('\n\n'),footer]),{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});
   await AuditEvent.create({action:'pick',actorId:String(m.from.id),giveawayId:g._id,meta:{count:n}});
  }catch(e){
   const errorText=formatMessage(['⚠️ <b>DRAW COULD NOT BE COMPLETED</b>','',esc(e.message),'<i>No winner result was published.</i>']);
   if(p){try{await bot.editMessageText(errorText,{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});}catch{}}
   else await bot.sendMessage(m.chat.id,formatMessage(['❌ <b>PICK FAILED</b>','',esc(e.message)]),{parse_mode:'HTML'});
  }
 }
 async function pickStar(m,arg){
  if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ <b>ADMIN ACCESS REQUIRED</b>\n\nOnly the group admin or bot owner can use this command.');
  if(!await requireApprovedGroup(m))return;
  const reply=m.reply_to_message;let g=null,n=null;
  if(reply){
   g=await findGiveaway(m);
   if(!g)return bot.sendMessage(m.chat.id,'❌ <b>GIVEAWAY NOT FOUND</b>\n\nReply to the giveaway post or provide a valid Giveaway ID.');
   n=(arg===undefined||String(arg)===String(g._id))?Number(g.winnerCount||1):Number(arg);
  }else{
   const raw=String(arg||'');
   if(/^[0-9]+$/.test(raw)){const possibleCount=Number(raw);if(possibleCount>=1&&possibleCount<=cfg.pickCountMax)return bot.sendMessage(m.chat.id,'❌ Reply to the giveaway post when using a winner count. Example: /pickstarwinner 3');}
   g=await findGiveaway(m,raw);
   if(!g)return bot.sendMessage(m.chat.id,'❌ <b>GIVEAWAY NOT FOUND</b>\n\nReply to the giveaway post or provide a valid Giveaway ID.');
   n=Number(g.winnerCount||1);
  }
  if(!Number.isInteger(n)||n<1)return bot.sendMessage(m.chat.id,'❌ Winner count must be a whole number greater than 0.');
  if(n>cfg.pickCountMax)return bot.sendMessage(m.chat.id,'❌ Maximum winners per pick is '+cfg.pickCountMax+'.');
  let p;
  try{
   p=await bot.sendMessage(m.chat.id,formatMessage([
    customEmoji('5188344996356448758','🏆')+' <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • 𝐏𝐀𝐈𝐃 𝐒𝐓𝐀𝐑</b>','━━━━━━━━━━━━━━━━━━','',
    customEmoji('5314336934271663511','🌟')+' <b>SELECTING WINNERS</b>',progress(0,10),'',
    customEmoji('5260547274957672345','🎲')+' <b>Round</b>','└ <b>1</b>','',
    customEmoji('5985525762973768278','👥')+' <b>Candidates</b>','└ <b>Preparing...</b>','',
    customEmoji('4978994451964757181','🎖️')+' <b>Winners</b>','└ <b>'+n+'</b>','',
    customEmoji('5224607267797606837','☄️')+' <b>Secure random selection</b>',customEmoji('5399850755337240950','⏳')+' <i>Please wait...</i>'
   ]),{parse_mode:'HTML',reply_to_message_id:m.message_id});
   const barSize=10,rollStepMs=2000;let nextStep=1,nextEditAt=Date.now()+rollStepMs,latestCandidates='Preparing...';
   if(paidStarClient){try{const sync=await syncPaidStarReactors(paidStarClient,g,{logger});if(sync.synced>0)logger.info('Paid Star MTProto sync completed',{giveawayId:String(g._id),synced:sync.synced,total:sync.total});}catch(syncError){logger.warn('Paid Star MTProto sync failed; continuing with live Bot API tracking: '+(syncError.message||syncError));}}
   const r=await pickStarWinners(g._id,n,{durationSeconds:20,onProgress:async state=>{
    latestCandidates=state.candidateCount;const now=Date.now();
    while(nextStep<=barSize&&now>=nextEditAt){
     const filled=nextStep++;nextEditAt+=rollStepMs;
     const text=formatMessage([
      customEmoji('5188344996356448758','🏆')+' <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • 𝐏𝐀𝐈𝐃 𝐒𝐓𝐀𝐑</b>','━━━━━━━━━━━━━━━━━━','',
      customEmoji('5314336934271663511','🌟')+' <b>SELECTING WINNERS</b>',progress(filled,10),'',
      customEmoji('5260547274957672345','🎲')+' <b>Round</b>','└ <b>1</b>','',
      customEmoji('5985525762973768278','👥')+' <b>Candidates</b>','└ <b>'+state.candidateCount+'</b>','',
      customEmoji('4978994451964757181','🎖️')+' <b>Winners</b>','└ <b>'+n+'</b>','',
      customEmoji('5224607267797606837','☄️')+' <b>Secure random selection</b>',customEmoji('5399850755337240950','⏳')+' <i>Please wait...</i>'
     ]);
     try{await bot.editMessageText(text,{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});}catch(e){if(!String(e.message||e).includes('message is not modified'))throw e;}
    }
   }});
   if(nextStep<=barSize){const finalRoll=formatMessage([customEmoji('5188344996356448758','🏆')+' <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • 𝐏𝐀𝐈𝐃 𝐒𝐓𝐀𝐑</b>','━━━━━━━━━━━━━━','',' '+customEmoji('5314336934271663511','🌟')+' <b>SELECTING WINNERS...</b>',progress(barSize,barSize),'',customEmoji('5260547274957672345','🎲')+' Round <b>1</b>',customEmoji('5985525762973768278','👥')+' Candidates: <b>'+latestCandidates+'</b>',customEmoji('4978994451964757181','🎖️')+' Winners: <b>'+n+'</b>',customEmoji('5224607267797606837','☄️')+' Secure random selection',customEmoji('5399850755337240950','⏳')+' Please wait...']);try{await bot.editMessageText(finalRoll,{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});}catch(e){if(!String(e.message||e).includes('message is not modified'))throw e;}}
   const winnerIds=r.winners.map(w=>String(w.userId)),entries=await Entry.find({giveawayId:g._id,userId:{$in:winnerIds}}).select('userId commentText commentType').lean();
   const comments=new Map(entries.map(e=>[String(e.userId),{text:e.commentText||'',type:e.commentType||'text'}]));
   const displayComment=userId=>{const c=comments.get(String(userId));if(!c)return '—';if(c.type==='sticker')return 'Sticker';if(c.type!=='text')return 'Media';const text=String(c.text||'').trim();if(text&&!/[A-Za-z0-9]/.test(text))return 'Emoji';return esc(text||'—');};
   const lines=r.winners.map((w,i)=>customEmoji('5150415989841593609','🎖️')+' <b>#'+(i+1)+'</b>  '+winnerDisplay(w)+'\n   '+customEmoji('5215334566549540768','💬')+' '+displayComment(w.userId));
   const header=customEmoji('5188344996356448758','🏆')+' <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • 𝐏𝐀𝐈𝐃 𝐒𝐓𝐀𝐑</b>\n\n'+'━━━━━━━━━━━━━━━━━━\n\n'+customEmoji('5461151367559141950','🎉')+' <b>WINNERS SELECTED</b>\n\n';
   const stats=customEmoji('5444856076954520455','🧾')+' <b>Giveaway Post</b>\n'+'└ <b>#'+esc(g.channelPostId)+'</b>\n\n'+customEmoji('5280816565657300091','🎲')+' <b>Round</b>\n'+'└ <b>'+r.winners[0].round+'</b>\n\n'+customEmoji('4978994451964757181','🎖️')+' <b>Winners</b>\n'+'└ <b>'+r.winners.length+'</b>\n\n'+customEmoji('6129931368148243023','⚡')+' <b>Active Star Participants</b>\n'+'└ <b>'+r.candidateCount+'</b>\n\n';
   const footer='━━━━━━━━━━━━━━━━━━\n'+customEmoji('5197288647275071607','🛡️')+' <b>Paid Star Random Draw</b>\n'+customEmoji('6129931368148243023','⚡')+' <b>CMT PICKER V2 PRO</b>\n'+customEmoji('4907231385309152742','🪪')+' @CommentsPickerBot';
   await bot.editMessageText(formatMessage([header,stats,lines.join('\n\n'),footer]),{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});
   await AuditEvent.create({action:'pick_star_winners',actorId:String(m.from.id),giveawayId:g._id,meta:{count:n,paidReaction:true}});
  }catch(e){
   const [trackedActive,trackedInactive]=await Promise.all([PaidReaction.countDocuments({giveawayId:g._id,active:true}).catch(()=>0),PaidReaction.countDocuments({giveawayId:g._id,active:false}).catch(()=>0)]);
   const diagnostic=formatMessage(['',customEmoji('5985525762973768278','👥')+' Tracked Active: <b>'+trackedActive+'</b>','↩️ Tracked Inactive: <b>'+trackedInactive+'</b>','👤 Anonymous Paid Stars: <b>'+Number(g.anonymousPaidStarCount||0)+'</b>','<i>Use /starstatus for webhook and reaction diagnostics.</i>']);
   if(p){try{await bot.editMessageText(formatMessage(['⚠️ <b>PAID STAR DRAW FAILED</b>','',esc(e.message),diagnostic,'<i>No winner result was published.</i>']),{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});}catch{}}
   else await bot.sendMessage(m.chat.id,formatMessage(['❌ <b>PAID STAR PICK FAILED</b>','',esc(e.message),diagnostic]),{parse_mode:'HTML'});
  }
 }
 async function rerollCmd(m,arg){
  if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ <b>ADMIN ACCESS REQUIRED</b>\n\nOnly the group admin or bot owner can use this command.');
  if(!await requireApprovedGroup(m))return;
  const g=await findGiveaway(m,arg);
  if(!g)return bot.sendMessage(m.chat.id,'❌ <b>GIVEAWAY NOT FOUND</b>\n\nReply to the giveaway post or provide its ID.');
  const raw=String(arg||'')===String(g._id)?Number(g.winnerCount||1):Number(arg||g.winnerCount||1);
  if(!Number.isInteger(raw)||raw<1)return bot.sendMessage(m.chat.id,'❌ Reroll count must be a whole number greater than 0.');
  if(raw>cfg.pickCountMax)return bot.sendMessage(m.chat.id,'❌ Maximum winners per reroll is '+cfg.pickCountMax+'.');
  const n=raw;
  try{
   const latestWinner=await Winner.findOne({giveawayId:g._id,status:'winner'}).sort({round:-1}).lean();
   const r=latestWinner?.selectionMode==='paid_star'?await rerollStarWinners(g._id,n):await reroll(g._id,n);
   const rows=await Winner.find({giveawayId:g._id,round:r.round,status:'winner'}).sort({rank:1}).lean();
   const lines=rows.map((w,i)=>{const ids=['5440539497383087970','5447203607294265305','5453902265922376865','5150415989841593609'],fallback=['🥇','🥈','🥉','🎖️'];return customEmoji(ids[Math.min(i,3)],fallback[Math.min(i,3)])+' <b>#'+(i+1)+'</b>  '+winnerDisplay(w);});
   const text=formatMessage([customEmoji('5188344996356448758','🏆')+' <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • 𝐑𝐄𝐑𝐎𝐋𝐋</b>','━━━━━━━━━━━━━━━━━━','',customEmoji('5280816565657300091','🎲')+' <b>Round</b>','└ <b>'+r.round+'</b>','',customEmoji('4978994451964757181','🎖️')+' <b>New Winners</b>',...lines,'','━━━━━━━━━━━━━━━━━━',customEmoji('5197288647275071607','🛡️')+' <i>Previous winners are excluded from this draw.</i>']);
   await bot.sendMessage(m.chat.id,text,{parse_mode:'HTML',reply_to_message_id:m.message_id});
   await AuditEvent.create({action:'reroll',actorId:String(m.from.id),giveawayId:g._id,meta:{count:n,round:r.round}});
  }catch(e){await bot.sendMessage(m.chat.id,formatMessage(['⚠️ <b>REROLL FAILED</b>','',esc(e.message||e)]),{parse_mode:'HTML',reply_to_message_id:m.message_id});}
 }
 async function winnerList(m){
  if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ <b>ADMIN ACCESS REQUIRED</b>\n\nOnly the group admin or bot owner can use this command.');
  if(!await requireApprovedGroup(m))return;
  const parts=(m.text||'').trim().split(/\s+/);
  const isObjectId=value=>typeof value==='string'&&/^[a-f\d]{24}$/i.test(value);
  const explicitId=isObjectId(parts[1])?parts[1]:undefined,pageArg=explicitId?parts[2]:parts[1];
  const g=await findGiveaway(m,explicitId);
  if(!g)return bot.sendMessage(m.chat.id,'❌ <b>GIVEAWAY NOT FOUND</b>\n\nReply to the giveaway post or provide a valid Giveaway ID.');
  const all=await Winner.find({giveawayId:g._id,status:'winner'}).sort({round:-1,rank:1}).lean();
  if(!all.length)return bot.sendMessage(m.chat.id,'ℹ️ <b>NO ACTIVE WINNERS</b>\n\nThere are no current winners for this giveaway.');
  const pageSize=10,totalPages=Math.max(1,Math.ceil(all.length/pageSize)),parsedPage=Number(pageArg||1);
  const page=Math.min(totalPages,Math.max(1,Number.isInteger(parsedPage)?parsedPage:1));
  const rows=all.slice((page-1)*pageSize,page*pageSize),winnerIds=[...new Set(rows.map(w=>String(w.userId)))];
  const entries=await Entry.find({giveawayId:g._id,userId:{$in:winnerIds}}).select('userId commentText commentType').lean();
  const comments=new Map(entries.map(e=>[String(e.userId),{text:e.commentText||'',type:e.commentType||'text'}]));
  const displayComment=userId=>{const c=comments.get(String(userId));if(!c)return '—';if(c.type==='sticker')return 'Sticker';if(c.type!=='text')return 'Media';const text=String(c.text||'').trim();if(text&&!/[A-Za-z0-9]/.test(text))return 'Emoji';return esc(text||'—');};
  const lines=rows.map((w,i)=>{const rank=(page-1)*pageSize+i+1,ids=['5440539497383087970','5447203607294265305','5453902265922376865','5150415989841593609'],fallback=['🥇','🥈','🥉','🎖️'];return customEmoji(ids[Math.min(rank-1,3)],fallback[Math.min(rank-1,3)])+' <b>#'+rank+'</b>  '+winnerDisplay(w)+'\n   '+customEmoji('5215334566549540768','💬')+' '+displayComment(w.userId)+'\n   '+customEmoji('5280816565657300091','🎲')+' Round <b>'+w.round+'</b>';});
  const next=page<totalPages?page+1:1,idArg=explicitId?esc(explicitId)+' ':'';
  const text=formatMessage([customEmoji('5188344996356448758','🏆')+' <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • 𝐖𝐈𝐍𝐍𝐄𝐑 𝐋𝐈𝐒𝐓</b>','━━━━━━━━━━━━━━━━━━','',customEmoji('5444856076954520455','🧾')+' <b>Giveaway Post</b>','└ <b>#'+esc(g.channelPostId)+'</b>','',...lines,'','━━━━━━━━━━━━━━━━━━','📄 Page <b>'+page+'/'+totalPages+'</b> · Total <b>'+all.length+'</b>','<i>Use /winnerlist '+idArg+next+' to view the next page.</i>']);
  return bot.sendMessage(m.chat.id,text,{parse_mode:'HTML',reply_to_message_id:m.message_id});
 }
 async function starSync(m){
  if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ <b>ADMIN ACCESS REQUIRED</b>\n\nOnly the group admin or bot owner can use this command.');if(!await requireApprovedGroup(m))return;
  if(!paidStarClient)return bot.sendMessage(m.chat.id,'⚠️ Paid Star historical sync is not configured. Set TG_API_ID and TG_API_HASH in Render, then redeploy.');
  const g=await findGiveaway(m);
  if(!g)return bot.sendMessage(m.chat.id,'❌ <b>GIVEAWAY NOT FOUND</b>\n\nReply to the giveaway post or provide its ID.');
  try{
   const sync=await syncPaidStarReactors(paidStarClient,g,{logger}),active=await PaidReaction.countDocuments({giveawayId:g._id,active:true});
   return bot.sendMessage(m.chat.id,formatMessage(['🔄 <b>PAID STAR SYNC COMPLETE</b>','━━━━━━━━━━━━━━━━━━','', '🆔 <b>Giveaway Post</b>','└ #'+esc(g.channelPostId),'👥 <b>Leaderboard Reactors</b>','└ '+sync.total,'✅ <b>Synced Active</b>','└ '+sync.synced,'⭐ <b>Tracked Active Total</b>','└ '+active,'','━━━━━━━━━━━━━━━━━━','💡 <i>/pickstarwinner can now use the synced identifiable reactors.</i>']),{parse_mode:'HTML',reply_to_message_id:m.message_id});
  }catch(e){return bot.sendMessage(m.chat.id,formatMessage(['⚠️ <b>PAID STAR SYNC FAILED</b>','',esc(e.message||String(e))]),{parse_mode:'HTML',reply_to_message_id:m.message_id});}
 }
 async function starStatus(m){
  if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ <b>ADMIN ACCESS REQUIRED</b>\n\nOnly the group admin or bot owner can use this command.');if(!await requireApprovedGroup(m))return;
  const g=await findGiveaway(m);if(!g)return bot.sendMessage(m.chat.id,'❌ <b>GIVEAWAY NOT FOUND</b>\n\nReply to the giveaway post or provide a valid Giveaway ID.');
  const mtStatus=paidStarMtStatus(paidStarClient),[active,inactive]=await Promise.all([PaidReaction.countDocuments({giveawayId:g._id,active:true}),PaidReaction.countDocuments({giveawayId:g._id,active:false})]);
  let webhook='Not verified',webhookDetail='';
  try{const wh=await bot.getWebHookInfo();webhook=wh.url?'🟢 Connected':'🔴 Not configured';const allowed=Array.isArray(wh.allowed_updates)?wh.allowed_updates:[];webhookDetail='Reaction: '+(allowed.includes('message_reaction')?'🟢':'🔴')+'  Anonymous count: '+(allowed.includes('message_reaction_count')?'🟢':'🔴')+'\nMTProto Star Sync: '+(mtStatus.enabled?'🟢 Enabled':'🔴 Disabled');if(wh.last_error_message)webhookDetail+='\nLast error: '+esc(wh.last_error_message);}catch(e){webhookDetail='Webhook check failed: '+esc(e.message||String(e));}
  const last=g.lastReactionUpdateAt?new Date(g.lastReactionUpdateAt).toISOString():'Never',anon=Number(g.anonymousPaidStarCount||0);
  const text=formatMessage([customEmoji('5188344996356448758','🏆')+' <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • 𝐏𝐀𝐈𝐃 𝐒𝐓𝐀𝐑 𝐒𝐓𝐀𝐓𝐔𝐒</b>','━━━━━━━━━━━━━━━','',customEmoji('5985525762973768278','👥')+' Tracked Active: <b>'+active+'</b>','↩️ Tracked Inactive: <b>'+inactive+'</b>','👤 Anonymous Paid Stars: <b>'+anon+'</b>','🆔 Post ID: <b>'+esc(g.channelPostId)+'</b>','',customEmoji('5224607267797606837','☄️')+' Webhook: <b>'+webhook+'</b>',webhookDetail,'🕒 Last Reaction Update: <b>'+esc(last)+'</b>','','💡 Only identifiable users can be selected as winners.']);
  return bot.sendMessage(m.chat.id,text,{parse_mode:'HTML',reply_to_message_id:m.message_id});
 }
 async function broadcast(m,text){
  if(!await requireApprovedGroup(m)&&m.chat?.type!=='private')return;
  if(!await owner(m.from.id))return bot.sendMessage(m.chat.id,'⛔ <b>OWNER ONLY</b>\n\nYou do not have permission to use this command.');
  if(!text)return bot.sendMessage(m.chat.id,'❌ <b>BROADCAST</b>\n\nUsage: <code>/broadcast your message</code>');
  const groups=await Group.find({approved:true}).select('id').lean();
  const job=await BroadcastJob.create({text,createdBy:String(m.from.id),targets:groups.map(g=>({chatId:g.id,status:'pending',attempts:0}))});
  await bot.sendMessage(m.chat.id,formatMessage(['📣 <b>BROADCAST QUEUED</b>','━━━━━━━━━━━━━━━━━━','', '🆔 <b>Job</b>','└ <code>'+job._id+'</code>','', '👥 <b>Targets</b>','└ '+groups.length]),{parse_mode:'HTML'});
  runBroadcast(bot,job._id,cfg,logger).catch(e=>logger.error('broadcast',e));
 }
 async function callback(q){try{await bot.answerCallbackQuery(q.id);}catch{}}
 const shutdown=async()=>{logger.info('graceful shutdown');clearInterval(cleanupTimer);server.close();await paidStarClient?.disconnect?.().catch(()=>{});await mongoose.disconnect().catch(()=>{});process.exit(0);};
 process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);return {app,bot,server};
}
module.exports={start};
