import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadDataset } from '../src/load-node.ts';
import { GameEngine } from '../src/engine.ts';
import { borrowQuote } from '../src/securities-lending.ts';
import { INSTRUMENT_BY_ID } from '../src/instruments.ts';

const dataset = loadDataset();

const SPX_FLOAT = INSTRUMENT_BY_ID.get('SPX')!.sharesOutstanding;
const C_FLOAT = INSTRUMENT_BY_ID.get('C')!.sharesOutstanding;

// ---------------------------------------------------------------- 费率模型

test('指数没有借券市场，不应按「满负荷利用率」计费', () => {
  // 回归：capacityShares 由流通股推导，指数是 0，旧代码把这种情况记为
  // utilization = 1（满负荷），utilMult 直接吃满 4 倍。
  const q = borrowQuote({
    instrumentId: 'SPX',
    floatShares: SPX_FLOAT,
    price: 1400,
    currentShortQty: 1000,
    stress: 0.2,
  });
  assert.equal(q.utilization, 0, `指数不应有借券利用率，实际 ${q.utilization}`);
  assert.ok(q.feeRate < 0.05, `平静期指数费率应低于 5%，实际 ${(q.feeRate * 100).toFixed(1)}%`);
});

test('指数费率在危机峰值也应保持在个位数', () => {
  // 现实参照：做空大盘走期货/ETF，成本是融资成本。
  // 2008 年资金面紧张时基差确实走阔，但不会到难借券那个量级。
  for (const stress of [0, 0.25, 0.5, 0.75, 1]) {
    const q = borrowQuote({
      instrumentId: 'SPX',
      floatShares: SPX_FLOAT,
      price: 1400,
      currentShortQty: 700,
      stress,
    });
    assert.ok(
      q.feeRate <= 0.07,
      `压力 ${stress} 下指数费率应 ≤ 7%，实际 ${(q.feeRate * 100).toFixed(1)}%`,
    );
  }
});

test('指数不会被强制回补（没有出借人）', () => {
  const q = borrowQuote({
    instrumentId: 'SPX',
    floatShares: SPX_FLOAT,
    price: 1400,
    currentShortQty: 1000,
    stress: 0.8,
    marketReturnToday: 0.05,
  });
  assert.equal(q.recallRisk, 0, `指数不应有召回风险，实际 ${q.recallRisk}`);
});

test('流动性好的大票费率保持个位数到低两位数', () => {
  // 回归：旧公式对所有人用 1 + 120·stress，高盛这种从不难借的大票
  // 在 2008 年也要付 33%/年。真实水平是个位数。
  const q = borrowQuote({
    instrumentId: 'GS',
    floatShares: INSTRUMENT_BY_ID.get('GS')!.sharesOutstanding,
    price: 200,
    currentShortQty: 10_000, // 相对 4.3 亿流通股微不足道
    stress: 0.6,
  });
  assert.ok(q.utilization < 0.001, `小额做空利用率应极低，实际 ${q.utilization}`);
  assert.ok(
    q.feeRate < 0.15,
    `流动性好的大票费率应低于 15%，实际 ${(q.feeRate * 100).toFixed(1)}%`,
  );
});

test('拥挤的做空仍然昂贵——利用率是区分「难借」的维度', () => {
  // 放开压力倍数不等于放开券源摩擦：真正借不到券的标的必须依然昂贵。
  const cheap = borrowQuote({
    instrumentId: 'X',
    floatShares: 1_000_000_000,
    price: 50,
    currentShortQty: 1_000,
    stress: 0.6,
  });
  const crowded = borrowQuote({
    instrumentId: 'X',
    floatShares: 1_000_000_000,
    price: 50,
    currentShortQty: 60_000_000, // 吃满 8% 券源的一大半
    stress: 0.6,
  });
  assert.ok(
    crowded.feeRate > cheap.feeRate * 2,
    `拥挤做空的费率应显著高于小额：${(crowded.feeRate * 100).toFixed(1)}% vs ${(cheap.feeRate * 100).toFixed(1)}%`,
  );
});

// ---------------------------------------------------------------- 端到端不变量

test('在最高点做空大盘并持有到期末，必须是赚钱的', () => {
  // 这是用户报的那个现象的核心不变量：
  // 指数跌了 28.7%，做空却因为借券费亏钱，无论如何说不通。
  const e = new GameEngine(dataset, {
    config: { seed: 1, difficulty: 1, timeline: 'historical', disableRumors: true },
  });
  while (e.state.date < '2007-10-09' && !e.isOver) e.advance();

  const entryPx = e.state.prices.get('SPX')!;
  const qty = Math.floor((e.state.player.equity * 0.9) / entryPx);
  e.submitOrder({ instrumentId: 'SPX', side: 'sell', quantity: qty, kind: 'market', submittedAt: e.state.date });
  e.advance();
  const entryEquity = e.state.player.equity;

  while (!e.isOver) e.advance();

  const exitPx = e.state.prices.get('SPX')!;
  const exitEquity = e.state.player.equity;
  assert.ok(exitPx < entryPx, `标普应下跌：${entryPx.toFixed(0)} → ${exitPx.toFixed(0)}`);
  assert.ok(
    exitEquity > entryEquity,
    `指数下跌 ${(((exitPx - entryPx) / entryPx) * 100).toFixed(1)}% 时做空必须盈利，实际 ${entryEquity.toFixed(0)} → ${exitEquity.toFixed(0)}`,
  );
});

test('做空持有的年化摩擦成本远低于标的跌幅带来的收益', () => {
  // 更一般的不变量：持有成本不应吞掉大部分收益。
  const e = new GameEngine(dataset, {
    config: { seed: 1, difficulty: 1, timeline: 'historical', disableRumors: true },
  });
  while (e.state.date < '2007-10-09' && !e.isOver) e.advance();

  const entryPx = e.state.prices.get('SPX')!;
  const qty = Math.floor((e.state.player.equity * 0.9) / entryPx);
  e.submitOrder({ instrumentId: 'SPX', side: 'sell', quantity: qty, kind: 'market', submittedAt: e.state.date });
  const fill = e.advance().fills[0];
  const entryEquity = e.state.player.equity;

  let fees = 0;
  while (!e.isOver) {
    const pos = e.state.player.positions.get('SPX');
    if (pos && pos.quantity < 0) {
      fees += (Math.abs(pos.quantity) * e.state.prices.get('SPX')!) * pos.borrowFeeRate / 252;
    }
    e.advance();
  }
  const gross = (fill.price - e.state.prices.get('SPX')!) * fill.quantity;
  assert.ok(
    fees < gross * 0.3,
    `借券费 ${fees.toFixed(0)} 不应超过毛收益 ${gross.toFixed(0)} 的 30%`,
  );
  assert.ok(
    e.state.player.equity - entryEquity > gross * 0.8,
    `净收益应接近毛收益：净 ${(e.state.player.equity - entryEquity).toFixed(0)} vs 毛 ${gross.toFixed(0)}`,
  );
  void C_FLOAT;
});
