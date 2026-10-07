import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../src/engine.ts';
import { loadDataset } from '../src/load-node.ts';
import { BEGINNER_CHAPTER, reviewRun } from '../src/chapter.ts';
const data = loadDataset();
function chapter() { return new GameEngine(data, { config: { difficulty: 0, startDate: BEGINNER_CHAPTER.startDate, endDate: BEGINNER_CHAPTER.endDate } }); }
test('chapter is a bounded historical run and holding cash completes the capital goal', () => {
  const e = chapter();
  while (!e.isOver) e.advance();
  assert.ok(e.state.turnIndex > 30 && e.state.turnIndex < 50);
  const r = reviewRun(e.config, e.state.player.equity, e.state.player.maxDrawdown, e.state.player.bankrupt, e.turnReports);
  assert.equal(r.capitalPreserved, true);
  assert.equal(r.drawdownControlled, true);
  assert.equal(r.riskCloses, 0);
  assert.ok(e.state.firedEvents.includes('lehman_collapse'));
});
test('daily and total statements reconcile, and survive save/replay', () => {
  const e = chapter();
  e.submitByNotional('C', -25000);
  for (let i = 0; i < 10; i++) e.advance();
  e.submitByNotional('SPX', 25000);
  while (!e.isOver) e.advance();
  for (const r of e.turnReports) {
    assert.ok(Math.abs(r.equityBefore + r.marketPnl - r.commission - r.borrowFees - r.equityAfter) < 1e-6);
  }
  const net = e.turnReports.reduce((sum, r) => sum + r.marketPnl - r.commission - r.borrowFees, 0);
  assert.ok(Math.abs(e.config.initialCapital + net - e.state.player.equity) < 1e-6);
  const restored = GameEngine.restore(data, JSON.parse(JSON.stringify(e.save())));
  assert.deepEqual(restored.turnReports, e.turnReports);
});
