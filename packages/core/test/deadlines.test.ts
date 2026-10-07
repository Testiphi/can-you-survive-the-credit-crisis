import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../src/engine.ts';
import { loadDataset } from '../src/load-node.ts';
import { nextFundingDecision } from '../src/deadlines.ts';
const data=loadDataset();
const make=(identity:'retail'|'hedge_fund'|'bank'|'insurer')=>new GameEngine(data,{config:{difficulty:0,identity,startDate:'2008-09-02',endDate:'2008-10-31'}});
test('retail has no fabricated obligations; fund shows its actual upcoming redemption',()=>{
  assert.equal(nextFundingDecision(make('retail').state),undefined);
  const e=make('hedge_fund');const d=nextFundingDecision(e.state)!;
  assert.equal(d.date,e.state.fund!.payments[0].date);assert.equal(d.amount,1e6);assert.equal(d.days,10);assert.equal(d.shortfall,0);
});
test('insurance timeline keeps unknown claims unknown and separates optional coverage',()=>{
  const e=make('insurer');assert.equal(nextFundingDecision(e.state)!.optional,true);
  while(e.state.date<e.state.insurer!.purchaseDeadline)e.advance();
  const unknown=nextFundingDecision(e.state)!;
  assert.equal(unknown.amount,undefined);assert.equal(unknown.shortfall,undefined);
  while(e.state.insurer!.claims[0].status==='scheduled')e.advance();
  const known=nextFundingDecision(e.state)!;const c=e.state.insurer!.claims[0];
  assert.equal(known.amount,(c.grossAmount??0)-(c.recovery??0));assert.equal(known.days,1);
});
test('same-day secured maturity and collateral deadline do not count principal twice',()=>{
  const e=make('bank');const l=e.state.player.loans![0];l.refinancing='secured';
  e.state.macro.systemicStress=1;e.state.bank!.collateralCallDue=l.dueDate;
  const d=nextFundingDecision(e.state)!;
  assert.equal(d.amount,l.principal+l.principal*l.annualRate/252*d.days);
  assert.equal(d.labels.length,2);
});
