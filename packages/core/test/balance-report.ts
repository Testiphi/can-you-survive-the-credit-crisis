/**
 * 平衡报告：跑多局，统计事件触发率、策略机器人净值分布。
 *
 *   node packages/core/test/balance-report.ts [局数] [难度]
 *
 * 这是 docs/02 §9.2 承诺的「策略机器人池」的雏形——
 * 唯一能客观回答「这个游戏是不是只有一个解」的方法。
 */

import { loadDataset } from '../src/load-node.ts';
import { GameEngine } from '../src/engine.ts';
import type { Difficulty, Order } from '../src/types.ts';

const RUNS = Number(process.argv[2] ?? 20);
const DIFFICULTY = Number(process.argv[3] ?? 1) as Difficulty;

const dataset = loadDataset();

type Strategy = 'cash' | 'long' | 'short' | 'short-then-long' | 'random';

function decide(strategy: Strategy, engine: GameEngine, seed: number): Order[] {
  const date = engine.state.date;
  const t = engine.state.turnIndex;
  const equity = engine.state.player.equity;
  const orders: Order[] = [];

  const flatten = () => {
    for (const p of [...engine.state.player.positions.values()]) {
      orders.push({
        instrumentId: p.instrumentId,
        side: p.quantity > 0 ? 'sell' : 'buy',
        quantity: Math.abs(p.quantity),
        kind: 'market',
        submittedAt: date,
      });
    }
  };

  if (strategy === 'cash') return orders;

  if (strategy === 'long') {
    if (t === 1) orders.push({ instrumentId: 'SPX', side: 'buy', quantity: Math.floor((equity * 0.8) / engine.state.prices.get('SPX')!), kind: 'market', submittedAt: date });
    return orders;
  }
  if (strategy === 'short') {
    if (t === 1) {
      orders.push({ instrumentId: 'LEH', side: 'sell', quantity: Math.floor((equity * 0.5) / engine.state.prices.get('LEH')!), kind: 'market', submittedAt: date });
      orders.push({ instrumentId: 'GS', side: 'sell', quantity: Math.floor((equity * 0.3) / engine.state.prices.get('GS')!), kind: 'market', submittedAt: date });
    }
    return orders;
  }
  if (strategy === 'short-then-long') {
    if (t === 1) {
      orders.push({ instrumentId: 'LEH', side: 'sell', quantity: Math.floor((equity * 0.5) / engine.state.prices.get('LEH')!), kind: 'market', submittedAt: date });
      orders.push({ instrumentId: 'GS', side: 'sell', quantity: Math.floor((equity * 0.3) / engine.state.prices.get('GS')!), kind: 'market', submittedAt: date });
    }
    if (date >= '2009-03-10' && engine.state.player.positions.size > 0 && t < 560) {
      flatten();
      orders.push({ instrumentId: 'SPX', side: 'buy', quantity: Math.floor((equity * 0.8) / engine.state.prices.get('SPX')!), kind: 'market', submittedAt: date });
    }
    return orders;
  }
  // random
  if (t % 20 === 0) {
    const ids = ['LEH', 'GS', 'C', 'AIG', 'MER'];
    const id = ids[(seed + t) % ids.length];
    const price = engine.state.prices.get(id)!;
    const side = (seed + t) % 2 === 0 ? 'buy' : 'sell';
    orders.push({ instrumentId: id, side, quantity: Math.floor((equity * 0.2) / price), kind: 'market', submittedAt: date });
  }
  return orders;
}

const strategies: Strategy[] = ['cash', 'long', 'short', 'short-then-long', 'random'];
const results: Record<string, number[]> = {};
const eventCount: Record<string, number> = {};
const failCount: Record<string, number> = {};
let zeroShareDecisions = 0;

const t0 = performance.now();

for (const strategy of strategies) {
  results[strategy] = [];
  for (let seed = 0; seed < RUNS; seed++) {
    const engine = new GameEngine(dataset, {
      config: { seed, difficulty: DIFFICULTY, timeline: 'jittered' },
    });
    while (!engine.isOver) {
      for (const o of decide(strategy, engine, seed)) {
        // 预算不足一股时观望；其他非法数值仍交给引擎拒绝，不能掩盖策略错误。
        if (o.quantity === 0) { zeroShareDecisions++; continue; }
        engine.submitOrder(o);
      }
      engine.advance();
    }
    results[strategy].push(engine.state.player.equity / engine.config.initialCapital - 1);
    if (strategy === 'cash') {
      for (const id of engine.state.firedEvents) eventCount[id] = (eventCount[id] ?? 0) + 1;
      for (const [id, s] of Object.entries(engine.state.institutions)) {
        if (!s.alive) failCount[id] = (failCount[id] ?? 0) + 1;
      }
    }
  }
}

const ms = performance.now() - t0;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

console.log('='.repeat(78));
console.log(`平衡报告  ${RUNS} 局/策略  难度 D${DIFFICULTY}  共 ${RUNS * strategies.length} 局`);
console.log('='.repeat(78));
console.log('\n【策略机器人净收益率分布】\n');
console.log('策略'.padEnd(20) + '中位数'.padStart(10) + '均值'.padStart(10) + '最差'.padStart(10) + '最好'.padStart(10) + '爆仓率'.padStart(10));

for (const s of strategies) {
  const arr = [...results[s]].sort((a, b) => a - b);
  const median = arr[Math.floor(arr.length / 2)];
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const bankrupt = arr.filter((v) => v <= -0.99).length / arr.length;
  console.log(
    s.padEnd(20) +
      pct(median).padStart(10) +
      pct(mean).padStart(10) +
      pct(arr[0]).padStart(10) +
      pct(arr[arr.length - 1]).padStart(10) +
      pct(bankrupt).padStart(10),
  );
}

console.log('\n【机构失败频率】\n');
const fails = Object.entries(failCount).sort((a, b) => b[1] - a[1]);
console.log(fails.map(([id, n]) => `${id} ${n}/${RUNS}`).join('  ·  '));

console.log('\n【从未触发的事件卡】\n');
const never = dataset.events.filter((e) => !eventCount[e.id]);
console.log(`共 ${never.length} / ${dataset.events.length} 张从未触发`);
if (never.length > 0) {
  for (const e of never.slice(0, 40)) console.log(`  ${e.date}  ${e.id.padEnd(34)} ${e.trigger.type}`);
}

console.log('\n【触发率最低的 12 张】\n');
const rates = dataset.events
  .map((e) => ({ id: e.id, n: eventCount[e.id] ?? 0, total: RUNS }))
  .sort((a, b) => a.n - b.n)
  .slice(0, 12);
for (const r of rates) console.log(`  ${r.id.padEnd(34)} ${r.n}/${r.total}`);

console.log(`\n不足一股而观望的决策：${zeroShareDecisions}`);
console.log(`\n总耗时 ${(ms / 1000).toFixed(1)}s  单局 ${(ms / (RUNS * strategies.length)).toFixed(0)} ms`);
console.log('='.repeat(78));
