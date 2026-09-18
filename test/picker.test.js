const test=require('node:test');
const assert=require('node:assert/strict');
const {sampleUnique}=require('../src/services/picker');

test('sampleUnique returns exactly N unique documents',()=>{
 const input=Array.from({length:1000},(_,i)=>({id:i}));
 const out=sampleUnique(input,100);
 assert.equal(out.length,100);
 assert.equal(new Set(out.map(x=>x.id)).size,100);
 assert.ok(out.every(x=>x&&Number.isInteger(x.id)));
});

test('sampleUnique never returns more than the input size',()=>{
 const input=[1,2,3];
 assert.deepEqual(sampleUnique(input,10).sort((a,b)=>a-b),[1,2,3]);
});

test('sampleUnique does not mutate the source array',()=>{
 const input=[1,2,3,4,5];
 const copy=input.slice();
 sampleUnique(input,3);
 assert.deepEqual(input,copy);
});
