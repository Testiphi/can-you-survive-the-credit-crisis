import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BEGINNER_RULES, limitBeginnerFill, settleBeginnerRisk } from '../src/beginner.ts';
import { createAccount, applyFill } from '../src/portfolio.ts';
import { GameEngine } from '../src/engine.ts';
import { loadDataset } from '../src/load-node.ts';
import type { Fill } from '../src/types.ts';

function fill(side: 'buy' | 'sell', quantity: number, price = 10): Fill {
  return { order: { instrumentId: 'SPX', side, quantity, kind: 'market', submittedAt: '2007-01-03' },
    filledAt: '2007-01-04', quantity, price, commission: quantity * price * 0.001, impact: 0, reason: 'ok' };
}
const prices = new Map([['SPX', 10]]);
test('D0 reserves commission and limits a gap-up purchase at its actual price', () => {
  const a = createAccount(100);
  const f = limitBeginnerFill(a, new Map([['SPX', 12]]), fill('buy', 10, 12));
  assert.equal(f.quantity, 8);
  applyFill(a, f, f.filledAt);
  assert.ok(a.cash >= 0);
});
test('D0 queued orders share funds; short proceeds cannot finance extra exposure', () => {
  const a = createAccount(100);
  const first = limitBeginnerFill(a, prices, fill('sell', 100));
  assert.equal(first.quantity, 9);
  applyFill(a, first, first.filledAt);
  assert.equal(limitBeginnerFill(a, prices, fill('sell', 100)).quantity, 0);
  const other: Fill = { ...fill('buy', 100), order: { ...fill('buy', 100).order, instrumentId: 'C' } };
  assert.equal(limitBeginnerFill(a, new Map([...prices, ['C', 10]]), other).quantity, 0);
});
test('D0 allows underwater short covering but does not open a new long position', () => {
  const a = createAccount(100);
  applyFill(a, fill('sell', 9), '2007-01-04');
  const f = limitBeginnerFill(a, new Map([['SPX', 30]]), fill('buy', 100, 30));
  assert.equal(f.quantity, 9);
});
test('D0 oversized orders are capped inside the engine, including repeated queued orders', () => {
  const e = new GameEngine(loadDataset(), { config: { difficulty: 0, identity: 'retail' } });
  for (let i = 0; i < 2; i++) e.submitOrder({ instrumentId: 'SPX', side: 'buy', quantity: 100000, kind: 'market', submittedAt: e.state.date });
  const r = e.advance();
  assert.ok(e.state.player.cash >= 0);
  assert.ok(r.fills[0].quantity > 0 && r.fills[0].quantity < 100000);
  assert.equal(r.fills[1].quantity, 0);
  assert.equal(r.fills[1].reason, 'insufficient_funds');
});


test('D0 normalizes institution identities before choosing starting capital', () => {
  for (const identity of ['retail', 'hedge_fund', 'bank', 'insurer'] as const) {
    const e = new GameEngine(loadDataset(), { config: { difficulty: 0, identity } });
    assert.equal(e.config.identity, 'retail');
    assert.equal(e.config.initialCapital, 100000);
    assert.equal(e.state.agents.length, 0);
  }
  const advanced = new GameEngine(loadDataset(), { config: { difficulty: 2, identity: 'bank' } });
  assert.equal(advanced.config.identity, 'bank');
  assert.equal(advanced.config.initialCapital, 1e9);
  assert.ok(advanced.state.agents.length > 0);
});

test('D0 retains historical crisis events without account regulations, rumors or repo', () => {
  const e = new GameEngine(loadDataset(), { config: { difficulty: 0, timeline: 'historical' } });
  while (!e.isOver) {
    e.advance();
    assert.equal(e.state.regulator.level, 0);
    assert.equal(e.state.regulator.rules.length, 0);
    assert.equal(e.state.player.repoUsed, 0);
  }
  assert.ok(e.state.firedEvents.includes('lehman_collapse'));
  assert.ok(e.state.firedEvents.includes('sec_short_ban'));
  assert.ok(e.state.news.every(n => n.source !== 'generated'));
});

test('D0 permits small stock shorts during the historical ban and charges fixed fees', () => {
  const e = new GameEngine(loadDataset(), { config: { difficulty: 0, timeline: 'historical' } });
  while (!e.state.firedEvents.includes('sec_short_ban') && !e.isOver) e.advance();
  assert.ok(!e.isOver);
  e.submitOrder({ instrumentId: 'C', side: 'sell', quantity: 1, kind: 'market', submittedAt: e.state.date });
  const before = e.state.player.cash;
  const r = e.advance();
  const f = r.fills[0];
  assert.equal(f.quantity, 1);
  const dailyFee = e.state.prices.get('C')! * BEGINNER_RULES.borrowFeeRate / 252;
  assert.ok(Math.abs(e.state.player.cash - (before + f.price - f.commission - dailyFee)) < 1e-6);
  for (let i = 0; i < 10; i++) {
    assert.equal(e.advance().fills.length, 0, 'no random recall of a tiny stock short');
    assert.equal(e.state.player.positions.get('C')!.borrowFeeRate, BEGINNER_RULES.borrowFeeRate);
  }
});

test('D0 risk boundary is strict and closes shorts only, recalculating equity and requirements', () => {
  const a = createAccount(100);
  applyFill(a, { ...fill('sell', 10), commission: 0 }, '2007-01-04');
  // 10 shares at 10: requirement 30, set cash so equity is exactly 30.
  a.cash = 130;
  a.equity = 30;
  assert.equal(settleBeginnerRisk(a, prices, '2007-01-05', 0.001).length, 0);
  a.cash = 129;
  a.equity = 29;
  const result = settleBeginnerRisk(a, prices, '2007-01-05', 0.001);
  assert.equal(result.length, 1);
  assert.equal(result[0].reason, 'risk_close');
  assert.equal(a.positions.size, 0);
  assert.ok(Math.abs(a.equity - 28.9) < 1e-8);
  assert.equal(a.maintenanceMargin, 0);
  assert.equal(a.marginCall, false);
  assert.equal(settleBeginnerRisk(a, prices, '2007-01-06', 0.001).length, 0);
});

test('D0 full-cash long is never margin called and short gap losses can still bankrupt', () => {
  const a = createAccount(100);
  applyFill(a, { ...fill('buy', 10), commission: 0 }, '2007-01-04');
  a.equity = 1;
  assert.equal(settleBeginnerRisk(a, new Map([['SPX', 0.1]]), '2007-01-05', 0.001).length, 0);
  const b = createAccount(100);
  applyFill(b, { ...fill('sell', 10), commission: 0 }, '2007-01-04');
  b.equity = -100;
  const r = settleBeginnerRisk(b, new Map([['SPX', 30]]), '2007-01-05', 0.001);
  assert.equal(r[0].quantity, 10);
  assert.ok(b.equity < 0);
  assert.equal(b.bankrupt, true);
});


test('D0 engine reports automatic cover in both fills and turn news', () => {
  const e = new GameEngine(loadDataset(), { config: { difficulty: 0 } });
  // Model an existing short facing an extreme adverse price move.
  applyFill(e.state.player, { ...fill('sell', 200, 1), commission: 0 }, e.state.date);
  const r = e.advance();
  assert.ok(r.fills.some(f => f.reason === 'risk_close'));
  assert.ok(r.news.some(n => n.id === `risk-close-${r.date}`));
  assert.equal(e.state.player.positions.size, 0);
  assert.equal(e.state.player.maintenanceMargin, 0);
  assert.equal(r.marginCall, false);
  assert.equal(r.bankrupt, true);
});
