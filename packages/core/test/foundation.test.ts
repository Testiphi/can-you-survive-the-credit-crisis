import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rng, createStreams } from '../src/rng.ts';
import {
  isTradingDay,
  nextTradingDay,
  prevTradingDay,
  tradingDaysBetween,
  shiftTradingDays,
  tradingDayDiff,
} from '../src/time.ts';
import { evaluateCondition, isPredicate, makeContext } from '../src/conditions.ts';

// ------------------------------------------------------------------ RNG

test('同一种子产生完全相同的序列', () => {
  const a = new Rng(42, 'market');
  const b = new Rng(42, 'market');
  const seqA = Array.from({ length: 50 }, () => a.next());
  const seqB = Array.from({ length: 50 }, () => b.next());
  assert.deepEqual(seqA, seqB);
});

test('不同种子产生不同序列', () => {
  const a = new Rng(42, 'market');
  const b = new Rng(43, 'market');
  assert.notEqual(a.next(), b.next());
});

test('不同流互不干扰（玩家行为不影响市场随机性）', () => {
  const market = new Rng(42, 'market');
  const scenario = new Rng(42, 'scenario');
  const first = market.next();

  // 消耗若干 scenario 流的随机数，模拟事件触发
  for (let i = 0; i < 100; i++) scenario.next();

  const marketAgain = new Rng(42, 'market');
  assert.equal(marketAgain.next(), first, 'market 流不应被 scenario 流影响');
});

test('next() 落在 [0,1)', () => {
  const r = new Rng(7, 'test');
  for (let i = 0; i < 10_000; i++) {
    const v = r.next();
    assert.ok(v >= 0 && v < 1, `越界: ${v}`);
  }
});

test('normal() 的均值与标准差大致正确', () => {
  const r = new Rng(1234, 'gauss');
  const n = 200_000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = r.normal();
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  const sd = Math.sqrt(sumSq / n - mean * mean);
  assert.ok(Math.abs(mean) < 0.02, `均值偏差过大: ${mean}`);
  assert.ok(Math.abs(sd - 1) < 0.02, `标准差偏差过大: ${sd}`);
});

test('chance() 的概率大致正确', () => {
  const r = new Rng(99, 'chance');
  let hits = 0;
  const n = 100_000;
  for (let i = 0; i < n; i++) if (r.chance(0.25)) hits++;
  const rate = hits / n;
  assert.ok(Math.abs(rate - 0.25) < 0.01, `实际: ${rate}`);
});

test('chance(0) 恒为 false，chance(1) 恒为 true', () => {
  const r = new Rng(1, 'edge');
  for (let i = 0; i < 100; i++) {
    assert.equal(r.chance(0), false);
    assert.equal(r.chance(1), true);
  }
});

test('exponential() 均值约为 1/rate', () => {
  const r = new Rng(2024, 'exp');
  const rate = 0.05;
  let sum = 0;
  const n = 100_000;
  for (let i = 0; i < n; i++) sum += r.exponential(rate);
  const mean = sum / n;
  assert.ok(Math.abs(mean - 1 / rate) / (1 / rate) < 0.05, `均值: ${mean}`);
});

test('createStreams 返回四条独立流', () => {
  const s = createStreams(42);
  const vals = [s.market.next(), s.scenario.next(), s.agents.next(), s.news.next()];
  assert.equal(new Set(vals).size, 4);
});

// ----------------------------------------------------------------- 日历

test('周末与节假日不是交易日', () => {
  assert.equal(isTradingDay('2007-01-06'), false, '周六');
  assert.equal(isTradingDay('2007-01-07'), false, '周日');
  assert.equal(isTradingDay('2008-12-25'), false, '圣诞节');
  assert.equal(isTradingDay('2008-07-04'), false, '独立日');
  assert.equal(isTradingDay('2007-04-06'), false, '耶稣受难日');
});

test('关键历史日期是交易日', () => {
  // 这几个日期是事件卡锚点，必须是交易日
  const anchors = [
    '2007-08-09', // 巴黎银行冻结基金
    '2008-03-14', // 贝尔斯登救助谈判
    '2008-03-17', // 贝尔斯登被收购后的第一个交易日
    '2008-09-15', // 雷曼破产
    '2008-09-16', // AIG 被救助
    '2008-09-19', // SEC 做空禁令
    '2008-10-10', // 全球暴跌周
    '2008-11-20', // 标普 752
    '2009-03-09', // 标普 676 见底
    '2009-03-10', // 花旗宣布盈利
  ];
  for (const d of anchors) {
    assert.equal(isTradingDay(d), true, `${d} 应为交易日`);
  }
});

