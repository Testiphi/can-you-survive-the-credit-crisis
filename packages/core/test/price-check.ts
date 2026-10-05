/**
 * 价格模型 sanity check。
 *
 *   node packages/core/test/price-check.ts [局数] [难度]
 *
 * 这个工具的存在理由：价格模型曾经有一组互相叠加的错误，
 * 导致金融股在 2007 年年中就全部穿零（高盛 $0.01），
 * 而**所有单元测试依然是绿的**——因为测试断言的是「机制」，不是「量级」。
 *
 * 检查内容：
 *   ① 标普路径是否贴合历史锚点（每个 seed 都必须成立——它由锚点驱动，离散度低）
 *   ② 该死的必须死（雷曼、贝尔斯登的归零必须在每个 seed 成立）
 *   ③ 幸存者不能被打死（用**中位数**判断——个股特质波动大，单 seed 断言没有意义）
 */

import { loadDataset } from '../src/load-node.ts';
import { GameEngine } from '../src/engine.ts';

const RUNS = Number(process.argv[2] ?? 12);
const DIFFICULTY = Number(process.argv[3] ?? 1) as 0 | 1 | 2 | 3;

const dataset = loadDataset();

const MARK_DATES = ['2007-10-09', '2008-11-20', '2009-03-09', '2009-12-31'];
const IDS = ['SPX', 'GS', 'JPM', 'LEH', 'BSC', 'C', 'AIG'];

const samples: Record<string, number[][]> = {};
for (const id of IDS) samples[id] = MARK_DATES.map(() => []);

const perSeed: Array<{ seed: number; spx: Record<string, number> }> = [];

for (let seed = 0; seed < RUNS; seed++) {
  const e = new GameEngine(dataset, { config: { seed, difficulty: DIFFICULTY, timeline: 'jittered' } });
  while (!e.isOver) e.advance();

  const spxRow: Record<string, number> = {};
  for (const id of IDS) {
    const bars = e.state.bars.get(id)!;
    MARK_DATES.forEach((d, i) => {
      const bar = bars.find((b) => b.date === d);
      const v = bar ? bar.close : (e.state.prices.get(id) ?? 0);
      samples[id][i].push(v);
      if (id === 'SPX') spxRow[d] = v;
    });
  }
  perSeed.push({ seed, spx: spxRow });
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function min(xs: number[]): number {
  return Math.min(...xs);
}
function max(xs: number[]): number {
  return Math.max(...xs);
}
function fmt(v: number): string {
  return v.toFixed(2).padStart(10);
}

console.log(`价格模型检查  ${RUNS} 局  D${DIFFICULTY}`);
console.log('');
console.log('日期'.padEnd(12) + IDS.map((i) => i.padStart(10)).join(''));
for (let i = 0; i < MARK_DATES.length; i++) {
  console.log(MARK_DATES[i].padEnd(12) + IDS.map((id) => fmt(median(samples[id][i]))).join(''));
}
console.log('');
console.log('（上表为各标的中位数）');

// ---- 断言 ----
const failures: string[] = [];
const check = (cond: boolean, msg: string) => {
  if (!cond) failures.push(msg);
};

// ① 标普锚点：每个 seed 都必须成立
const spxPeak = samples['SPX'][0];
const spxTrough = samples['SPX'][2];
const spxEnd = samples['SPX'][3];
check(min(spxPeak) > 1350 && max(spxPeak) < 1800, `SPX 2007-10-09 越界: ${min(spxPeak).toFixed(0)}–${max(spxPeak).toFixed(0)}`);
check(min(spxTrough) > 520 && max(spxTrough) < 900, `SPX 2009-03-09 越界: ${min(spxTrough).toFixed(0)}–${max(spxTrough).toFixed(0)}`);
check(min(spxEnd) > 880 && max(spxEnd) < 1350, `SPX 2009-12-31 越界: ${min(spxEnd).toFixed(0)}–${max(spxEnd).toFixed(0)}`);

// ② 该死的必须死（每个 seed）
check(max(samples['LEH'][2]) < 8, `雷曼崩盘后应接近归零，最大 ${max(samples['LEH'][2]).toFixed(2)}`);
check(max(samples['LEH'][3]) < 1, `雷曼破产一年后仍应接近归零，最大 ${max(samples['LEH'][3]).toFixed(2)}`);
check(max(samples['BSC'][2]) < 40, `贝尔斯登应已消失，最大 ${max(samples['BSC'][2]).toFixed(2)}`);
check(max(samples['BSC'][3]) < 5, `贝尔斯登被收购后应接近归零，最大 ${max(samples['BSC'][3]).toFixed(2)}`);

// ③ 幸存者：中位数判断
const med = (id: string, i: number) => median(samples[id][i]);
check(med('GS', 3) > 40, `高盛期末中位数应 > 40，实际 ${med('GS', 3).toFixed(2)}`);
check(med('JPM', 3) > 8, `摩根大通期末中位数应 > 8，实际 ${med('JPM', 3).toFixed(2)}`);
check(med('C', 3) > 1, `花旗期末中位数应 > 1，实际 ${med('C', 3).toFixed(2)}`);
check(med('GS', 0) < 450, `高盛 2007 高点中位数应 < 450，实际 ${med('GS', 0).toFixed(2)}`);

// ④ 离散度提示（不判失败，只报告）
console.log('');
console.log('个股路径离散度（期末，最小–最大）：');
for (const id of IDS) {
  const xs = samples[id][3];
  console.log(`  ${id.padEnd(5)} ${min(xs).toFixed(2).padStart(8)} – ${max(xs).toFixed(2).padStart(8)}`);
}

console.log('');
if (failures.length > 0) {
  console.log(`✖ ${failures.length} 项检查未通过:`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log('✓ 全部量级检查通过');
