import {test} from 'node:test';import assert from 'node:assert/strict';import {createContextBudget} from './context-budget';
test('context injection is bounded across bursts and recovers without reconnecting',()=>{
 let time=0;const budget=createContextBudget(6000,60000,()=>time);
 assert.equal(budget.take(4000),true);assert.equal(budget.take(2500),false);assert.equal(budget.take(2000),true);
 time=59999;assert.equal(budget.take(1),false);time=60000;assert.equal(budget.take(4000),true);
 assert.equal(budget.take(Infinity),false);budget.clear();assert.equal(budget.take(6000),true);
});
