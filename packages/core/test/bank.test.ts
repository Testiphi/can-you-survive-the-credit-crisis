import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../src/engine.ts';
import { loadDataset } from '../src/load-node.ts';
import { BEGINNER_PERIODS } from '../src/chapter.ts';
import { loanLiabilities, createAccount } from '../src/portfolio.ts';
import { initializeBank, settleBank } from '../src/bank.ts';
const data = loadDataset();
const make = (period: (typeof BEGINNER_PERIODS)[number] = BEGINNER_PERIODS[1]) => new GameEngine(data, { config: { difficulty: 0, identity: 'bank', startDate: period.startDate, endDate: period.endDate } });
test('bank opening loan funds assets without creating equity', () => {
  const e = make();
  const a = e.state.player;
  const assets = a.cash + [...a.positions.values()].reduce((n, p) => n + p.quantity * e.state.prices.get(p.instrumentId)!, 0);
  assert.ok(Math.abs(assets - e.config.initialCapital * 2) < 1e-5);
  assert.ok(Math.abs(a.equity - e.config.initialCapital) < 1e-5);
  assert.equal(loanLiabilities(a), e.config.initialCapital);
});
test('bank misses debt maturity with positive equity if no cash is prepared', () => {
  const e = make();
  while (!e.isOver) e.advance();
  assert.equal(e.state.bank!.defaulted, true);
  assert.equal(e.state.player.bankrupt, false);
  assert.equal(e.state.date, e.state.player.loans![0].dueDate);
  assert.equal(e.turnReports.at(-1)!.principalRepaid, 0);
});
test('selling inherited assets enables repayment in every chapter; debt is not charged twice', () => {
  for (const period of BEGINNER_PERIODS) {
    const e = make(period);
    for (const p of e.state.player.positions.values()) e.submitOrder({ instrumentId: p.instrumentId, side: 'sell', quantity: p.quantity, kind: 'market', submittedAt: e.state.date });
    while (!e.isOver) e.advance();
    assert.equal(e.state.bank!.defaulted, false);
    assert.equal(loanLiabilities(e.state.player), 0);
    assert.ok(e.state.player.loans!.every(l => l.status === 'repaid'));
    for (const r of e.turnReports) assert.ok(Math.abs(r.equityBefore + r.marketPnl - r.commission - r.borrowFees - (r.loanInterest ?? 0) - r.equityAfter) < 1e-5);
  }
});
test('early repayment decreases future interest and cash and debt equally', () => {
  const prices = new Map([['SPX', 100], ['C', 100]]);
  const config = make().config;
  const a = createAccount(config.initialCapital);
  initializeBank(a, prices, config);
  const b = structuredClone(a);
  const before = a.equity;
  const first = settleBank(a, prices, '2008-09-03', true);
  settleBank(b, prices, '2008-09-03', false);
  assert.ok(first.principalRepaid > 0);
  assert.ok(Math.abs(a.equity - (before - first.loanInterest)) < 1e-5);
  assert.ok(settleBank(a, prices, '2008-09-04', false).loanInterest < settleBank(b, prices, '2008-09-04', false).loanInterest);
});
test('pending and historical early-repayment commands replay identically', () => {
  const a = make();
  a.requestBankRepayment();
  const b = GameEngine.restore(data, JSON.parse(JSON.stringify(a.save())));
  assert.deepEqual(b.advance(), a.advance());
  const c = GameEngine.restore(data, JSON.parse(JSON.stringify(a.save())));
  while (!a.isOver) assert.deepEqual(c.advance(), a.advance());
  assert.deepEqual(c.state, a.state);
  assert.deepEqual(c.turnReports, a.turnReports);
});

test('borrowed cash does not become equity in the trading limit', async () => {
  const { limitBeginnerFill } = await import('../src/beginner.ts');
  const a = createAccount(100);
  a.cash = 2000;
  a.loans = [{ id: 'loan', principal: 1900, accruedInterest: 0, annualRate: 0.05, dueDate: '2008-10-01', status: 'active' }];
  const f = limitBeginnerFill(a, new Map([['SPX', 1]]), { order: { instrumentId: 'SPX', side: 'buy', quantity: 2000, kind: 'market', submittedAt: '2008-09-02' }, quantity: 2000, price: 1, impact: 0, commission: 0, filledAt: '2008-09-03', reason: 'ok' }, 2);
  assert.equal(f.quantity, 200);
});
