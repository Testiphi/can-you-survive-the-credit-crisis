import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadDataset } from '../src/load-node.ts';
import { GameEngine } from '../src/engine.ts';
import { JITTER_BY_TIMELINE } from '../src/scenario.ts';
import { shiftTradingDays, tradingDayDiff } from '../src/time.ts';
import type { GameConfig, TimelineMode } from '../src/types.ts';

const dataset = loadDataset();

function makeEngine(overrides: Partial<GameConfig> = {}, opts = {}) {
  return new GameEngine(dataset, {
    config: {
      seed: 42,
      difficulty: 1,
      identity: 'retail',
      initialCapital: 100_000,
      startDate: '2007-01-02',
      endDate: '2009-12-31',
      ...overrides,
    },
    ...opts,
  });
}

/** 跑完一局，返回「事件 id → 触发日期」。 */
function runAndCollect(timeline: TimelineMode, seed = 42): Map<string, string> {
  const e = makeEngine({ timeline, seed });
  while (!e.isOver) e.advance();
  const out = new Map<string, string>();
  for (const n of e.state.news) {
    if (n.eventId) out.set(n.eventId, n.date);
  }
  return out;
}

test('三种时间线模式的抖动幅度与文档一致', () => {
  assert.equal(JITTER_BY_TIMELINE.historical, 0);
  assert.equal(JITTER_BY_TIMELINE.jittered, 10);
  assert.equal(JITTER_BY_TIMELINE.parallel, 30);
});

test('historical 模式：事件在史实日期当天触发', () => {
  const fired = runAndCollect('historical');

  // 取几张日期明确、且历史日期本身是交易日的卡
  const expectations: Array<[string, string]> = [
    ['bnp_paribas_freeze', '2007-08-09'],
    ['bear_stearns_collapse', '2008-03-16'], // 周日 → 顺延到 03-17
    ['lehman_collapse', '2008-09-15'],
    ['sec_short_ban', '2008-09-19'],
    ['tampered_placeholder', ''],
  ].filter(([id]) => id !== 'tampered_placeholder') as Array<[string, string]>;

  for (const [id, histDate] of expectations) {
    const actual = fired.get(id);
    assert.ok(actual, `historical 模式下 ${id} 应当触发`);
    // 史实日期可能不是交易日（如 2008-03-16 是周日），顺延不超过 3 个交易日
    const drift = Math.abs(tradingDayDiff(histDate, actual!));
    assert.ok(
      actual! >= histDate && drift <= 3,
      `${id} 应在史实日期 ${histDate} 当天或紧随其后的交易日触发，实际 ${actual}（偏移 ${drift} 个交易日）`,
    );
  }
});

test('historical 模式的触发日期完全确定（不同 seed 结果相同）', () => {
  const a = runAndCollect('historical', 1);
  const b = runAndCollect('historical', 999);
  const shared = [...a.keys()].filter((k) => b.has(k));
  assert.ok(shared.length > 20, `两种 seed 应有大量共同事件，实际 ${shared.length}`);
  for (const id of shared) {
    assert.equal(a.get(id), b.get(id), `${id} 在 historical 模式下不应随 seed 变化`);
  }
});

test('jittered 模式：绝大多数事件落在史实日期 ±10 个交易日内', () => {
  const JITTER = 10;
  // 触发是概率投掷 + 因果链约束，因此必然存在尾部：
  //   · 某张卡一直没抽中，拖到后面才触发
  //   · 某张卡的前置事件迟到，它只能跟着晚
  // 所以断言的是**分布**而不是硬边界：多数落在纯抖动内，且没有离谱的拖尾。
  const HARD_MAX = 25;

  const fired = runAndCollect('jittered', 7);
  const byId = new Map(dataset.events.map((e) => [e.id, e]));

  const drifts: Array<{ id: string; drift: number }> = [];
  for (const [id, actual] of fired) {
    const card = byId.get(id);
    if (!card) continue;
    drifts.push({ id, drift: Math.abs(tradingDayDiff(card.date, actual)) });
  }

  const within = drifts.filter((d) => d.drift <= JITTER).length;
  const ratio = within / drifts.length;
  const worst = drifts.slice().sort((a, b) => b.drift - a.drift)[0];
  const avg = drifts.reduce((a, b) => a + b.drift, 0) / drifts.length;

  assert.ok(drifts.length > 25, `应检查到足够多的事件，实际 ${drifts.length}`);
  assert.ok(
    ratio >= 0.85,
    `至少 85% 应落在 ±${JITTER} 内，实际 ${(ratio * 100).toFixed(0)}%（${within}/${drifts.length}，平均 ${avg.toFixed(1)}，最大 ${worst.drift} — ${worst.id}）`,
  );
  assert.ok(
    worst.drift <= HARD_MAX,
    `最大偏移应 ≤ ${HARD_MAX} 个交易日，实际 ${worst.drift}（${worst.id}）`,
  );
  void shiftTradingDays;
});

test('parallel 模式的抖动上限放宽到 ±30 个交易日', () => {
  const fired = runAndCollect('parallel', 3);
  const byId = new Map(dataset.events.map((e) => [e.id, e]));
  for (const [id, actual] of fired) {
    const card = byId.get(id);
    if (!card || card.trigger.type === 'state') continue;
    const drift = Math.abs(tradingDayDiff(card.date, actual));
    assert.ok(drift <= 30, `${id} 的抖动应在 ±30 个交易日内，实际 ${drift}`);
  }
});

test('抖动幅度可通过 EngineOptions 覆盖', () => {
  const e = makeEngine({ timeline: 'jittered' }, { jitterDays: 0 });
  while (!e.isOver) e.advance();
  const news = new Map(e.state.news.filter((n) => n.eventId).map((n) => [n.eventId!, n.date]));
  const lehman = news.get('lehman_collapse');
  assert.equal(lehman, '2008-09-15', `覆盖为零抖动后雷曼应在史实日期触发，实际 ${lehman}`);
});

test('historical 模式下核心叙事事件仍然全部发生', () => {
  const fired = runAndCollect('historical');
  for (const id of [
    'bnp_paribas_freeze',
    'bear_stearns_collapse',
    'gse_conservatorship',
    'lehman_collapse',
    'aig_bailout',
    'sec_short_ban',
    'citigroup_bailout',
    'sp500_bottom_666',
    'citi_profit_announcement',
  ]) {
    assert.ok(fired.has(id), `historical 模式下 ${id} 必须触发`);
  }
});