test('nextTradingDay 跳过周末', () => {
  assert.equal(nextTradingDay('2007-01-05'), '2007-01-08', '周五 → 周一');
  assert.equal(nextTradingDay('2008-09-12'), '2008-09-15', '雷曼前的周五 → 周一');
});

test('prevTradingDay 跳过周末', () => {
  assert.equal(prevTradingDay('2008-09-15'), '2008-09-12');
  assert.equal(prevTradingDay('2007-01-08'), '2007-01-05');
});

test('tradingDaysBetween 覆盖 2007-01-02 至 2009-12-31 约 756 个交易日', () => {
  const days = tradingDaysBetween('2007-01-02', '2009-12-31');
  assert.ok(days.length > 740 && days.length < 760, `实际交易日数: ${days.length}`);
  assert.equal(days[0], '2007-01-02');
  assert.equal(days[days.length - 1], '2009-12-31');
});

test('shiftTradingDays 与 tradingDayDiff 互逆', () => {
  assert.equal(shiftTradingDays('2008-09-15', 5), '2008-09-22');
  assert.equal(shiftTradingDays('2008-09-15', -1), '2008-09-12');
  assert.equal(tradingDayDiff('2008-09-15', '2008-09-22'), 5);
  assert.equal(tradingDayDiff('2008-09-22', '2008-09-15'), -5);
});

// ----------------------------------------------------------------- 条件求值

test('isPredicate 正确区分谓词与事件 id', () => {
  assert.equal(isPredicate('credit_spread_above_800'), true);
  assert.equal(isPredicate('vix_above_75'), true);
  assert.equal(isPredicate('liquidity_below_0.2'), true);
  assert.equal(isPredicate('player_short_concentration_LEH_above_5pct'), true);
  assert.equal(isPredicate('lehman_collapse'), false);
  assert.equal(isPredicate('not_a_predicate'), false);
});

test('谓词求值', () => {
  const ctx = makeContext({ date: '2008-09-15', creditSpread: 900, vix: 80, liquidity: 0.15 });
  assert.equal(evaluateCondition('credit_spread_above_800', ctx), true);
  assert.equal(evaluateCondition('credit_spread_above_1000', ctx), false);
  assert.equal(evaluateCondition('vix_above_75', ctx), true);
  assert.equal(evaluateCondition('liquidity_below_0.2', ctx), true);
  assert.equal(evaluateCondition('liquidity_below_0.1', ctx), false);
});

test('玩家空头集中度谓词使用百分比', () => {
  const ctx = makeContext({
    date: '2008-09-15',
    shortConcentration: { LEH: 0.06, GS: 0.01 },
  });
  assert.equal(evaluateCondition('player_short_concentration_LEH_above_5pct', ctx), true);
  assert.equal(evaluateCondition('player_short_concentration_GS_above_5pct', ctx), false);
  assert.equal(evaluateCondition('player_short_concentration_AIG_above_5pct', ctx), false);
});

test('表达式求值支持全部比较运算符', () => {
  const ctx = makeContext({ date: '2008-10-10', systemicStress: 0.85, vix: 89.53 });
  assert.equal(evaluateCondition('systemicStress > 0.7', ctx), true);
  assert.equal(evaluateCondition('systemicStress >= 0.85', ctx), true);
  assert.equal(evaluateCondition('systemicStress < 0.5', ctx), false);
  assert.equal(evaluateCondition('vix <= 90', ctx), true);
  assert.equal(evaluateCondition('vix == 89.53', ctx), true);
  assert.equal(evaluateCondition('vix != 80', ctx), true);
});

test('表达式使用别名（liquidityMultiplier ↔ liquidity）', () => {
  const ctx = makeContext({ date: '2008-09-18', liquidity: 0.12 });
  assert.equal(evaluateCondition('liquidityMultiplier < 0.15', ctx), true);
});

test('复合条件 && 与 ||', () => {
  const ctx = makeContext({ date: '2008-09-15', vix: 80, creditSpread: 900, liquidity: 0.2 });
  assert.equal(evaluateCondition('vix > 75 && creditSpread > 800', ctx), true);
  assert.equal(evaluateCondition('vix > 90 || creditSpread > 800', ctx), true);
  assert.equal(evaluateCondition('vix > 90 && creditSpread > 800', ctx), false);
});

test('未知字段抛出可读错误', () => {
  const ctx = makeContext({ date: '2008-01-01' });
  assert.throws(() => evaluateCondition('nonsenseField > 1', ctx), /未知字段/);
});
