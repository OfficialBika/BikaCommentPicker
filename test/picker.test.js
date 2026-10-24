const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('crypto');
const {sampleUnique}=require('../src/services/picker');
const {commentContent,detectCommentType,isEarlierMessageId,rejectionReason}=require('../src/services/entry');
const {Entry,CommentMessage}=require('../src/models');
const {esc,mention,progress,paginate,normalizeMessageText,formatMessage}=require('../src/utils/format');

test('sampleUnique returns exactly N unique documents',()=>{const input=Array.from({length:1000},(_,i)=>({id:i}));const out=sampleUnique(input,100);assert.equal(out.length,100);assert.equal(new Set(out.map(x=>x.id)).size,100);assert.ok(out.every(x=>x&&Number.isInteger(x.id)));});
test('sampleUnique never returns more than input size',()=>assert.deepEqual(sampleUnique([1,2,3],10).sort((a,b)=>a-b),[1,2,3]));
test('sampleUnique does not mutate source array',()=>{const input=[1,2,3,4,5],copy=input.slice();sampleUnique(input,3);assert.deepEqual(input,copy);});
test('sampleUnique returns no values for zero or negative counts',()=>{assert.deepEqual(sampleUnique([1,2,3],0),[]);assert.deepEqual(sampleUnique([1,2,3],-1),[]);});
test('commentContent preserves text and captions',()=>{assert.deepEqual(commentContent({text:'hello'}),{text:'hello',type:'text'});assert.deepEqual(commentContent({photo:[{file_id:'x'}],caption:'caption'}),{text:'caption',type:'text'});});
test('commentContent detects sticker and media',()=>{assert.equal(detectCommentType({sticker:{file_id:'x'}}),'sticker');assert.deepEqual(commentContent({sticker:{file_id:'x'}}),{text:'Sticker',type:'sticker'});assert.deepEqual(commentContent({video:{file_id:'x'}}),{text:'Media',type:'video'});});
test('commentContent safely handles unknown messages',()=>assert.deepEqual(commentContent({}),{text:'Media',type:'text'}));
test('webhook secret comparison rejects mismatches and different lengths',()=>{const expected=Buffer.from('expected-random-secret');const valid=(provided)=>{const received=Buffer.from(provided);return received.length===expected.length&&crypto.timingSafeEqual(received,expected);};assert.equal(valid('expected-random-secret'),true);assert.equal(valid('wrong'),false);assert.equal(valid('expected-random-secreX'),false);});

test('the earliest Telegram message ID remains the first comment when webhook work races',()=>{
 assert.equal(isEarlierMessageId(41,42),true);
 assert.equal(isEarlierMessageId(42,41),false);
 assert.equal(isEarlierMessageId(41,41),false);
 assert.equal(isEarlierMessageId('invalid',42),false);
});
test('the first comment reserves the entry even when entry rules reject it',()=>{
 const giveaway={rules:{keyword:'join'}};
 const msg={from:{username:'sample'},text:'hello'};
 assert.equal(rejectionReason(giveaway,msg,commentContent(msg),null),'keyword');
 assert.equal(rejectionReason({rules:{requireUsername:true}},{from:{}},commentContent({text:'hello'}),null),'username');
 assert.equal(rejectionReason({rules:{}},{from:{}},commentContent({text:'hello'}),'admin'),'admin');
});

test('database schemas enforce one entry per user/giveaway and one mapping per chat message',()=>{
 const entryUnique=Entry.schema.indexes().some(([keys,options])=>options?.unique===true&&keys.giveawayId===1&&keys.userId===1);
 const commentMessageUnique=CommentMessage.schema.indexes().some(([keys,options])=>options?.unique===true&&keys.groupChatId===1&&keys.messageId===1);
 assert.equal(entryUnique,true);
 assert.equal(commentMessageUnique,true);
});

test('approval policy requires exact boolean approval and fails closed for missing chats',()=>{
 const isApproved=(group)=>group?.approved===true;
 assert.equal(isApproved({approved:true}),true);
 assert.equal(isApproved({approved:false}),false);
 assert.equal(isApproved({}),false);
 assert.equal(isApproved(null),false);
});
test('approval commands use numeric chat IDs only',()=>{
 const valid=id=>typeof id==='string'&&/^-?\d+$/.test(id.trim());
 assert.equal(valid('-1001234567890'),true);
 assert.equal(valid('123456'),true);
 assert.equal(valid('@publicgroup'),false);
 assert.equal(valid(''),false);
});

test('approval status is deny-by-default unless stored value is literal true',()=>{
 const approved=group=>group?.approved===true;
 assert.equal(approved({approved:true}),true);
 assert.equal(approved({approved:1}),false);
 assert.equal(approved({approved:'true'}),false);
 assert.equal(approved({approved:false}),false);
 assert.equal(approved(undefined),false);
});
test('approval target accepts Telegram numeric IDs and rejects names',()=>{
 const target=id=>typeof id==='string'&&/^-?\d+$/.test(id.trim());
 assert.equal(target('-1001234567890'),true);
 assert.equal(target('123456'),true);
 assert.equal(target('@somegroup'),false);
 assert.equal(target(''),false);
});

test('winner pagination returns all records without gaps or overlap',()=>{
 const input=Array.from({length:23},(_,i)=>({id:i+1}));
 const a=paginate(input,1,10),b=paginate(input,2,10),c=paginate(input,3,10);
 assert.equal(a.totalPages,3);assert.equal(a.items.length,10);assert.equal(b.items.length,10);assert.equal(c.items.length,3);
 assert.deepEqual([...a.items,...b.items,...c.items].map(x=>x.id),input.map(x=>x.id));
});
test('normalizes literal slash-n and CRLF without collapsing intended line breaks',()=>{
 assert.equal(normalizeMessageText('one\\n two\\r\\n three\\rfour'),'one\n two\n three\nfour');
 assert.equal(formatMessage(['one','','','two']),'one\n\ntwo');
});
test('custom emoji HTML markup remains intact in result templates',()=>{
 const template='<tg-emoji emoji-id="123456">🏆</tg-emoji> <b>WINNERS</b>';
 assert.match(template,/<tg-emoji emoji-id="123456">🏆<\/tg-emoji>/);
});
const {repairLegacyGroupIndexes}=require('../src/models');

test('legacy group index repair drops only the obsolete unique groupChatId index',async()=>{
 const calls=[];
 const legacy={name:'groupChatId_1',unique:true,key:{groupChatId:1}};
 const unrelated={name:'title_1',unique:true,key:{title:1}};
 const nonUnique={name:'groupChatId_1',unique:false,key:{groupChatId:1}};
 const originalCollection=require('mongoose').connection.collection;
 const originalCreateIndexes=require('../src/models').Group.createIndexes;
 require('mongoose').connection.collection=()=>({
  indexes:async()=>[legacy,unrelated,nonUnique],
  dropIndex:async name=>calls.push(['drop',name])
 });
 require('../src/models').Group.createIndexes=async()=>calls.push(['createIndexes']);
 try{
  await repairLegacyGroupIndexes({logger:{warn:(...args)=>calls.push(['warn',...args])}});
  assert.deepEqual(calls.filter(c=>c[0]==='drop'),[['drop','groupChatId_1']]);
  assert.equal(calls.some(c=>c[0]==='createIndexes'),true);
 }finally{
  require('mongoose').connection.collection=originalCollection;
  require('../src/models').Group.createIndexes=originalCreateIndexes;
 }
});
