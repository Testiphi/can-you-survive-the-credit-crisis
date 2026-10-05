/**
 * 手动模拟：完整跑一局并把过程打到终端。
 *
 *   node packages/core/test/manual-sim.ts [seed] [difficulty]
 *
 * 这个文件同时是性能探针——如果单局跑不进几秒，说明引擎有问题。
 */

import { loadDataset } from '../src/load-node.ts';
import { GameEngine } from '../src/engine.ts';
import { LEVEL_LABEL } from '../src/regulator.ts';
import type { Difficulty } from '../src/types.ts';

const seed = Number(process.argv[2] ?? 42);
const difficulty = Number(process.argv[3] ?? 1) as Difficulty;
const strategy = process.argv[4] ?? 'cash'; // cash | short | long | short-then-long

const dataset = loadDataset();
const t0 = performance.now();

const engine = new GameEngine(dataset, {
  config: {
    seed,
    difficulty,
    identity: difficulty >= 3 ? 'bank' : difficulty >= 2 ? 'hedge_fund' : 'retail',
    timeline: 'jittered',
  },
});

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const money = (n: number) => `$${fmt(n)}`;

console.log('='.repeat(78));
console.log(`你能不能逃过信贷危机 —— 引擎模拟  seed=${seed} difficulty=D${difficulty} 策略=${strategy}`);
console.log('='.repeat(78));

let lastEventCount = 0;
let peakStress = 0;

while (!engine.isOver) {
  const date = engine.state.date;

  // ---- 策略 ----
  if (strategy !== 'cash') {
    if (new Date(date) >= new Date('2007-01-03') && engine.state.turnIndex === 1) {
      if (strategy === 'short' || strategy === 'short-then-long') {
        engine.submitByNotional('LEH', -engine.state.player.equity * 0.5);
        engine.submitByNotional('GS', -engine.state.player.equity * 0.3);
      } else if (strategy === 'long') {
        engine.submitByNotional('SPX', engine.state.player.equity * 0.8);
      }
    }
    if (strategy === 'short-then-long' && date >= '2009-03-10' && engine.state.player.positions.size > 0) {
      for (const p of [...engine.state.player.positions.values()]) {
        engine.submitOrder({
          instrumentId: p.instrumentId,
          side: p.quantity > 0 ? 'sell' : 'buy',
          quantity: Math.abs(p.quantity),
          kind: 'market',
          submittedAt: date,
        });
      }
      engine.submitByNotional('SPX', engine.state.player.equity * 0.8);
    }
  }

  const res = engine.advance();
  peakStress = Math.max(peakStress, engine.state.macro.systemicStress);

  // 每 60 个交易日或重大事件时打一行
  const newEvents = engine.state.firedEvents.length - lastEventCount;
  if (newEvents > 0 || res.turnIndex % 63 === 0 || res.marginCall) {
    const macro = engine.state.macro;
    const tag = res.firedEventIds.length > 0 ? `事件: ${res.firedEventIds.slice(0, 3).join(', ')}` : '';
    console.log(
      `${res.date}  权益 ${money(res.equity).padStart(14)}  ` +
        `SPX ${macro.spx.toFixed(0).padStart(4)}  VIX ${macro.vix.toFixed(1).padStart(5)}  ` +
        `利差 ${macro.creditSpread.toFixed(0).padStart(4)}bp  ` +
        `haircut ${(macro.repoHaircut * 100).toFixed(0).padStart(3)}%  ` +
        `压力 ${macro.systemicStress.toFixed(2)}  ` +
        `SRS ${engine.state.regulator.srs.toFixed(2)} L${engine.state.regulator.level} ` +
        `${res.marginCall ? '⚠追保 ' : ''}${tag}`,
    );
    lastEventCount = engine.state.firedEvents.length;
  }
}

const ms = performance.now() - t0;
const s = engine.summary();

console.log('-'.repeat(78));
console.log(`期末日期      ${s.date}`);
console.log(`期初资金      ${money(engine.config.initialCapital)}`);
console.log(`期末权益      ${money(s.equity)}`);
console.log(`总收益率      ${(((s.equity / engine.config.initialCapital) - 1) * 100).toFixed(2)}%`);
console.log(`最大回撤      ${(s.maxDrawdown * 100).toFixed(2)}%`);
console.log(`是否爆仓      ${s.bankrupt ? '是' : '否'}`);
console.log(`触发事件数    ${engine.state.firedEvents.length}`);
console.log(`峰值系统性压力 ${peakStress.toFixed(3)}`);
console.log(`最终监管等级  L${s.regulatorLevel} ${LEVEL_LABEL[s.regulatorLevel]}（SRS ${s.srs.toFixed(3)}）`);
console.log('-'.repeat(78));
console.log(`回合数 ${s.turnIndex}  耗时 ${ms.toFixed(0)} ms  每回合 ${(ms / Math.max(1, s.turnIndex)).toFixed(3)} ms`);
console.log('='.repeat(78));
