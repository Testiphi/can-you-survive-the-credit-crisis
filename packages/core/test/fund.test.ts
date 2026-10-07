import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../src/engine.ts';
import { loadDataset } from '../src/load-node.ts';
import { BEGINNER_PERIODS, reviewRun } from '../src/chapter.ts';
import { fundAvailableCash } from '../src/fund.ts';
import { nextTradingDay } from '../src/time.ts';
const data = loadDataset();
function fund(period: (typeof BEGINNER_PERIODS)[number] = BEGINNER_PERIODS[1]) {
  return new GameEngine(data, { config: { difficulty: 0, identity: 'hedge_fund', startDate: period.startDate, endDate: period.endDate } });
}
test('all periods support two cash redemptions without fake losses or drawdown', () => {
  for (const period of BEGINNER_PERIODS) {
    const e = fund(period);
    while (!e.isOver) e.advance();
    assert.equal(e.state.fund!.defaulted, false);
    assert.equal(e.state.fund!.payments.length, 2);
    assert.ok(e.state.fund!.payments.every(p => p.status === 'paid'));
    assert.equal(e.state.player.equity, e.config.initialCapital * 0.8);
    assert.equal(e.state.player.distributedCapital, e.config.initialCapital * 0.2);
    assert.equal(e.state.player.maxDrawdown, 0);
    assert.ok(e.turnReports.every(r => Math.abs(r.marketPnl) < 1e-6));
    assert.ok(reviewRun(e.config, e.state.player.equity, 0, false, e.turnReports).capitalPreserved);
  }
});
test('fully invested fund misses deadline with positive NAV; miss does not subtract money', () => {
  const e = fund();
  e.submitByNotional('SPX', e.state.player.cash);
  while (!e.isOver) e.advance();
  assert.equal(e.state.fund!.defaulted, true);
  assert.equal(e.state.player.bankrupt, false);
  assert.equal(e.state.fund!.payments[0].status, 'missed');
  assert.equal(reviewRun(e.config, e.state.player.equity, e.state.player.maxDrawdown, false, e.turnReports, e.state.fund).survived, false);
  assert.equal(e.state.player.distributedCapital ?? 0, 0);
  assert.equal(e.turnReports.at(-1)!.capitalOutflow, 0);
});
test('deadline reminder allows next-open liquidation before same-day redemption', () => {
  const e = fund();
  e.submitByNotional('SPX', e.state.player.cash);
  const due = e.state.fund!.payments[0].date;
  let reminder = false;
  while (nextTradingDay(e.state.date) !== due) {
    const r = e.advance();
    reminder ||= r.news.some(n => n.id.startsWith('fund-reminder'));
  }
  assert.equal(reminder, true);
  for (const p of e.state.player.positions.values()) e.submitOrder({ instrumentId: p.instrumentId, side: p.quantity > 0 ? 'sell' : 'buy', quantity: Math.abs(p.quantity), kind: 'market', submittedAt: e.state.date });
  e.advance();
  assert.equal(e.state.fund!.payments[0].status, 'paid');
  assert.equal(e.state.fund!.defaulted, false);
});
test('short proceeds are encumbered and fund save resumes across payouts exactly', () => {
  const a = fund();
  a.submitByNotional('SPX', -a.state.player.equity * 0.9);
  a.advance();
  assert.ok(a.state.player.cash > a.config.initialCapital);
  assert.ok(fundAvailableCash(a.state.player, a.state.prices) < a.config.initialCapital * 0.2);
  const b = GameEngine.restore(data, JSON.parse(JSON.stringify(a.save())));
  while (!a.isOver) assert.deepEqual(b.advance(), a.advance());
  assert.deepEqual(b.state, a.state);
  assert.deepEqual(b.turnReports, a.turnReports);
  for (const r of a.turnReports) {
    assert.ok(Math.abs(r.equityBefore + r.marketPnl - r.commission - r.borrowFees - (r.capitalOutflow ?? 0) - r.equityAfter) < 1e-6);
  }
});
