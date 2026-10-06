import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAccount, applyFill } from '../src/portfolio.ts';
import type { Account, Fill } from '../src/types.ts';

function fill(side: 'buy' | 'sell', quantity: number, price: number, id = 'SPX'): Fill {
  return {
    order: { instrumentId: id, side, quantity, kind: 'market', submittedAt: '2007-03-01' },
    filledAt: '2007-03-01',
    price,
    quantity,
    impact: 0,
    commission: 0,
    reason: 'ok',
  };
}

function account(): Account {
  return createAccount(100_000);
}

// ---------------------------------------------------------------- 建仓

test('建仓：成本价 = 成交价', () => {
  const a = account();
  applyFill(a, fill('buy', 100, 50), '2007-03-01');
  const p = a.positions.get('SPX')!;
  assert.equal(p.quantity, 100);
  assert.equal(p.avgPrice, 50);
});

test('做空建仓：数量为负，成本价 = 成交价', () => {
  const a = account();
  applyFill(a, fill('sell', 100, 50), '2007-03-01');
  const p = a.positions.get('SPX')!;
  assert.equal(p.quantity, -100);
  assert.equal(p.avgPrice, 50);
});

// ---------------------------------------------------------------- 加仓

test('同向加仓：成本按数量加权平均', () => {
  const a = account();
  applyFill(a, fill('buy', 100, 50), '2007-03-01');
  applyFill(a, fill('buy', 100, 70), '2007-03-02');
  const p = a.positions.get('SPX')!;
  assert.equal(p.quantity, 200);
  assert.equal(p.avgPrice, 60, `加权平均应为 60，实际 ${p.avgPrice}`);
});

test('做空加仓：成本同样按数量加权平均', () => {
  const a = account();
  applyFill(a, fill('sell', 100, 50), '2007-03-01');
  applyFill(a, fill('sell', 300, 70), '2007-03-02');
  const p = a.positions.get('SPX')!;
  assert.equal(p.quantity, -400);
  assert.equal(p.avgPrice, 65, `加权平均应为 65，实际 ${p.avgPrice}`);
});

// ---------------------------------------------------------------- 部分平仓（本次 bug）

test('部分平仓：成本价必须保持不变（多头）', () => {
  const a = account();
  applyFill(a, fill('buy', 100, 1400), '2007-03-01');
  applyFill(a, fill('sell', 30, 1500), '2007-03-02');
  const p = a.positions.get('SPX')!;
  assert.equal(p.quantity, 70);
  assert.equal(p.avgPrice, 1400, `部分平仓不应该改变成本价，实际 ${p.avgPrice}`);
});

test('部分平仓：成本价必须保持不变（空头）', () => {
  const a = account();
  applyFill(a, fill('sell', 100, 1400), '2007-03-01');
  applyFill(a, fill('buy', 30, 1200), '2007-03-02');
  const p = a.positions.get('SPX')!;
  assert.equal(p.quantity, -70);
  assert.equal(p.avgPrice, 1400, `部分平仓不应该改变成本价，实际 ${p.avgPrice}`);
});

test('反复部分平仓不会让成本价漂移（回归：曾溢出到 $201,934）', () => {
  // 真实的 bug 场景：玩家用「做空 25%」反复减仓。
  // 修复前每减一次成本就乘上约 1.857，8 次之后 $1400 变成 $201,934。
  const a = account();
  applyFill(a, fill('buy', 100, 1400), '2007-03-01');
  let qty = 100;
  for (let i = 0; i < 12 && qty > 1; i++) {
    const sell = Math.max(1, Math.floor(qty * 0.25));
    applyFill(a, fill('sell', sell, 1400), `2007-03-${String(i + 2).padStart(2, '0')}`);
    qty -= sell;
    const p = a.positions.get('SPX');
    if (!p) break;
    assert.ok(
      Math.abs(p.avgPrice - 1400) < 1e-6,
      `第 ${i + 1} 次减仓后成本价应仍为 1400，实际 ${p.avgPrice}`,
    );
  }
});

test('减仓不会凭空创造权益', () => {
  const a = account();
  applyFill(a, fill('buy', 100, 1400), '2007-03-01'); // cash 100000 - 140000 = -40000
  const cashBefore = a.cash;
  applyFill(a, fill('sell', 30, 1400), '2007-03-02'); // 卖 30 股 @1400 → +42000
  assert.equal(a.cash, cashBefore + 30 * 1400);
  const p = a.positions.get('SPX')!;
  // 权益恒等式：cash + qty × price 应与减仓前一致（同价成交、无手续费）
  assert.equal(a.cash + p.quantity * 1400, cashBefore + 100 * 1400);
});

// ---------------------------------------------------------------- 穿越零

test('穿越零：反向开仓，成本重置为本次成交价', () => {
  const a = account();
  applyFill(a, fill('buy', 100, 50), '2007-03-01');
  applyFill(a, fill('sell', 150, 80), '2007-03-02');
  const p = a.positions.get('SPX')!;
  assert.equal(p.quantity, -50);
  assert.equal(p.avgPrice, 80, `穿越零后成本应重置为成交价 80，实际 ${p.avgPrice}`);
});

test('空头穿越零转多头', () => {
  const a = account();
  applyFill(a, fill('sell', 100, 50), '2007-03-01');
  applyFill(a, fill('buy', 150, 80), '2007-03-02');
  const p = a.positions.get('SPX')!;
  assert.equal(p.quantity, 50);
  assert.equal(p.avgPrice, 80);
});

// ---------------------------------------------------------------- 完全平仓

test('完全平仓：持仓被移除', () => {
  const a = account();
  applyFill(a, fill('buy', 100, 50), '2007-03-01');
  applyFill(a, fill('sell', 100, 60), '2007-03-02');
  assert.equal(a.positions.has('SPX'), false);
  assert.equal(a.cash, 100_000 + 100 * 10);
});

test('恰好平仓不会产生除零（NaN / Infinity）', () => {
  const a = account();
  applyFill(a, fill('buy', 100, 50), '2007-03-01');
  applyFill(a, fill('sell', 100, 50), '2007-03-02');
  for (const p of a.positions.values()) {
    assert.ok(Number.isFinite(p.avgPrice), `成本价不应为 ${p.avgPrice}`);
  }
});

// ---------------------------------------------------------------- 不变量

test('成本价永远是有限正数（随机成交序列）', () => {
  // 用一个确定性的伪随机序列反复买卖，断言成本价始终是合理的正数。
  // 这条是为了兜住「任何成交组合都不该让成本价发散」这个不变量。
  const a = account();
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 400; i++) {
    const price = 30 + rnd() * 60; // 30–90
    const qty = 1 + Math.floor(rnd() * 80);
    applyFill(a, fill(rnd() > 0.5 ? 'buy' : 'sell', qty, price), '2007-03-01');
    const p = a.positions.get('SPX');
    if (!p) continue;
    assert.ok(Number.isFinite(p.avgPrice), `第 ${i} 笔后成本价为 ${p.avgPrice}`);
    assert.ok(p.avgPrice > 0, `第 ${i} 笔后成本价为 ${p.avgPrice}`);
    assert.ok(
      p.avgPrice >= 29 && p.avgPrice <= 91,
      `第 ${i} 笔后成本价 ${p.avgPrice.toFixed(2)} 落在成交价区间 [30,90] 之外`,
    );
  }
});
