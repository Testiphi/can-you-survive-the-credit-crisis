import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../src/engine.ts';
import { loadDataset } from '../src/load-node.ts';
import { BEGINNER_PERIODS } from '../src/chapter.ts';
import { createInsurer, settleInsurance } from '../src/insurance.ts';
import { createAccount, markToMarket } from '../src/portfolio.ts';
const data=loadDataset();
const make=()=>new GameEngine(data,{config:{difficulty:0,identity:'insurer',startDate:'2008-09-02',endDate:'2008-10-31'}});
test('claims are recognized once; payment only exchanges cash, receivable and liability',()=>{
  const config={...make().config,initialCapital:1000};const a=createAccount(1000);const state=createInsurer(config);const prices=new Map<string,number>();
  settleInsurance(state,a,prices,config,'2008-09-03',0,true);
  const before=a.equity;
  const c=state.claims[0];
  const assessed=settleInsurance(state,a,prices,config,c.assessmentDate,1,false);
  assert.equal(c.grossAmount,200);assert.equal(c.recovery,75);
  assert.ok(Math.abs(a.equity-(before+assessed.premiumIncome-125))<1e-8);
  assert.equal(a.claimsPayable,200);assert.equal(a.reinsuranceReceivable,75);
  const recognizedEquity=a.equity;
  const paid=settleInsurance(state,a,prices,config,c.dueDate,1,false);
  assert.equal(paid.claimExpense,0);assert.equal(paid.claimsPaid,200);assert.equal(paid.recoveriesReceived,75);
  assert.equal(a.claimsPayable,0);assert.equal(a.reinsuranceReceivable,0);
  assert.ok(Math.abs(a.equity-recognizedEquity-paid.premiumIncome)<1e-8);
});
test('late and repeated coverage requests do not charge premiums',()=>{
  const config={...make().config,initialCapital:1000};const a=createAccount(1000);const state=createInsurer(config);const prices=new Map<string,number>();
  assert.equal(settleInsurance(state,a,prices,config,'2008-09-03',0,true).reinsurancePremium,50);
  assert.equal(settleInsurance(state,a,prices,config,'2008-09-04',0,true).reinsurancePremium,0);
  const late=createInsurer(config);
  assert.equal(settleInsurance(late,a,prices,config,'2008-09-15',0,true).reinsurancePremium,0);
  assert.equal(late.coverage,undefined);
});
test('positive NAV cannot pay a cash claim; unpaid amount remains a liability',()=>{
  const config={...make().config,initialCapital:1000};const a=createAccount(1000);const state=createInsurer(config);const prices=new Map([['SPX',10]]);
  a.cash=0;a.positions.set('SPX',{instrumentId:'SPX',quantity:100,avgPrice:10,openedAt:config.startDate,borrowFeeRate:0});markToMarket(a,prices);
  const c=state.claims[0];settleInsurance(state,a,prices,config,c.assessmentDate,1,false);
  const r=settleInsurance(state,a,prices,config,c.dueDate,1,false);
  assert.equal(state.defaulted,true);assert.ok(a.equity>0);assert.equal(a.claimsPayable,200);assert.equal(r.claimsPaid,0);
});
test('insurance commands and accounting replay across claims and payments in every period',()=>{
  for(const p of BEGINNER_PERIODS){
    const a=new GameEngine(data,{config:{difficulty:0,identity:'insurer',startDate:p.startDate,endDate:p.endDate}});
    a.requestReinsurance();const b=GameEngine.restore(data,JSON.parse(JSON.stringify(a.save())));
    while(!a.isOver)assert.deepEqual(b.advance(),a.advance());
    assert.deepEqual(a.state,b.state);assert.deepEqual(a.turnReports,b.turnReports);
    assert.equal(a.state.insurer!.defaulted,false);
    assert.ok(a.state.insurer!.claims.every(c=>c.status==='paid'));
    for(const r of a.turnReports)assert.ok(Math.abs(r.equityBefore+r.marketPnl-r.commission-r.borrowFees+(r.premiumIncome??0)-(r.claimExpense??0)-(r.reinsurancePremium??0)-r.equityAfter)<1e-4);
    assert.equal(a.turnReports.at(-1)!.premiumIncome,0,'expired contracts do not print perpetual premium income');
  }
});

test('cash strategies show a genuine coverage tradeoff across the three historical periods',()=>{
  let coverBetter=false,selfBetter=false;
  for(const p of BEGINNER_PERIODS){
    const ends=[false,true].map(covered=>{
      const e=new GameEngine(data,{config:{difficulty:0,identity:'insurer',seed:42,startDate:p.startDate,endDate:p.endDate}});
      if(covered)e.requestReinsurance();while(!e.isOver)e.advance();return e.state.player.equity;
    });
    coverBetter ||= ends[1]>ends[0];selfBetter ||= ends[0]>ends[1];
    if(p.id==='crisis')assert.ok(ends[1]>=1e10*p.capitalFloor,'conservative covered cash route can meet the crisis goal');
  }
  assert.ok(coverBetter && selfBetter);
});
