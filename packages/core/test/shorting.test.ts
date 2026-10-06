import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadDataset } from '../src/load-node.ts';
import { GameEngine } from '../src/engine.ts';
import { INSTRUMENT_BY_ID } from '../src/instruments.ts';

const dataset = loadDataset();

function makeEngine(seed = 1) {
  return new GameEngine(dataset, {
    config: { seed, difficulty: 0, timeline: 'jittered', identity: 'retail' },
  });
}

// ---------------------------------------------------------------- 指数做空

test('指数没有流通股，但必须可以做空', () => {
  // 回归：SPX 的 sharesOutstanding 是 0，而券源额度由流通股推导，
  // 于是 maxShortQty = 0，做空标普 500 永远返回 not_shortable。
  // 而「做空大盘」是这个游戏最核心的操作（最优策略就是先空后多）。
  assert.equal(INSTRUMENT_BY_ID.get('SPX')!.sharesOutstanding, 0);

  const e = makeEngine();
  const order = e.submitByNotional('SPX', -e.state.player.equity);
  assert.ok(order, '做空指数应该能成功下单');

  const res = e.advance();
  const fill = res.fills[0];
  assert.ok(fill, '应该有成交记录');
  assert.notEqual(fill.reason, 'not_shortable', `做空指数不应被拒绝，实际 reason=${fill.reason}`);
  assert.ok(fill.quantity > 0, `成交股数应大于 0，实际 ${fill.quantity}`);
});

test('做空指数不创造权益', () => {
  const e = makeEngine();
  const before = e.state.player.equity;
  const px = e.state.prices.get('SPX')!;
  const order = e.submitByNotional('SPX', -before)!;
  e.advance();
  const after = e.state.player.equity;
  // 卖空拿到现金、同时背上等额空头负债，权益只应有滑点/手续费的微小变化
  const notional = order.quantity * px;
  assert.ok(
    Math.abs(after - before) < notional * 0.02,
    `做空前后权益不应有量级变化：${before.toFixed(2)} → ${after.toFixed(2)}`,
  );
  assert.ok(e.state.player.cash > before, '做空后现金应该增加');
  assert.ok(e.state.player.equity < before * 1.001, '做空不应凭空增加权益');
});

test('有流通股的个股仍然受券源约束', () => {
  // 指数放开了借券约束，但个股不能一起放开——券源上限是做空摩擦的来源之一。
  const e = makeEngine();
  const float = INSTRUMENT_BY_ID.get('C')!.sharesOutstanding;
  assert.ok(float > 0, '花旗应有流通股');

  const order = e.submitByNotional('C', -e.state.player.equity);
  assert.ok(order);
  const res = e.advance();
  const fill = res.fills[0];
  assert.ok(fill.quantity > 0, `做空个股应该成交，实际 ${fill.quantity}（${fill.reason}）`);
  assert.notEqual(fill.reason, 'not_shortable');
});

test('卖空超过券源上限时会被截断，而不是静默失败', () => {
  const e = makeEngine();
  const inst = INSTRUMENT_BY_ID.get('C')!;
  // 用远超券源的数量下单
  const huge = Math.floor(inst.sharesOutstanding * 0.5);
  e.submitOrder({
    instrumentId: 'C',
    side: 'sell',
    quantity: huge,
    kind: 'market',
    submittedAt: e.state.date,
  });
  const res = e.advance();
  const fill = res.fills[0];
  assert.ok(fill, '应该有成交记录');
  assert.ok(fill.quantity > 0, '应当至少部分成交');
  assert.ok(fill.quantity <= huge, '成交不应超过下单量');
});

// ---------------------------------------------------------------- 小额成交

test('相对市场极小的订单应完全成交（回归：买入 70 股只成交 69 股）', () => {
  // 回归：流动性折减被应用了两次——capacity 里一次，fillFraction 上再一次。
  // 于是 D0 里 $10 万的标普小单（capacity 约 500 亿）也被砍掉 1%，
  // 标记成 partial。玩家看到「买入 70 股，成交 69 股」只会认为是 bug。
  const e = makeEngine();
  const order = e.submitByNotional('SPX', e.state.player.cash)!;
  const res = e.advance();
  const fill = res.fills[0];
  assert.equal(fill.quantity, order.quantity, `应全部成交 ${order.quantity} 股，实际 ${fill.quantity}`);
  assert.equal(fill.reason, 'ok', `不应标记为 ${fill.reason}`);
});

test('危机中的大额订单仍会被流动性截断', () => {
  // 上面放开的是「极小订单」，大额订单在低流动性下必须仍然难以成交——
  // 那是「想跑却跑不掉」这个核心体感的来源。
  const e = makeEngine();
  const px = e.state.prices.get('SPX')!;
  // 造一个相对 capacity 有分量的订单：直接下单量取 ADV 的一大部分
  const adv = 5e10;
  const qty = Math.floor((adv * 0.6) / px);
  e.submitOrder({ instrumentId: 'SPX', side: 'sell', quantity: qty, kind: 'market', submittedAt: e.state.date });
  const res = e.advance();
  const fill = res.fills[0];
  assert.ok(fill.quantity < qty, `大额订单应被部分成交，下单 ${qty} 成交 ${fill.quantity}`);
});
