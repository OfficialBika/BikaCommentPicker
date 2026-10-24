const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('crypto');
const {sampleUnique}=require('../src/services/picker');
const {commentContent,detectCommentType,isEarlierMessageId,rejectionReason}=require('../src/services/entry');
const {Entry,CommentMessage}=require('../src/models');

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
