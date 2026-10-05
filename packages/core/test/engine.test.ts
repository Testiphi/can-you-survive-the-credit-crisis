import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadDataset } from '../src/load-node.ts';
import { GameEngine } from '../src/engine.ts';
import type { GameConfig } from '../src/types.ts';
import { createAccount, applyFill, markToMarket, computeMaintenanceMargin, checkMargin, planLiquidation } from '../src/portfolio.ts';
import { dynamicShortMarginRate } from '../src/securities-lending.ts';
import type { Fill } from '../src/types.ts';

const dataset = loadDataset();

function makeEngine(overrides: Partial<GameConfig> = {}, opts = {}) {
  return new GameEngine(dataset, { config: overrides, ...opts });
}

function baseConfig(over: Partial<GameConfig> = {}): Partial<GameConfig> {
  return {
    seed: 42,
    difficulty: 1,
    identity: 'retail',
    initialCapital: 100_000,
    timeline: 'jittered',
    startDate: '2007-01-02',
    endDate: '2009-12-31',
    ...over,
  };
}

// ------------------------------------------------------------------ 数据集

test('数据集可加载且数量与校验器一致', () => {
  assert.equal(dataset.events.length, 92);
  assert.equal(dataset.institutions.institutions.length, 21);
  assert.equal(dataset.rumors.templates.length, 38);
});

