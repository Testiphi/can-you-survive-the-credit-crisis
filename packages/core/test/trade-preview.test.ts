import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../src/engine.ts';
import { loadDataset } from '../src/load-node.ts';
import { previewBeginnerTrade } from '../src/trade-preview.ts';
import { applyFill, markToMarket } from '../src/portfolio.ts';
const data=loadDataset();
function make(){
 const e=new GameEngine(data,{config:{difficulty:0,startDate:'2008-09-02',endDate:'2008-10-31',initialCapital:10000}});
 e.state.prices.set('SPX',100);return e;
}
function position(e:GameEngine,quantity:number){
 applyFill(e.state.player,{order:{instrumentId:'SPX',side:quantity>0?'buy':'sell',quantity:Math.abs(quantity),kind:'market',submittedAt:e.state.date},filledAt:e.state.date,price:100,quantity:Math.abs(quantity),commission:0,impact:0,reason:'ok'},e.state.date);
 markToMarket(e.state.player,e.state.prices);
}
test('preview distinguishes reduction, flattening and reversal without mutating state',()=>{
 const e=make();position(e,25);const before=structuredClone(e.state);
 const reduced=previewBeginnerTrade(e.state,'SPX','sell',0.1);
 assert.equal(reduced.label,'减仓卖出');assert.equal(reduced.closing,10);assert.equal(reduced.opening,0);assert.equal(reduced.afterQty,15);
 const flat=previewBeginnerTrade(e.state,'SPX','sell',0.25);assert.equal(flat.label,'平掉多头');assert.equal(flat.afterQty,0);
 const reversed=previewBeginnerTrade(e.state,'SPX','sell',0.5);assert.equal(reversed.label,'卖出并做空');assert.equal(reversed.closing,25);assert.equal(reversed.opening,25);assert.equal(reversed.afterQty,-25);
 assert.deepEqual(e.state,before);
});
test('buying against a short shows cover and newly opened long separately',()=>{
 const e=make();position(e,-20);
 const p=previewBeginnerTrade(e.state,'SPX','buy',0.25);
 assert.equal(p.label,'回补并买入');assert.equal(p.closing,20);assert.equal(p.opening,10);assert.equal(p.afterQty,10);
});
test('preview respects commission and account limits but keeps original requested quantity',()=>{
 const e=make();const p=previewBeginnerTrade(e.state,'SPX','buy',1);
 assert.equal(p.order!.quantity,100);assert.equal(p.fill!.quantity,99);assert.ok(p.cashAfter>=0);
 e.state.player.cash=0.5;const small=previewBeginnerTrade(e.state,'SPX','buy',1);assert.equal(small.order,null);
});
test('repeated previews neither consume random state nor read future bars',()=>{
 const a=new GameEngine(data,{config:{difficulty:0}}),b=new GameEngine(data,{config:{difficulty:0}});
 const first=previewBeginnerTrade(a.state,'SPX','sell',0.5);
 const bars=a.state.bars.get('SPX')!;bars.push({...bars[0],date:'2099-01-01',adv20:1,close:99999});
 assert.deepEqual(previewBeginnerTrade(a.state,'SPX','sell',0.5),first);bars.pop();
 for(let i=0;i<10;i++)previewBeginnerTrade(a.state,'SPX','sell',0.5);
 a.submitOrder(first.order!);b.submitOrder(first.order!);assert.deepEqual(a.advance(),b.advance());assert.deepEqual(a.state,b.state);
});
test('preview makes funding consequences visible without assuming future income',()=>{
 const e=new GameEngine(data,{config:{difficulty:0,identity:'hedge_fund',startDate:'2008-09-02',endDate:'2008-10-31'}});
 const p=previewBeginnerTrade(e.state,'SPX','buy',1);
 assert.ok((p.paymentGapAfter??0)>0);assert.ok(p.fill!.quantity>0);
});
