import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccount, markToMarket, loanLiabilities } from '../src/portfolio.ts';
import { collateralState, executeRefinance, refinanceQuote } from '../src/refinance.ts';
import { settleBank } from '../src/bank.ts';
import { GameEngine } from '../src/engine.ts';
import { loadDataset } from '../src/load-node.ts';
import type { BankState } from '../src/types.ts';
const prices = new Map([['SPX', 10]]);
function account() {
  const a = createAccount(1000);
  a.cash = 600;
  a.positions.set('SPX', { instrumentId:'SPX', quantity:100, avgPrice:10, openedAt:'2008-09-02', borrowFeeRate:0 });
  a.loans = [{id:'loan-1', principal:600, accruedInterest:5, annualRate:0.05, dueDate:'2008-09-23', status:'active'}];
  markToMarket(a, prices);
  return a;
}
test('secured refinance clears accrued interest, charges fee once, and preserves equity except fee', () => {
  const a=account(); const before=a.equity;
  const r=executeRefinance(a,prices,0,'2008-09-22','2008-10-31',{loanId:'loan-1',plan:'secured'});
  assert.ok(r.ok); if(!r.ok)return;
  markToMarket(a,prices);
  assert.ok(Math.abs(a.equity-(before-r.quote.fee))<1e-8);
  assert.equal(a.loans![0].accruedInterest,0);
  assert.equal(a.loans![0].refinancing,'secured');
  assert.equal(loanLiabilities(a),600);
});
test('collateral capacity is shared across loans and cannot be pledged twice', () => {
  const a=account();
  assert.ok(executeRefinance(a,prices,0,'2008-09-22','2008-10-31',{loanId:'loan-1',plan:'secured'}).ok);
  a.loans!.push({id:'loan-2',principal:500,accruedInterest:0,annualRate:0.05,dueDate:'2008-09-23',status:'active'});
  const q=refinanceQuote(a,prices,0,'2008-09-22','2008-10-31',a.loans![1],'secured');
  assert.equal(q.newPrincipal,200);
  assert.equal(q.principalRepaid,300);
  assert.ok(executeRefinance(a,prices,0,'2008-09-22','2008-10-31',{loanId:'loan-2',plan:'secured'}).ok);
  assert.equal(collateralState(a,prices,0).used,800);
});
test('rejected refinancing leaves cash and original contract untouched; no repeat or end-date escape', () => {
  const a=account();a.cash=0;
  const snapshot=structuredClone(a);
  assert.equal(executeRefinance(a,prices,0,'2008-09-22','2008-10-31',{loanId:'loan-1',plan:'secured'}).ok,false);
  assert.deepEqual(a,snapshot);
  a.cash=600;
  assert.ok(executeRefinance(a,prices,0,'2008-09-22','2008-10-31',{loanId:'loan-1',plan:'term'}).ok);
  assert.equal(executeRefinance(a,prices,0,'2008-10-15','2008-10-31',{loanId:'loan-1',plan:'term'}).ok,false);
  const b=account();b.loans![0].dueDate='2008-10-31';
  assert.match(refinanceQuote(b,prices,0,'2008-10-30','2008-10-31',b.loans![0],'term').reason!,/剩余时期/);
});
test('collateral shortfall warns first, defaults next day; sufficient cash repays principal without loss', () => {
  const a=account();
  a.loans![0].refinancing='secured';a.loans![0].dueDate='2008-10-20';a.cash=0;
  const bank:BankState={defaulted:false};
  const first=settleBank(a,prices,'2008-09-24',false,{bank,stress:1,endDate:'2008-10-31'});
  assert.equal(first.defaulted,false);
  assert.equal(bank.collateralCallDue,'2008-09-25');
  const cured=structuredClone(a);const curedBank=structuredClone(bank);
  assert.equal(settleBank(a,prices,'2008-09-25',false,{bank,stress:1,endDate:'2008-10-31'}).defaulted,true);
  cured.cash=400;markToMarket(cured,prices);const before=cured.equity;
  const paid=settleBank(cured,prices,'2008-09-25',false,{bank:curedBank,stress:1,endDate:'2008-10-31'});
  assert.equal(paid.defaulted,false);assert.ok(Math.abs(paid.principalRepaid-300)<1e-8);
  assert.equal(curedBank.collateralCallDue,undefined);
  assert.ok(Math.abs(cured.equity-(before-paid.loanInterest))<1e-8);
});

test('pending and accepted refinancing replay identically and daily reports reconcile', () => {
  const data=loadDataset();
  const a=new GameEngine(data,{config:{difficulty:0,identity:'bank',startDate:'2008-09-02',endDate:'2008-10-31'}});
  while(a.state.date<'2008-09-18')a.advance();
  a.requestBankRefinance({loanId:'loan-1',plan:'secured'});
  assert.throws(()=>a.requestBankRepayment(),/同一回合/);
  const b=GameEngine.restore(data,JSON.parse(JSON.stringify(a.save())));
  assert.deepEqual(b.advance(),a.advance());
  assert.equal(a.state.player.loans![0].refinancing,'secured');
  assert.ok((a.turnReports.at(-1)!.financingFees??0)>0);
  const c=GameEngine.restore(data,JSON.parse(JSON.stringify(a.save())));
  while(!a.isOver)assert.deepEqual(c.advance(),a.advance());
  assert.deepEqual(c.state,a.state);
  for(const r of a.turnReports)assert.ok(Math.abs(r.equityBefore+r.marketPnl-r.commission-r.borrowFees-(r.loanInterest??0)-(r.financingFees??0)-r.equityAfter)<1e-5);
});

test('refinancing on maturity is processed before default and uses the old rate for that day', () => {
  const a=account();const b=structuredClone(a);
  const plain=settleBank(b,prices,'2008-09-23',false);
  assert.equal(plain.defaulted,true);
  const state:BankState={defaulted:false};
  const rolled=settleBank(a,prices,'2008-09-23',false,{bank:state,stress:0,endDate:'2008-10-31',request:{loanId:'loan-1',plan:'secured'}});
  assert.equal(rolled.defaulted,false);
  assert.equal(rolled.loanInterest,600*0.05/252);
  assert.ok(a.loans![0].dueDate>'2008-09-23');
  const next=settleBank(a,prices,'2008-09-24',false,{bank:state,stress:0,endDate:'2008-10-31'});
  assert.equal(next.loanInterest,600*0.06/252);
});

test('early repayments follow revised maturity order after refinancing', () => {
  const a=account();a.loans![0].dueDate='2008-10-15';a.loans![0].refinancing='term';
  a.loans!.push({id:'loan-2',principal:100,accruedInterest:0,annualRate:0.05,dueDate:'2008-10-14',status:'active'});
  a.cash=60;
  settleBank(a,prices,'2008-09-24',true);
  assert.equal(a.loans![0].principal,600);
  assert.ok(a.loans![1].principal<100);
});