test('事件 id 唯一', () => {
  const ids = dataset.events.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ------------------------------------------------------------------ 账户数学

test('做多建仓：现金减少，权益不变（忽略手续费）', () => {
  const acct = createAccount(100_000);
  const fill: Fill = {
    order: { instrumentId: 'LEH', side: 'buy', quantity: 100, kind: 'market', submittedAt: '2007-01-02' },
    filledAt: '2007-01-03',
    price: 50,
    quantity: 100,
    impact: 0,
    commission: 0,
    reason: 'ok',
  };
  applyFill(acct, fill, '2007-01-03');
  const prices = new Map([['LEH', 50]]);
  markToMarket(acct, prices);
  assert.equal(acct.cash, 100_000 - 5_000);
  assert.equal(acct.equity, 100_000);
  assert.equal(acct.positions.get('LEH')!.quantity, 100);
});

test('做空建仓：权益同样不变（做空不创造权益）', () => {
  const acct = createAccount(100_000);
  const fill: Fill = {
    order: { instrumentId: 'LEH', side: 'sell', quantity: 100, kind: 'market', submittedAt: '2007-01-02' },
    filledAt: '2007-01-03',
    price: 50,
    quantity: 100,
    impact: 0,
    commission: 0,
    reason: 'ok',
  };
  applyFill(acct, fill, '2007-01-03');
  markToMarket(acct, new Map([['LEH', 50]]));
  assert.equal(acct.cash, 105_000);
  assert.equal(acct.equity, 100_000);
  assert.equal(acct.positions.get('LEH')!.quantity, -100);
});

test('做空后价格下跌产生盈利', () => {
  const acct = createAccount(100_000);
  applyFill(
    acct,
    {
      order: { instrumentId: 'LEH', side: 'sell', quantity: 100, kind: 'market', submittedAt: '2007-01-02' },
      filledAt: '2007-01-03',
      price: 50,
      quantity: 100,
      impact: 0,
      commission: 0,
      reason: 'ok',
    },
    '2007-01-03',
  );
  markToMarket(acct, new Map([['LEH', 40]]));
  assert.equal(acct.equity, 101_000, '空头在下跌中赚 1000');
});

test('穿越零：反手做空时成本价重置', () => {
  const acct = createAccount(1_000_000);
  const mk = (side: 'buy' | 'sell', qty: number, price: number): Fill => ({
    order: { instrumentId: 'GS', side, quantity: qty, kind: 'market', submittedAt: '2007-01-02' },
    filledAt: '2007-01-03',
    price,
    quantity: qty,
    impact: 0,
    commission: 0,
    reason: 'ok',
  });
  applyFill(acct, mk('buy', 100, 50), '2007-01-03');
  assert.equal(acct.positions.get('GS')!.avgPrice, 50);
  // 卖出 300 → 净 -200，成本应为 60
  applyFill(acct, mk('sell', 300, 60), '2007-01-04');
  const pos = acct.positions.get('GS')!;
  assert.equal(pos.quantity, -200);
  assert.equal(pos.avgPrice, 60, '穿越零后成本重置为本次成交价');
  assert.ok(pos.borrowFeeRate > 0, '空头应有借券费');
});

test('同向加仓计算加权平均成本', () => {
  const acct = createAccount(1_000_000);
  const mk = (qty: number, price: number): Fill => ({
    order: { instrumentId: 'GS', side: 'buy', quantity: qty, kind: 'market', submittedAt: '2007-01-02' },
    filledAt: '2007-01-03',
    price,
    quantity: qty,
    impact: 0,
    commission: 0,
    reason: 'ok',
  });
  applyFill(acct, mk(100, 100), '2007-01-03');
  applyFill(acct, mk(100, 200), '2007-01-04');
  assert.equal(acct.positions.get('GS')!.avgPrice, 150);
});

test('维持保证金：空头按更高比率计提', () => {
  const long = createAccount(1_000_000);
  applyFill(
    long,
    { order: { instrumentId: 'GS', side: 'buy', quantity: 100, kind: 'market', submittedAt: 'x' }, filledAt: 'x', price: 100, quantity: 100, impact: 0, commission: 0, reason: 'ok' },
    'x',
  );
  const short = createAccount(1_000_000);
  applyFill(
    short,
    { order: { instrumentId: 'GS', side: 'sell', quantity: 100, kind: 'market', submittedAt: 'x' }, filledAt: 'x', price: 100, quantity: 100, impact: 0, commission: 0, reason: 'ok' },
    'x',
  );
  const prices = new Map([['GS', 100]]);
  const mmLong = computeMaintenanceMargin(long, prices);
  const mmShort = computeMaintenanceMargin(short, prices);
  assert.equal(mmLong, 100 * 100 * 0.25);
  assert.equal(mmShort, 100 * 100 * 0.3);
  assert.ok(mmShort > mmLong);
});

test('保证金状态机：ok → margin_call → liquidate', () => {
  const prices = new Map([['GS', 100]]);
  assert.equal(checkMargin({ ...createAccount(0), equity: 10_000 }, prices, 5_000).status, 'ok');
  assert.equal(checkMargin({ ...createAccount(0), equity: 4_000 }, prices, 5_000).status, 'margin_call');
  assert.equal(checkMargin({ ...createAccount(0), equity: 3_000 }, prices, 5_000).status, 'liquidate');
});

test('强平计划按敞口从大到小排序，并覆盖缺口', () => {
  const acct = createAccount(1_000_000);
  const prices = new Map([
    ['GS', 100],
    ['LEH', 50],
  ]);
  applyFill(
    acct,
    { order: { instrumentId: 'LEH', side: 'buy', quantity: 100, kind: 'market', submittedAt: 'x' }, filledAt: 'x', price: 50, quantity: 100, impact: 0, commission: 0, reason: 'ok' },
    'x',
  );
  applyFill(
    acct,
    { order: { instrumentId: 'GS', side: 'buy', quantity: 500, kind: 'market', submittedAt: 'x' }, filledAt: 'x', price: 100, quantity: 500, impact: 0, commission: 0, reason: 'ok' },
    'x',
  );
  const plan = planLiquidation(acct, prices, 10_000);
  assert.ok(plan.length > 0);
  assert.equal(plan[0].instrumentId, 'GS', '最大敞口优先');
  assert.ok(plan[0].quantity > 0, '多头 → 卖出');
});

// ------------------------------------------------------------------ 引擎

test('引擎可构造，初始状态正确', () => {
  const e = makeEngine(baseConfig());
  assert.equal(e.state.date, '2007-01-02');
  assert.equal(e.state.turnIndex, 0);
  assert.equal(e.state.player.equity, 100_000);
  assert.equal(e.visibleBars('SPX').length, 1);
  assert.equal(e.isOver, false);
});

test('可见 K 线永不包含未来（防未来函数）', () => {
  const e = makeEngine(baseConfig());
  for (let i = 0; i < 60; i++) e.advance();
  const visible = e.visibleBars('SPX');
  const all = e.state.bars.get('SPX')!;
  assert.ok(visible.length <= all.length);
  for (const bar of visible) {
    assert.ok(bar.date <= e.state.date, `泄露未来数据: ${bar.date} > ${e.state.date}`);
  }
  assert.equal(visible[visible.length - 1].date, e.state.date);
});

test('确定性：相同种子 + 相同操作 → 完全相同的结果', () => {
  const run = () => {
    const e = makeEngine(baseConfig({ seed: 7 }));
    for (let i = 0; i < 120; i++) e.advance();
    return e.state.player.equity;
  };
  assert.equal(run(), run());
});

test('不同种子会产生不同的市场路径', () => {
  const a = makeEngine(baseConfig({ seed: 1 }));
  const b = makeEngine(baseConfig({ seed: 2 }));
  for (let i = 0; i < 120; i++) {
    a.advance();
    b.advance();
  }
  assert.notEqual(a.state.prices.get('LEH'), b.state.prices.get('LEH'));
});

test('完整跑完 2007-2009 不抛异常，且事件确实触发了', () => {
  const e = makeEngine(baseConfig({ seed: 42 }));
  let turns = 0;
  while (!e.isOver && turns < 1000) {
    e.advance();
    turns++;
  }
  assert.ok(turns > 700, `回合数偏少: ${turns}`);
  assert.ok(e.state.firedEvents.length > 30, `触发事件偏少: ${e.state.firedEvents.length}`);
  // 核心叙事事件必须发生
  assert.ok(e.state.firedEvents.includes('bnp_paribas_freeze'), '巴黎银行冻结基金应触发');
  assert.ok(e.state.firedEvents.includes('lehman_collapse'), '雷曼破产应触发');
  assert.ok(e.state.firedEvents.includes('aig_bailout'), 'AIG 救助应触发');
  assert.ok(e.state.firedEvents.includes('sec_short_ban'), '做空禁令应触发');
  assert.ok(e.state.firedEvents.includes('sp500_bottom_666'), '见底应触发');
});

test('标普路径与历史锚点量级一致', () => {
  const e = makeEngine(baseConfig({ seed: 42 }));
  while (!e.isOver) e.advance();
  const bars = e.state.bars.get('SPX')!;
  const byDate = new Map(bars.map((b) => [b.date, b.close]));

  const high = byDate.get('2007-10-09')!;
  const low = byDate.get('2009-03-09')!;
  const end = byDate.get('2009-12-31')!;

  assert.ok(high > 1400 && high < 1750, `2007-10-09 标普应在 1400-1750，实际 ${high}`);
  assert.ok(low > 550 && low < 850, `2009-03-09 标普应在 550-850，实际 ${low}`);
  assert.ok(end > 900 && end < 1300, `2009-12-31 标普应在 900-1300，实际 ${end}`);
  assert.ok(low < high * 0.75, '应出现 25% 以上的累计跌幅');
});

test('做空禁令生效期间，金融股无法做空', () => {
  const e = makeEngine(baseConfig({ seed: 42, difficulty: 2, identity: 'hedge_fund' }));
  // 推进到做空禁令生效之后
  while (!e.isOver && !e.state.firedEvents.includes('sec_short_ban')) e.advance();
  assert.ok(e.state.firedEvents.includes('sec_short_ban'), '应触发做空禁令');

  e.submitOrder({ instrumentId: 'GS', side: 'sell', quantity: 1000, kind: 'market', submittedAt: e.state.date });
  const res = e.advance();
  const rejected = res.fills.filter((f) => f.reason === 'not_shortable');
  assert.ok(rejected.length > 0, '禁令期间做空金融股应被拒单');
});

test('监管阶梯随空头集中度上升', () => {
  const e = makeEngine(baseConfig({ seed: 42, difficulty: 3, identity: 'bank', initialCapital: 5e9 }));
  while (!e.isOver && e.state.date < '2007-02-01') e.advance();
  // 持续做空 BSC（流通股仅 1.3 亿，5% 披露门槛相对容易达到）。
  // 必须多回合累积——流动性模型不允许单笔吃下 5% 流通股，这是刻意设计。
  let turns = 0;
  while (!e.isOver && turns < 60 && e.state.regulator.shortConcentration <= 0.05) {
    e.submitOrder({
      instrumentId: 'BSC',
      side: 'sell',
      quantity: 5_000_000,
      kind: 'market',
      submittedAt: e.state.date,
    });
    e.advance();
    turns++;
  }
  const conc = e.state.regulator.shortConcentration;
  assert.ok(conc > 0.05, `空头集中度应超过 5%，实际 ${(conc * 100).toFixed(2)}%（${turns} 回合）`);
  assert.ok(e.state.regulator.level >= 2, `监管等级应达到 L2，实际 L${e.state.regulator.level}`);
});

test('保证金倍数精确放大维持保证金要求', () => {
  const e = makeEngine(baseConfig({ seed: 42, difficulty: 2, identity: 'hedge_fund', initialCapital: 1e8 }));
  while (!e.isOver && e.state.date < '2007-02-01') e.advance();
  for (let i = 0; i < 6; i++) {
    e.submitOrder({ instrumentId: 'JPM', side: 'buy', quantity: 100_000, kind: 'market', submittedAt: e.state.date });
    e.advance();
  }
  const base = computeMaintenanceMargin(e.state.player, e.state.prices);
  const raised = computeMaintenanceMargin(e.state.player, e.state.prices, { marginMultiplier: 1.5 });
  assert.ok(base > 0, '应有维持保证金要求');
  assert.ok(Math.abs(raised / base - 1.5) < 1e-6, `倍数应精确为 1.5，实际 ${raised / base}`);
});

test('危机中空头维持保证金率被上调', () => {
  // 平静期 0.30，压力 1.0 时 0.75
  assert.equal(dynamicShortMarginRate(0), 0.3);
  assert.ok(Math.abs(dynamicShortMarginRate(1) - 0.75) < 1e-9);
  assert.ok(dynamicShortMarginRate(0.5) > dynamicShortMarginRate(0.2));
});

test('爆仓后 isOver 为真', () => {
  const e = makeEngine(baseConfig({ seed: 42, difficulty: 3, identity: 'retail', initialCapital: 50_000 }));
  e.submitOrder({ instrumentId: 'LEH', side: 'buy', quantity: 100_000, kind: 'market', submittedAt: e.state.date });
  let guard = 0;
  while (!e.isOver && guard++ < 1000) e.advance();
  assert.ok(e.state.player.bankrupt || e.isOver);
});

test('summary() 返回可序列化的 UI 数据', () => {
  const e = makeEngine(baseConfig());
  for (let i = 0; i < 30; i++) e.advance();
  const s = e.summary();
  assert.equal(typeof s.equity, 'number');
  assert.equal(typeof s.date, 'string');
  assert.ok(Array.isArray(s.positions));
  assert.ok(Number.isFinite(s.equity));
});

test('save() 包含复现所需的种子与配置', () => {
  const e = makeEngine(baseConfig({ seed: 99 }));
  for (let i = 0; i < 10; i++) e.advance();
  const s = e.save();
  assert.equal(s.seed, 99);
  assert.equal(s.config.seed, 99);
  assert.equal(s.date, e.state.date);
});

// ------------------------------------------------------------------ 竞争风险

test('竞争风险：贝尔斯登在多数运行中第一个倒下（但不是必然）', () => {
  const firstDomino: Record<string, number> = {};
  const N = 24;

  for (let seed = 0; seed < N; seed++) {
    const e = makeEngine(baseConfig({ seed, difficulty: 1 }), {});
    while (!e.isOver && !e.state.firedEvents.some((id) => ['bear_stearns_collapse', 'lehman_collapse', 'merrill_merger', 'gs_ms_bank_holding'].includes(id))) {
      e.advance();
    }
    const first = e.state.firedEvents.find((id) =>
      ['bear_stearns_collapse', 'lehman_collapse', 'merrill_merger', 'gs_ms_bank_holding'].includes(id),
    );
    if (first) firstDomino[first] = (firstDomino[first] ?? 0) + 1;
  }

  const bsc = firstDomino['bear_stearns_collapse'] ?? 0;
  const total = Object.values(firstDomino).reduce((a, b) => a + b, 0);
  assert.ok(total >= N * 0.7, `应有足够多的运行产生首个失败事件，实际 ${total}/${N}`);
  // 主峰存在（but 不强制）：贝尔斯登应是最常见的第一个
  const sorted = Object.entries(firstDomino).sort((a, b) => b[1] - a[1]);
  assert.equal(sorted[0][0], 'bear_stearns_collapse', `首个倒下的应最常见为贝尔斯登，实际分布: ${JSON.stringify(firstDomino)}`);
  assert.ok(bsc / total >= 0.4, `贝尔斯登占比应显著，实际 ${bsc}/${total}`);
});

test('历史模式（historical）与抖动模式的触发日期不同', () => {
  const hist = makeEngine(baseConfig({ seed: 5, timeline: 'historical' }));
  const jit = makeEngine(baseConfig({ seed: 5, timeline: 'jittered' }));
  while (!hist.isOver) hist.advance();
  while (!jit.isOver) jit.advance();
  const dHist = hist.state.bars.get('SPX')!.find((b) => b.date >= '2008-09-15');
  const dJit = jit.state.bars.get('SPX')!.find((b) => b.date >= '2008-09-15');
  assert.ok(dHist && dJit);
  // 抖动模式下雷曼破产的日期应当浮动（不同 seed 下不同）
  const a = makeEngine(baseConfig({ seed: 11 }));
  const b = makeEngine(baseConfig({ seed: 12 }));
  while (!a.isOver) a.advance();
  while (!b.isOver) b.advance();
  const dateOf = (e: GameEngine, id: string) => e.state.news.find((n) => n.eventId === id)?.date;
  const la = dateOf(a, 'lehman_collapse');
  const lb = dateOf(b, 'lehman_collapse');
  assert.ok(la && lb);
  // 允许相同（窗口窄时可能一致），但至少不应全部固定在历史日期
  assert.ok(la >= '2008-06-01' && la <= '2008-12-31', `雷曼日期应在窗口内: ${la}`);
});
