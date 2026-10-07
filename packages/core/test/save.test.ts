import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../src/engine.ts';
import { loadDataset } from '../src/load-node.ts';
const data = loadDataset();

test('D0 JSON save resumes positions, pending orders and subsequent outcomes exactly', () => {
  const a = new GameEngine(data, { config: { difficulty: 0, startDate: '2008-09-01' } });
  a.submitByNotional('C', -20000);
  for (let i = 0; i < 30; i++) a.advance();
  a.submitByNotional('SPX', 10000);
  const raw = JSON.parse(JSON.stringify(a.save()));
  const b = GameEngine.restore(data, raw);
  assert.deepEqual(b.state, a.state);
  for (let i = 0; i < 40; i++) assert.deepEqual(b.advance(), a.advance());
  assert.deepEqual(b.state, a.state);
});
test('save output is detached and rejects corrupt logs, incompatible versions and changed datasets', () => {
  const e = new GameEngine(data, { config: { difficulty: 0 } });
  e.submitByNotional('SPX', 10000); e.advance();
  const save = e.save();
  save.actions[0].orders[0].quantity = 1;
  assert.throws(() => GameEngine.restore(data, save), /校验失败/);
  assert.notEqual(e.save().actions[0].orders[0].quantity, 1);
  assert.throws(() => GameEngine.restore(data, { ...e.save(), version: 999 }), /版本/);
  const modified = structuredClone(data);
  modified.events[0].headline += '!';
  assert.throws(() => GameEngine.restore(modified, e.save()), /数据已变化/);
});
test('invalid live orders do not enter the queue or contaminate account state', () => {
  const e = new GameEngine(data, { config: { difficulty: 0 } });
  for (const quantity of [NaN, Infinity, -1, 0, 0.5]) {
    assert.throws(() => e.submitOrder({ instrumentId: 'SPX', quantity, side: 'buy', kind: 'market', submittedAt: e.state.date }));
  }
  assert.equal(e.state.pendingOrders.length, 0);
  assert.ok(Number.isFinite(e.advance().equity));
});
test('finished D0 game can be restored without replaying beyond its end', () => {
  const e = new GameEngine(data, { config: { difficulty: 0, startDate: '2009-12-29' } });
  while (!e.isOver) e.advance();
  const restored = GameEngine.restore(data, JSON.parse(JSON.stringify(e.save())));
  assert.equal(restored.isOver, true);
  assert.deepEqual(restored.state, e.state);
});
