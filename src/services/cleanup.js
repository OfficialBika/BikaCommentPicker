const {Giveaway,Entry,PaidReaction,AuditEvent}=require('../models');

function cutoffFromDays(days){
  const n=Math.max(1,Number(days)||90);
  return new Date(Date.now()-n*24*60*60*1000);
}

async function cleanupTemporaryGiveawayData({retentionDays=90,logger}={}){
  const cutoff=cutoffFromDays(retentionDays);
  const completed=await Giveaway.find({
    status:'completed',
    pickedAt:{$ne:null,$lte:cutoff}
  }).select('_id').lean();

  const cancelledOrExpired=await Giveaway.find({
    status:{$in:['cancelled','expired']},
    updatedAt:{$lte:cutoff}
  }).select('_id').lean();

  const ids=[...completed,...cancelledOrExpired].map(x=>x._id);
  if(!ids.length)return {giveaways:0,entries:0,paidReactions:0};

  const [entries,paidReactions]=await Promise.all([
    Entry.deleteMany({giveawayId:{$in:ids}}),
    PaidReaction.deleteMany({giveawayId:{$in:ids}})
  ]);

  const result={
    giveaways:ids.length,
    entries:entries.deletedCount||0,
    paidReactions:paidReactions.deletedCount||0
  };

  if(logger)logger.info('Temporary giveaway data cleanup completed',{
    retentionDays:Number(retentionDays)||90,
    cutoff:cutoff.toISOString(),
    ...result
  });

  await Promise.all(ids.map(giveawayId=>AuditEvent.create({
    action:'temporary_data_cleanup',
    actorId:'system',
    giveawayId,
    meta:{
      retentionDays:Number(retentionDays)||90,
      entriesDeleted:result.entries,
      paidReactionsDeleted:result.paidReactions
    }
  }).catch(()=>{})));

  return result;
}

module.exports={cleanupTemporaryGiveawayData};