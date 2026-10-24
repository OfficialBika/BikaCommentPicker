const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('crypto');
const {sampleUnique}=require('../src/services/picker');
const {commentContent,detectCommentType}=require('../src/services/entry');

test('sampleUnique returns exactly N unique documents',()=>{const input=Array.from({length:1000},(_,i)=>({id:i}));const out=sampleUnique(input,100);assert.equal(out.length,100);assert.equal(new Set(out.map(x=>x.id)).size,100);assert.ok(out.every(x=>x&&Number.isInteger(x.id)));});
test('sampleUnique never returns more than input size',()=>assert.deepEqual(sampleUnique([1,2,3],10).sort((a,b)=>a-b),[1,2,3]));
test('sampleUnique does not mutate source array',()=>{const input=[1,2,3,4,5],copy=input.slice();sampleUnique(input,3);assert.deepEqual(input,copy);});
test('sampleUnique returns no values for zero or negative counts',()=>{assert.deepEqual(sampleUnique([1,2,3],0),[]);assert.deepEqual(sampleUnique([1,2,3],-1),[]);});
test('commentContent preserves text and captions',()=>{assert.deepEqual(commentContent({text:'hello'}),{text:'hello',type:'text'});assert.deepEqual(commentContent({photo:[{file_id:'x'}],caption:'caption'}),{text:'caption',type:'text'});});
test('commentContent detects sticker and media',()=>{assert.equal(detectCommentType({sticker:{file_id:'x'}}),'sticker');assert.deepEqual(commentContent({sticker:{file_id:'x'}}),{text:'Sticker',type:'sticker'});assert.deepEqual(commentContent({video:{file_id:'x'}}),{text:'Media',type:'video'});});
test('commentContent safely handles unknown messages',()=>assert.deepEqual(commentContent({}),{text:'Media',type:'text'}));
test('webhook secret comparison rejects mismatches and different lengths',()=>{const expected=Buffer.from('expected-random-secret');const valid=(provided)=>{const received=Buffer.from(provided);return received.length===expected.length&&crypto.timingSafeEqual(received,expected);};assert.equal(valid('expected-random-secret'),true);assert.equal(valid('wrong'),false);assert.equal(valid('expected-random-secreX'),false);});
