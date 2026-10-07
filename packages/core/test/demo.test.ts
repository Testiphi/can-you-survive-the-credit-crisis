import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../src/engine.ts';
import { loadDataset } from '../src/load-node.ts';
import { DEMO_CHAPTERS, reviewRun } from '../src/chapter.ts';
const data=loadDataset();
const roles=['retail','hedge_fund','bank','insurer'] as const;
test('demo covers five chronological chapters and all 20 chapter-role combinations can finish',()=>{
 assert.equal(DEMO_CHAPTERS.length,5);
 for(const chapter of DEMO_CHAPTERS) for(const identity of roles){
  const e=new GameEngine(data,{config:{difficulty:0,identity,demoVersion:1,marketRevision:1,startDate:chapter.startDate,endDate:chapter.endDate}});
  if(identity==='insurer')e.requestReinsurance();
  if(identity==='bank')for(const p of e.state.player.positions.values())e.submitOrder({instrumentId:p.instrumentId,side:'sell',quantity:p.quantity,kind:'market',submittedAt:e.state.date});
  for(let i=0;i<5;i++)e.advance();
  const restored=GameEngine.restore(data,JSON.parse(JSON.stringify(e.save())));
  while(!e.isOver)assert.deepEqual(restored.advance(),e.advance());
  assert.deepEqual(restored.state,e.state);
  assert.equal(e.state.date,chapter.endDate,`${chapter.id}/${identity} should reach chapter end`);
  const a=e.state.player;
  const review=reviewRun(e.config,a.equity,a.maxDrawdown,a.bankrupt,e.turnReports,e.state.bank??e.state.fund??e.state.insurer);
  assert.ok(review.survived && review.capitalPreserved,`${chapter.id}/${identity} conservative route must meet its capital goal`);
  for(const r of e.turnReports){
   const expected=r.equityBefore+r.marketPnl-r.commission-r.borrowFees-(r.capitalOutflow??0)-(r.loanInterest??0)-(r.financingFees??0)+(r.premiumIncome??0)-(r.claimExpense??0)-(r.reinsurancePremium??0);
   assert.ok(Math.abs(expected-r.equityAfter)<0.001);
  }
 }
});
test('opening history is available immediately, contains no future news and is not fired again',()=>{
 const e=new GameEngine(data,{config:{difficulty:0,demoVersion:1,startDate:'2008-02-01',endDate:'2008-03-31'}});
 assert.ok(e.state.firedEvents.includes('taf_announced'));
 assert.ok(e.state.firedEvents.includes('monoline_crisis'));
 assert.ok(e.state.news.some(n=>n.eventId==='monoline_crisis' && n.date==='2008-02-01'));
 assert.ok(e.state.news.every(n=>n.date<=e.state.date));
 assert.ok(!e.advance().firedEventIds.includes('monoline_crisis'));
});
test('demo revision corrects the TARP date without mutating legacy data or invalidating legacy saves',()=>{
 const original=JSON.stringify(data);
 const old=new GameEngine(data,{config:{difficulty:0,startDate:'2009-05-01',endDate:'2009-06-30'}});
 const legacy=JSON.parse(JSON.stringify(old.save()));
 const e=new GameEngine(data,{config:{difficulty:0,demoVersion:1,startDate:'2009-05-01',endDate:'2009-06-30'}});
 assert.equal(e.dataset.events.find(c=>c.id==='goldman_tarp_repayment')!.date,'2009-06-17');
 while(e.state.date<'2009-06-16')e.advance();
 assert.ok(!e.state.firedEvents.includes('goldman_tarp_repayment'));
 assert.ok(e.advance().firedEventIds.includes('goldman_tarp_repayment'));
 assert.equal(JSON.stringify(data),original);
 assert.deepEqual(GameEngine.restore(data,legacy).state,old.state);
 assert.throws(()=>GameEngine.restore(data,{...e.save(),config:{...e.config,demoVersion:99}}),/版本/);
});
