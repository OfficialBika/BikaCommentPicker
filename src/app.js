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

async function start(){
 const cfg=loadConfig();const logger=createLogger(cfg.logLevel);
 await mongoose.connect(cfg.mongoUri,{serverSelectionTimeoutMS:10000});logger.info('MongoDB connected');
 const bot=new TelegramBot(cfg.botToken);const app=express();app.use(express.json({limit:'1mb'}));
 app.get('/',(_,res)=>res.type('text').send('Cmt Picker V2 Pro is running.'));
 app.get('/health',(_,res)=>res.json({ok:true,status:'healthy',uptime:process.uptime(),mongo:mongoose.connection.readyState===1}));
 app.get('/ready',(_,res)=>res.status(mongoose.connection.readyState===1?200:503).json({ok:mongoose.connection.readyState===1}));
 const path='/telegram/comments_picker_v2_webhook';
 app.post(path,async(req,res)=>{res.sendStatus(200);try{await handleUpdate(req.body);}catch(e){logger.error('update error',e.stack||e.message);}});
 if(cfg.publicUrl)await bot.setWebHook(cfg.publicUrl.replace(/\/$/,'')+path,{allowed_updates:['message','channel_post','callback_query','message_reaction']});
 const server=app.listen(cfg.port,()=>logger.info('HTTP server listening on '+cfg.port));
 async function saveUser(f){if(!f)return;await User.updateOne({id:String(f.id)},{$set:{username:f.username||'',firstName:f.first_name||'',lastName:f.last_name||'',lastSeenAt:new Date()}},{upsert:true}).catch(()=>{});}
 async function saveGroup(c){if(!c||!['group','supergroup'].includes(c.type))return;await Group.updateOne({id:String(c.id)},{$set:{title:c.title||'',type:c.type,username:c.username||'',lastSeenAt:new Date()}},{upsert:true}).catch(()=>{});}
 async function handleUpdate(u){if(u.callback_query)return callback(u.callback_query);if(u.message_reaction)return reactionUpdate(u.message_reaction);const m=u.message||u.channel_post;if(u.message?.text?.startsWith('/')){if(m?.from)await saveUser(m.from);if(m?.chat)await saveGroup(m.chat);return command(u.message);}if(u.channel_post){if(m?.chat)await saveGroup(m.chat);return channelPost(u.channel_post);}if(m?.reply_to_message)return comment(m);}
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
function customEmoji(id,fallback){return '<tg-emoji emoji-id="'+esc(id)+'">'+fallback+'</tg-emoji>';}
function winnerDisplay(w){return w.username?'@'+esc(w.username):esc([w.firstName,w.lastName].filter(Boolean).join(' ')||'User');}
function hasPaidReaction(reactions){return Array.isArray(reactions)&&reactions.some(r=>r&&r.type==='paid');}
 async function reactionUpdate(r){
  if(!r?.chat?.id||!r.message_id||!r.user?.id)return;
  const g=await Giveaway.findOne({channelId:String(r.chat.id),channelPostId:r.message_id});
  if(!g)return;
  const active=hasPaidReaction(r.new_reaction);
  const user=r.user;
  await PaidReaction.findOneAndUpdate(
   {giveawayId:g._id,userId:String(user.id)},
   {$set:{channelId:String(r.chat.id),channelPostId:r.message_id,userId:String(user.id),username:user.username||'',firstName:user.first_name||'',lastName:user.last_name||'',active,lastReactionAt:new Date()}},
   {upsert:true,new:true}
  );
  if(active)await saveUser(user);
  await AuditEvent.create({action:active?'paid_star_reaction_added':'paid_star_reaction_removed',actorId:String(user.id),giveawayId:g._id,targetId:String(r.message_id),meta:{channelId:String(r.chat.id)}}).catch(()=>{});
 }
 async function owner(id){return cfg.ownerId&&String(id)===cfg.ownerId;}
 async function admin(m){if(await owner(m.from.id))return true;if(!['group','supergroup'].includes(m.chat.type))return false;try{const x=await bot.getChatMember(m.chat.id,m.from.id);return ['administrator','creator'].includes(x.status);}catch{return false;}}
 async function command(m){const parts=(m.text||'').trim().split(/\s+/);const cmd=(parts[0]||'').split('@')[0].toLowerCase();
  if(cmd==='/start')return bot.sendMessage(m.chat.id,'🎟️ <b>CMT PICKER</b>\n\n<b>V2 PRO</b> · Secure Giveaway Engine\n\n🎁 <b>Giveaway Picker</b>\n⭐ <b>Paid Star Picker</b>\n🔄 <b>Reroll & Winner History</b>\n🛡️ <b>Admin-only Controls</b>\n\n<i>Ready to pick winners fairly and securely.</i>',{parse_mode:'HTML'});
  if(cmd==='/approve'){if(!await owner(m.from.id))return bot.sendMessage(m.chat.id,'⛔ Owner only.');await Group.updateOne({id:String(m.chat.id)},{$set:{approved:true}},{upsert:true});return bot.sendMessage(m.chat.id,'✅ Group approved for comment collection.');}
  if(cmd==='/admin'){if(!await owner(m.from.id))return bot.sendMessage(m.chat.id,'⛔ Owner only.');const [u,g,w,e]=await Promise.all([User.countDocuments(),Group.countDocuments(),Giveaway.countDocuments(),Entry.countDocuments()]);return bot.sendMessage(m.chat.id,'<b>V2 PRO DASHBOARD</b>\n\n👤 Users: <b>'+u+'</b>\n👥 Groups: <b>'+g+'</b>\n🎁 Giveaways: <b>'+w+'</b>\n💬 Entries: <b>'+e+'</b>\n\n/status - system health',{parse_mode:'HTML'});}
  if(cmd==='/status'){if(!await owner(m.from.id))return bot.sendMessage(m.chat.id,'⛔ Owner only.');return bot.sendMessage(m.chat.id,'🟢 <b>V2 Pro Online</b>\nUptime: '+Math.floor(process.uptime())+'s\nMongo: '+(mongoose.connection.readyState===1?'connected':'disconnected')+'\nNode: '+process.version,{parse_mode:'HTML'});}
  if(cmd==='/giveaway')return createGiveaway(m,parts[1],parts.slice(2).join(' '));
  if(cmd==='/pickwinner')return pick(m,parts[1]);
  if(cmd==='/pickstarwinner')return pickStar(m,parts[1]);
  if(cmd==='/reroll')return rerollCmd(m,parts[1]);
  if(cmd==='/winnerlist')return winnerList(m);
  if(cmd==='/broadcast')return broadcast(m,parts.slice(1).join(' '));
 }
 async function createGiveaway(m,countArg,keyword){if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ Group admin/owner only.');const r=m.reply_to_message;if(!r)return bot.sendMessage(m.chat.id,'Reply to the forwarded channel giveaway post. Usage: /giveaway 3 optional-keyword');const origin=extractChannelOrigin(m);const postId=origin?.channelPostId||r.forward_from_message_id||r.message_id;const channelId=origin?.channelId||String(r.forward_from_chat?.id||r.chat?.id||'');const rawCount=Number(countArg||1);if(!Number.isInteger(rawCount)||rawCount<1)return bot.sendMessage(m.chat.id,'❌ Winner count must be a whole number greater than 0.');if(rawCount>cfg.pickCountMax)return bot.sendMessage(m.chat.id,'❌ Maximum winners per giveaway is '+cfg.pickCountMax+'.');const count=rawCount;const g=await Giveaway.findOneAndUpdate({channelId,channelPostId:postId},{$set:{discussionChatId:String(m.chat.id),winnerCount:count,rules:{keyword:keyword||undefined,requireUsername:false,requireBotStart:false,excludeAdmins:true}},$setOnInsert:{title:(r.text||r.caption||'Giveaway').slice(0,120),status:'active',durationSeconds:cfg.rollDurationSeconds,createdBy:String(m.from.id),createdAt:new Date()}},{upsert:true,new:true});await bot.sendMessage(m.chat.id,'🎁 <b>GIVEAWAY CONFIGURED</b>\n\nID: <code>'+g._id+'</code>\nWinners: <b>'+count+'</b>\nKeyword: <b>'+esc(keyword||'None')+'</b>\n\nComments replying to this post are collected automatically.',{parse_mode:'HTML'});await AuditEvent.create({action:'create_giveaway',actorId:String(m.from.id),giveawayId:g._id,meta:{count,keyword:keyword||null}});}
 async function pick(m,arg){
  if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ Group admin/owner only.');
  const g=await findGiveaway(m,arg);
  if(!g)return bot.sendMessage(m.chat.id,'No giveaway found. Reply to the giveaway post or provide its ID.');
  const parsed=Number(arg||g.winnerCount||1);
  if(!Number.isInteger(parsed)||parsed<1)return bot.sendMessage(m.chat.id,'❌ Winner count must be a whole number greater than 0.');
  if(parsed>cfg.pickCountMax)return bot.sendMessage(m.chat.id,'❌ Maximum winners per pick is '+cfg.pickCountMax+'.');const n=parsed;
  const rollEmoji='<tg-emoji emoji-id="'+esc(cfg.rollingEmojiId)+'">🎰</tg-emoji>';
  const barSize=10;
  let p;
  try{
    const rollTitle=customEmoji('5188344996356448758','🏆')+' <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • 𝐃𝐑𝐀𝐖𝐈𝐍𝐆</b>';
    const selectEmoji=customEmoji('5314336934271663511','🌟');
    const roundEmoji=customEmoji('5260547274957672345','🎲');
    const candidateEmoji=customEmoji('5985525762973768278','👥');
    const winnerEmoji=customEmoji('4978994451964757181','🎖️');
    const secureEmoji=customEmoji('5224607267797606837','☄️');
    const waitEmoji=customEmoji('5399850755337240950','⏳');
    p=await bot.sendMessage(m.chat.id,rollTitle+'\n━━━━━━━━━━━━━━\n\n'+selectEmoji+' <b>𝐒𝐄𝐋𝐄𝐂𝐓𝐈𝐍𝐆 𝐖𝐈𝐍𝐍𝐄𝐑𝐒...</b>\n'+progress(0,barSize)+'\n\n'+roundEmoji+' Round <b>1</b>\n'+candidateEmoji+' Candidates: <b>Preparing...</b>\n'+winnerEmoji+' Winners: <b>'+n+'</b>\n'+secureEmoji+' Secure random selection\n'+waitEmoji+' Please wait...', {parse_mode:'HTML',reply_to_message_id:m.message_id});
    let lastEdit=0;
    const r=await pickWinners(g._id,n,{
      durationSeconds:cfg.rollDurationSeconds,
      onProgress:async state=>{
        const now=Date.now();
        if(now-lastEdit<850&&state.ratio<0.99)return;
        lastEdit=now;
        const filled=Math.round(state.ratio*barSize);
        const percent=Math.round(state.ratio*100);
        const text=rollTitle+'\n━━━━━━━━━━━━━━\n\n'+selectEmoji+' <b>𝐒𝐄𝐋𝐄𝐂𝐓𝐈𝐍𝐆 𝐖𝐈𝐍𝐍𝐄𝐑𝐒...</b>\n'+progress(filled,barSize)+'\n\n'+roundEmoji+' Round <b>1</b>\n'+candidateEmoji+' Candidates: <b>'+state.candidateCount+'</b>\n'+winnerEmoji+' Winners: <b>'+n+'</b>\n'+secureEmoji+' Secure random selection\n'+waitEmoji+' Please wait...';
        try{await bot.editMessageText(text,{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});}catch(e){if(!String(e.message||e).includes('message is not modified'))throw e;}
      }
    });
    const winnerIds=r.winners.map(w=>String(w.userId));
    const entries=await Entry.find({giveawayId:g._id,userId:{$in:winnerIds}}).select('userId commentText').lean();
    const comments=new Map(entries.map(e=>[String(e.userId),e.commentText||'']));
    const medalIds=['5440539497383087970','5447203607294265305','5453902265922376865'];
    const defaultMedal=['🥇','🥈','🥉'];
    const rankEmoji=(i)=>i<3?customEmoji(medalIds[i],defaultMedal[i]):customEmoji('5150415989841593609','🎖️');
    const lines=r.winners.map((w,i)=>rankEmoji(i)+' <b>#'+(i+1)+'</b>  '+winnerDisplay(w)+'\\n   '+customEmoji('5215334566549540768','💬')+' '+esc(comments.get(String(w.userId))||'—'));
    const header=customEmoji('5188344996356448758','🏆')+' <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • 𝐑𝐄𝐒𝐔𝐋𝐓</b>\\n━━━━━━━━━━━━━━━\\n\\n'+customEmoji('5461151367559141950','🎉')+' <b>𝐖𝐈𝐍𝐍𝐄𝐑𝐒 𝐒𝐄𝐋𝐄𝐂𝐓𝐄𝐃</b>\\n\\n';
    const stats=customEmoji('5444856076954520455','🧾')+' Post ID        <b>'+esc(g.channelPostId)+'</b>\\n👥 Total Entries  <b>'+r.entryCount+'</b>\\n'+customEmoji('4978994451964757181','🎖️')+' Winners        <b>'+r.winners.length+'</b>\\n'+customEmoji('5280816565657300091','🎲')+' Round          <b>'+r.winners[0].round+'</b>\\n\\n';
    const footer='━━━━━━━━━━━━━━━\\n'+customEmoji('5197288647275071607','🛡️')+' Secure Random Draw\\n'+customEmoji('6129931368148243023','⚡')+' CMT PICKER V2 PRO\\n'+customEmoji('4907231385309152742','🪪')+' @CommentsPickerBot';
    await bot.editMessageText(header+stats+lines.join('\\n\\n')+'\\n\\n'+footer,{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});
    await AuditEvent.create({action:'pick',actorId:String(m.from.id),giveawayId:g._id,meta:{count:n}});
  }catch(e){
    if(p){try{await bot.editMessageText('⚠️ <b>DRAW COULD NOT BE COMPLETED</b>\\n\\n'+esc(e.message)+'\\n\\n<i>No winner result was published.</i>',{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});}catch{}}
    else await bot.sendMessage(m.chat.id,'❌ Pick failed: '+esc(e.message),{parse_mode:'HTML'});
  }
}
 async function pickStar(m,arg){
  if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ Group admin/owner only.');
  const reply=m.reply_to_message;
  let g=null,n=null;
  if(reply){
   g=await findGiveaway(m);
   if(!g)return bot.sendMessage(m.chat.id,'No giveaway found. Reply to the giveaway post or provide its ID.');
   n=arg===undefined?Number(g.winnerCount||1):Number(arg);
  }else{
   const raw=String(arg||'');
   if(/^[0-9]+$/.test(raw)){
    const possibleCount=Number(raw);
    if(possibleCount>=1&&possibleCount<=cfg.pickCountMax)return bot.sendMessage(m.chat.id,'❌ Reply to the giveaway post when using a winner count. Example: /pickstarwinner 3');
   }
   g=await findGiveaway(m,raw);
   if(!g)return bot.sendMessage(m.chat.id,'No giveaway found. Reply to the giveaway post or provide its ID.');
   n=Number(g.winnerCount||1);
  }
  if(!Number.isInteger(n)||n<1)return bot.sendMessage(m.chat.id,'❌ Winner count must be a whole number greater than 0.');
  if(n>cfg.pickCountMax)return bot.sendMessage(m.chat.id,'❌ Maximum winners per pick is '+cfg.pickCountMax+'.');
  const star='⭐';let p;
  try{
   p=await bot.sendMessage(m.chat.id,star+' <b>CMT PICKER · PAID STAR</b>\\n\\n'+progress(0,10)+' <b>DRAWING…</b>\\n\\n⭐ Preparing active paid Star reactors…\\n🔐 Secure random selection\\n\n<i>Please wait…</i>',{parse_mode:'HTML',reply_to_message_id:m.message_id});
   let lastEdit=0;
   const r=await pickStarWinners(g._id,n,{durationSeconds:cfg.rollDurationSeconds,onProgress:async state=>{
    const now=Date.now();if(now-lastEdit<850&&state.ratio<0.99)return;lastEdit=now;
    const percent=Math.round(state.ratio*100),filled=Math.round(state.ratio*10);
    const text=star+' <b>CMT PICKER · PAID STAR</b>\\n\\n'+progress(filled,10)+' <b>DRAWING '+percent+'%</b>\\n\\n⭐ <b>'+state.candidateCount+'</b> active paid Star reactors\\n🔐 Secure random selection\\n\n<i>Please wait while the draw is in progress…</i>';
    try{await bot.editMessageText(text,{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});}catch(e){if(!String(e.message||e).includes('message is not modified'))throw e;}
   }});
   const lines=r.winners.map((w,i)=>customEmoji('5150415989841593609','🎖️')+' <b>#'+(i+1)+'</b>  '+winnerDisplay(w));
   const header=customEmoji('5188344996356448758','🏆')+' <b>𝐂𝐌𝐓 𝐏𝐈𝐂𝐊𝐄𝐑 • 𝐏𝐀𝐈𝐃 𝐒𝐓𝐀𝐑</b>\\n━━━━━━━━━━━━━━━\\n\\n'+customEmoji('5461151367559141950','🎉')+' <b>𝐖𝐈𝐍𝐍𝐄𝐑𝐒 𝐒𝐄𝐋𝐄𝐂𝐓𝐄𝐃</b>\\n\\n';
   const stats=customEmoji('5444856076954520455','🧾')+' Post ID        <b>'+esc(g.channelPostId)+'</b>\\n'+customEmoji('5280816565657300091','🎲')+' Round          <b>'+r.winners[0].round+'</b>\\n'+customEmoji('4978994451964757181','🎖️')+' Winners        <b>'+r.winners.length+'</b>\\n'+customEmoji('6129931368148243023','⚡')+' Active Stars   <b>'+r.candidateCount+'</b>\\n\\n';
   const footer='━━━━━━━━━━━━━━━\\n'+customEmoji('5197288647275071607','🛡️')+' Paid Star Random Draw\\n'+customEmoji('6129931368148243023','⚡')+' CMT PICKER V2 PRO\\n'+customEmoji('4907231385309152742','🪪')+' @CommentsPickerBot';
   await bot.editMessageText(header+stats+lines.join('\\n\\n')+'\\n\\n'+footer,{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});
   await AuditEvent.create({action:'pick_star_winners',actorId:String(m.from.id),giveawayId:g._id,meta:{count:n,paidReaction:true}});
  }catch(e){if(p){try{await bot.editMessageText('⚠️ <b>PAID STAR DRAW FAILED</b>\\n\\n'+esc(e.message)+'\\n\\n<i>No winner result was published.</i>',{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});}catch{}}else await bot.sendMessage(m.chat.id,'❌ Star pick failed: '+esc(e.message),{parse_mode:'HTML'});}
 }
 async function rerollCmd(m,arg){if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ Group admin/owner only.');const g=await findGiveaway(m,arg);if(!g)return bot.sendMessage(m.chat.id,'No giveaway found.');const raw=Number(arg||g.winnerCount||1);if(!Number.isInteger(raw)||raw<1)return bot.sendMessage(m.chat.id,'❌ Reroll count must be a whole number greater than 0.');if(raw>cfg.pickCountMax)return bot.sendMessage(m.chat.id,'❌ Maximum winners per reroll is '+cfg.pickCountMax+'.');const n=raw;try{const latestWinner=await Winner.findOne({giveawayId:g._id,status:'winner'}).sort({round:-1}).lean();const r=latestWinner?.selectionMode==='paid_star'?await rerollStarWinners(g._id,n):await reroll(g._id,n);const lines=r.winners.map((w,i)=>(i+1)+'. '+mention({id:w.userId,firstName:w.firstName,lastName:w.lastName,username:w.username}));await bot.sendMessage(m.chat.id,'🔄 <b>REROLL COMPLETE</b> · ROUND '+r.round+'\n\n'+lines.join('\n')+'\n\n🔐 <i>Previous winners are excluded from this draw.</i>',{parse_mode:'HTML',reply_to_message_id:m.message_id});await AuditEvent.create({action:'reroll',actorId:String(m.from.id),giveawayId:g._id,meta:{count:n,round:r.round}});}catch(e){await bot.sendMessage(m.chat.id,'⚠️ <b>REROLL FAILED</b>\n\n'+esc(e.message),{parse_mode:'HTML',reply_to_message_id:m.message_id});}}
 async function winnerList(m){const parts=(m.text||'').trim().split(/\s+/);const g=await findGiveaway(m,parts[1]);if(!g)return bot.sendMessage(m.chat.id,'No giveaway found.');const rows=await Winner.find({giveawayId:g._id,status:'winner'}).sort({round:-1,rank:1}).limit(20).lean();if(!rows.length)return bot.sendMessage(m.chat.id,'No active winners found.');return bot.sendMessage(m.chat.id,'🏆 <b>WINNER HISTORY</b>\n\n'+rows.map((w,i)=>(i+1)+'. '+mention({id:w.userId,firstName:w.firstName,lastName:w.lastName,username:w.username})+' — Round '+w.round).join('\n'),{parse_mode:'HTML'});}
 async function broadcast(m,text){if(!await owner(m.from.id))return bot.sendMessage(m.chat.id,'⛔ Owner only.');if(!text)return bot.sendMessage(m.chat.id,'Usage: /broadcast your message');const groups=await Group.find({approved:true}).select('id').lean();const job=await BroadcastJob.create({text,createdBy:String(m.from.id),targets:groups.map(g=>({chatId:g.id,status:'pending',attempts:0}))});await bot.sendMessage(m.chat.id,'📣 Broadcast queued\nJob: <code>'+job._id+'</code>\nTargets: '+groups.length,{parse_mode:'HTML'});runBroadcast(bot,job._id,cfg,logger).catch(e=>logger.error('broadcast',e));}
 async function callback(q){try{await bot.answerCallbackQuery(q.id);}catch{}}
 const shutdown=async()=>{logger.info('graceful shutdown');server.close();await mongoose.disconnect().catch(()=>{});process.exit(0);};process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);return {app,bot,server};
}
module.exports={start};