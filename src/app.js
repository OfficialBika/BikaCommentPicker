const express=require('express');
const TelegramBot=require('node-telegram-bot-api');
const mongoose=require('mongoose');
const {loadConfig}=require('./config');
const {createLogger}=require('./utils/logger');
const {esc,mention,progress}=require('./utils/format');
const {User,Group,Giveaway,Entry,Winner,BroadcastJob,AuditEvent}=require('./models');
const {pickWinners,reroll}=require('./services/picker');
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
 if(cfg.publicUrl)await bot.setWebHook(cfg.publicUrl.replace(/\/$/,'')+path);
 const server=app.listen(cfg.port,()=>logger.info('HTTP server listening on '+cfg.port));
 async function saveUser(f){if(!f)return;await User.updateOne({id:String(f.id)},{$set:{username:f.username||'',firstName:f.first_name||'',lastName:f.last_name||'',lastSeenAt:new Date()}},{upsert:true}).catch(()=>{});}
 async function saveGroup(c){if(!c||!['group','supergroup'].includes(c.type))return;await Group.updateOne({id:String(c.id)},{$set:{title:c.title||'',type:c.type,username:c.username||'',lastSeenAt:new Date()}},{upsert:true}).catch(()=>{});}
 async function handleUpdate(u){if(u.callback_query)return callback(u.callback_query);const m=u.message||u.channel_post;if(u.message?.text?.startsWith('/')){if(m?.from)await saveUser(m.from);if(m?.chat)await saveGroup(m.chat);return command(u.message);}if(u.channel_post){if(m?.chat)await saveGroup(m.chat);return channelPost(u.channel_post);}if(m?.reply_to_message)return comment(m);}
 async function channelPost(p){const text=p.text||p.caption||'';if(!text.toLowerCase().includes(cfg.mentionTag.toLowerCase()))return;await Giveaway.findOneAndUpdate({channelId:String(p.chat.id),channelPostId:p.message_id},{$setOnInsert:{channelId:String(p.chat.id),channelPostId:p.message_id,title:text.slice(0,120),status:'active',winnerCount:1,durationSeconds:cfg.rollDurationSeconds,createdAt:new Date()}},{upsert:true,new:true});}
 async function findGiveaway(msg,explicitId){if(explicitId){const byId=await Giveaway.findById(explicitId).catch(()=>null);if(byId&&(!byId.discussionChatId||String(byId.discussionChatId)===String(msg.chat.id)))return byId;}const r=msg.reply_to_message;if(r){const postId=r.forward_from_message_id||r.message_id;const ch=String(r.forward_from_chat?.id||r.chat?.id||'');const g=await Giveaway.findOne({channelPostId:postId,$or:[{channelId:ch},{discussionChatId:String(msg.chat.id)}]}).sort({createdAt:-1});if(g)return g;}return null;}
 async function comment(m){if(!['group','supergroup'].includes(m.chat.type))return;const g=await findGiveaway(m);if(g?.status==='active'){if(!g.discussionChatId){g.discussionChatId=String(m.chat.id);await g.save();}await recordComment(g,m);}}
 async function owner(id){return cfg.ownerId&&String(id)===cfg.ownerId;}
 async function admin(m){if(await owner(m.from.id))return true;if(!['group','supergroup'].includes(m.chat.type))return false;try{const x=await bot.getChatMember(m.chat.id,m.from.id);return ['administrator','creator'].includes(x.status);}catch{return false;}}
 async function command(m){const parts=(m.text||'').trim().split(/\s+/);const cmd=(parts[0]||'').split('@')[0].toLowerCase();
  if(cmd==='/start')return bot.sendMessage(m.chat.id,'🎟️ <b>Cmt Picker V2 Pro</b>\n\nSecure giveaway picker with unique winners, reroll history and health monitoring.',{parse_mode:'HTML'});
  if(cmd==='/approve'){if(!await owner(m.from.id))return bot.sendMessage(m.chat.id,'⛔ Owner only.');await Group.updateOne({id:String(m.chat.id)},{$set:{approved:true}},{upsert:true});return bot.sendMessage(m.chat.id,'✅ Group approved for comment collection.');}
  if(cmd==='/admin'){if(!await owner(m.from.id))return bot.sendMessage(m.chat.id,'⛔ Owner only.');const [u,g,w,e]=await Promise.all([User.countDocuments(),Group.countDocuments(),Giveaway.countDocuments(),Entry.countDocuments()]);return bot.sendMessage(m.chat.id,'<b>V2 PRO DASHBOARD</b>\n\n👤 Users: <b>'+u+'</b>\n👥 Groups: <b>'+g+'</b>\n🎁 Giveaways: <b>'+w+'</b>\n💬 Entries: <b>'+e+'</b>\n\n/status - system health',{parse_mode:'HTML'});}
  if(cmd==='/status'){if(!await owner(m.from.id))return bot.sendMessage(m.chat.id,'⛔ Owner only.');return bot.sendMessage(m.chat.id,'🟢 <b>V2 Pro Online</b>\nUptime: '+Math.floor(process.uptime())+'s\nMongo: '+(mongoose.connection.readyState===1?'connected':'disconnected')+'\nNode: '+process.version,{parse_mode:'HTML'});}
  if(cmd==='/giveaway')return createGiveaway(m,parts[1],parts.slice(2).join(' '));
  if(cmd==='/pickwinner')return pick(m,parts[1]);
  if(cmd==='/reroll')return rerollCmd(m,parts[1]);
  if(cmd==='/winnerlist')return winnerList(m);
  if(cmd==='/broadcast')return broadcast(m,parts.slice(1).join(' '));
 }
 async function createGiveaway(m,countArg,keyword){if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ Group admin/owner only.');const r=m.reply_to_message;if(!r)return bot.sendMessage(m.chat.id,'Reply to the forwarded channel giveaway post. Usage: /giveaway 3 optional-keyword');const postId=r.forward_from_message_id||r.message_id;const channelId=String(r.forward_from_chat?.id||r.chat?.id||'');const rawCount=Number(countArg||1);if(!Number.isInteger(rawCount)||rawCount<1)return bot.sendMessage(m.chat.id,'❌ Winner count must be a whole number greater than 0.');if(rawCount>cfg.pickCountMax)return bot.sendMessage(m.chat.id,'❌ Maximum winners per giveaway is '+cfg.pickCountMax+'.');const count=rawCount;const g=await Giveaway.findOneAndUpdate({channelId,channelPostId:postId},{$set:{discussionChatId:String(m.chat.id),winnerCount:count,rules:{keyword:keyword||undefined,requireUsername:false,requireBotStart:false,excludeAdmins:true}},$setOnInsert:{title:(r.text||r.caption||'Giveaway').slice(0,120),status:'active',durationSeconds:cfg.rollDurationSeconds,createdBy:String(m.from.id),createdAt:new Date()}},{upsert:true,new:true});await bot.sendMessage(m.chat.id,'🎁 <b>GIVEAWAY CONFIGURED</b>\n\nID: <code>'+g._id+'</code>\nWinners: <b>'+count+'</b>\nKeyword: <b>'+esc(keyword||'None')+'</b>\n\nComments replying to this post are collected automatically.',{parse_mode:'HTML'});await AuditEvent.create({action:'create_giveaway',actorId:String(m.from.id),giveawayId:g._id,meta:{count,keyword:keyword||null}});}
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
    p=await bot.sendMessage(m.chat.id,rollEmoji+' <b>V2 PRO PICKER</b>\\n\\n'+progress(0,barSize)+' <b>ROLLING…</b>\\n\\n'+rollEmoji+' Selecting secure winners…',{parse_mode:'HTML'});
    let lastEdit=0;
    const r=await pickWinners(g._id,n,{
      durationSeconds:cfg.rollDurationSeconds,
      onProgress:async state=>{
        const now=Date.now();
        if(now-lastEdit<850&&state.ratio<0.99)return;
        lastEdit=now;
        const filled=Math.round(state.ratio*barSize);
        const percent=Math.round(state.ratio*100);
        const text=rollEmoji+' <b>V2 PRO PICKER</b>\\n\\n'+progress(filled,barSize)+' <b>ROLLING… '+percent+'%</b>\\n\\n'+rollEmoji+' <b>'+state.candidateCount+'</b> eligible candidates\\n\\nPlease wait…';
        try{await bot.editMessageText(text,{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});}catch(e){if(!String(e.message||e).includes('message is not modified'))throw e;}
      }
    });
    const lines=r.winners.map((w,i)=>(i+1)+'. '+mention({id:w.userId,firstName:w.firstName,lastName:w.lastName,username:w.username}));
    await bot.editMessageText('🏆 <b>WINNERS — ROUND '+r.winners[0].round+'</b>\\n\\n'+lines.join('\\n')+'\\n\\n🎟️ Eligible entries: '+r.entryCount+'\\n🔐 Unique candidates: '+r.candidateCount,{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});
    await AuditEvent.create({action:'pick',actorId:String(m.from.id),giveawayId:g._id,meta:{count:n}});
  }catch(e){
    if(p){try{await bot.editMessageText('❌ <b>PICK FAILED</b>\\n\\n'+esc(e.message),{chat_id:m.chat.id,message_id:p.message_id,parse_mode:'HTML'});}catch{}}
    else await bot.sendMessage(m.chat.id,'❌ Pick failed: '+esc(e.message),{parse_mode:'HTML'});
  }
}
 async function rerollCmd(m,arg){if(!await admin(m))return bot.sendMessage(m.chat.id,'⛔ Group admin/owner only.');const g=await findGiveaway(m,arg);if(!g)return bot.sendMessage(m.chat.id,'No giveaway found.');const raw=Number(arg||g.winnerCount||1);if(!Number.isInteger(raw)||raw<1)return bot.sendMessage(m.chat.id,'❌ Reroll count must be a whole number greater than 0.');if(raw>cfg.pickCountMax)return bot.sendMessage(m.chat.id,'❌ Maximum winners per reroll is '+cfg.pickCountMax+'.');const n=raw;try{const r=await reroll(g._id,n);const lines=r.winners.map((w,i)=>(i+1)+'. '+mention({id:w.userId,firstName:w.firstName,lastName:w.lastName,username:w.username}));await bot.sendMessage(m.chat.id,'🔄 <b>REROLL — ROUND '+r.round+'</b>\n\n'+lines.join('\n')+'\n\nPrevious winners are excluded.',{parse_mode:'HTML'});await AuditEvent.create({action:'reroll',actorId:String(m.from.id),giveawayId:g._id,meta:{count:n,round:r.round}});}catch(e){await bot.sendMessage(m.chat.id,'❌ Reroll failed: '+esc(e.message),{parse_mode:'HTML'});}}
 async function winnerList(m){const parts=(m.text||'').trim().split(/\s+/);const g=await findGiveaway(m,parts[1]);if(!g)return bot.sendMessage(m.chat.id,'No giveaway found.');const rows=await Winner.find({giveawayId:g._id,status:'winner'}).sort({round:-1,rank:1}).limit(20).lean();if(!rows.length)return bot.sendMessage(m.chat.id,'No active winners found.');return bot.sendMessage(m.chat.id,'🏆 <b>WINNER HISTORY</b>\n\n'+rows.map((w,i)=>(i+1)+'. '+mention({id:w.userId,firstName:w.firstName,lastName:w.lastName,username:w.username})+' — Round '+w.round).join('\n'),{parse_mode:'HTML'});}
 async function broadcast(m,text){if(!await owner(m.from.id))return bot.sendMessage(m.chat.id,'⛔ Owner only.');if(!text)return bot.sendMessage(m.chat.id,'Usage: /broadcast your message');const groups=await Group.find({approved:true}).select('id').lean();const job=await BroadcastJob.create({text,createdBy:String(m.from.id),targets:groups.map(g=>({chatId:g.id,status:'pending',attempts:0}))});await bot.sendMessage(m.chat.id,'📣 Broadcast queued\nJob: <code>'+job._id+'</code>\nTargets: '+groups.length,{parse_mode:'HTML'});runBroadcast(bot,job._id,cfg,logger).catch(e=>logger.error('broadcast',e));}
 async function callback(q){try{await bot.answerCallbackQuery(q.id);}catch{}}
 const shutdown=async()=>{logger.info('graceful shutdown');server.close();await mongoose.disconnect().catch(()=>{});process.exit(0);};process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);return {app,bot,server};
}
module.exports={start};