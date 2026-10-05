/**
 * 宏观环境生成。
 *
 * 基础路径来自历史锚点（对数线性插值），叠加种子化噪声。
 * 宏观指标（信用利差、VIX、TED、流动性、回购折扣率）由一条「压力曲线」驱动。
 *
 * ⚠️ 当前锚点为设计校准值，用于让 P0 原型立刻可玩。
 *    真实数据接入后（data/pipeline），本模块的锚点表将被 data/processed/*.json 替换。
 *    见 docs/04 §1.4。
 */

import type { DateStr, MacroState } from './types.ts';
import { parseDate, tradingDaysBetween } from './time.ts';

/** 标普 500 历史锚点（真实收盘价）。 */
export const SPX_ANCHORS: Array<[DateStr, number]> = [
  ['2007-01-03', 1416.6],
  ['2007-02-27', 1399.04],
  ['2007-06-04', 1539.18],
  ['2007-08-15', 1406.7],
  ['2007-10-09', 1565.15], // 历史最高点
  ['2008-01-22', 1310.5],
  ['2008-03-10', 1273.37],
  ['2008-05-19', 1426.63],
  ['2008-09-12', 1251.7],
  ['2008-10-10', 899.22], // 最惨烈的一周
  ['2008-11-20', 752.44], // 第一低点
  ['2009-03-09', 676.53], // 真正的底
  ['2009-06-01', 942.87],
  ['2009-10-09', 1071.49],
  ['2009-12-31', 1115.1],
];

/** 美国高收益债期权调整利差（bp），锚定 FRED BAMLH0A0HYM2 的历史形态。 */
export const CREDIT_SPREAD_ANCHORS: Array<[DateStr, number]> = [
  ['2007-01-03', 290],
  ['2007-06-01', 245],
  ['2007-07-27', 370],
  ['2007-08-16', 430],
  ['2007-11-30', 520],
  ['2008-01-31', 700],
  ['2008-03-17', 800],
  ['2008-06-30', 750],
  ['2008-09-15', 1080],
  ['2008-10-10', 1750],
  ['2008-12-15', 2100], // 峰值
  ['2009-03-09', 1800],
  ['2009-06-01', 950],
  ['2009-12-31', 700],
];

/** VIX 锚点（收盘）。历史收盘峰值为 2008-11-20 的 80.86。 */
export const VIX_ANCHORS: Array<[DateStr, number]> = [
  ['2007-01-03', 12.4],
  ['2007-07-27', 21.0],
  ['2007-08-16', 30.8],
  ['2007-11-12', 31.1],
  ['2008-01-22', 31.0],
  ['2008-03-17', 32.2],
  ['2008-05-19', 17.0],
  ['2008-09-15', 31.7],
  ['2008-10-24', 79.1], // 盘中 89.53
  ['2008-11-20', 80.86], // 历史收盘峰值
  ['2009-03-09', 49.7],
  ['2009-06-01', 30.0],
  ['2009-12-31', 21.7],
];

/** TED 利差（百分点）。历史峰值 2008-10-10 的 4.58。 */
export const TED_ANCHORS: Array<[DateStr, number]> = [
  ['2007-01-03', 0.35],
  ['2007-07-27', 0.80],
  ['2007-08-16', 1.40],
  ['2007-12-12', 1.60],
  ['2008-03-17', 1.55],
  ['2008-06-30', 1.05],
  ['2008-09-15', 2.00],
  ['2008-10-10', 4.58], // 峰值
  ['2008-11-20', 2.20],
  ['2009-01-15', 1.20],
  ['2009-03-09', 1.05],
  ['2009-06-01', 0.50],
  ['2009-12-31', 0.20],
];

/** 对数线性插值，用于在锚点之间平滑过渡。 */
function interpLog(anchors: Array<[DateStr, number]>, date: DateStr): number {
  if (date <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (date >= last[0]) return last[1];

  for (let i = 0; i < anchors.length - 1; i++) {
    const [d0, v0] = anchors[i];
    const [d1, v1] = anchors[i + 1];
    if (date >= d0 && date <= d1) {
      const t0 = parseDate(d0).getTime();
      const t1 = parseDate(d1).getTime();
      const w = (parseDate(date).getTime() - t0) / (t1 - t0);
      // 指数插值：保证价格路径平滑且不穿负
      return v0 * Math.pow(v1 / v0, w);
    }
  }
  return last[1];
}

function normalize(v: number, lo: number, hi: number): number {
  return Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
}

/**
 * 系统性压力（0..1）。
 * 同时驱动：haircut、展期率、NPC 风险偏好、事件卡的 state 触发器。
 *
 * 归一化上界刻意高于历史峰值——否则压力会长期贴着 1.0 饱和，
 * 让分段阶跃（haircut）失去分辨率。
 */
export function systemicStress(creditSpread: number, tedSpread: number, vix: number): number {
  const c = normalize(creditSpread, 250, 2600);
  const t = normalize(tedSpread, 0.2, 5.0);
  const v = normalize(vix, 12, 95);
  return Math.min(1, 0.4 * c + 0.3 * t + 0.3 * v);
}

/**
 * 回购折扣率的分段阶跃（见 docs/07 §4.3）。
 *
 * 刻意使用阶跃而非连续函数：平滑演化会让玩家产生「可以慢慢应对」的错觉，
 * 阶跃制造的是「一夜之间缺口出现」的真实恐惧。
 */
export function haircutFromStress(stress: number, base = 0.05): number {
  if (stress < 0.3) return base;
  if (stress < 0.5) return base + 0.15;
  if (stress < 0.7) return base + 0.4;
  return Math.min(1, base + 0.75);
}

/** 市场整体展期率。危机中可低至 0.2 以下（见 docs/07 §4.2）。 */
export function marketRolloverRate(stress: number): number {
  return Math.min(1, Math.max(0.05, 1 - 1.8 * stress));
}

export interface MacroScheduleOptions {
  /** 噪声强度倍率，0 = 完全按历史锚点 */
  noiseScale?: number;
  /**
   * 真实标普收盘价序列（按交易日）。
   *
   * 提供时用它替代锚点插值作为基础路径——这是数据管道接入后的主路径。
   * 此时**不再叠加锚点噪声**：真实数据本身就是历史，
   * 再加一层 ±0.4% 的日噪声只会让标普偏离事实。
   */
  spxSeries?: Map<string, number>;
}

/**
 * 生成完整交易日的宏观序列。
 * 这是「基础路径」——事件冲击由 scenario 模块叠加在其之上。
 */
export function buildMacroSeries(
  startDate: DateStr,
  endDate: DateStr,
  noise: { normal: () => number },
  options: MacroScheduleOptions = {},
): MacroState[] {
  const scale = options.noiseScale ?? 1;
  const days = tradingDaysBetween(startDate, endDate);
  const out: MacroState[] = [];
  const real = options.spxSeries;

  for (const date of days) {
    const realClose = real?.get(date);
    const spxBase = realClose ?? interpLog(SPX_ANCHORS, date);
    const credit = interpLog(CREDIT_SPREAD_ANCHORS, date);
    const vix = interpLog(VIX_ANCHORS, date);
    const ted = interpLog(TED_ANCHORS, date);

    // 指标自身的日噪声：不改变趋势，只让读数跳动
    const creditN = credit * (1 + 0.05 * scale * noise.normal());
    const vixN = Math.max(9, vix * (1 + 0.07 * scale * noise.normal()));
    const tedN = Math.max(0.05, ted * (1 + 0.06 * scale * noise.normal()));
    // 真实路径不加噪声；只有锚点插值时才加，否则会出现折点
    const spxN = realClose !== undefined ? spxBase : spxBase * (1 + 0.004 * scale * noise.normal());

    const stress = systemicStress(creditN, tedN, vixN);

    out.push({
      date,
      spx: spxN,
      vix: vixN,
      creditSpread: creditN,
      tedSpread: tedN,
      liquidity: Math.min(1, Math.max(0.05, 1 - 0.95 * stress)),
      repoHaircut: haircutFromStress(stress),
      systemicStress: stress,
    });
  }

  return out;
}

// ---------------------------------------------------------------- 权重与阈值

/** 难度参数。数值随难度上升表示「市场更恶意」。 */
export const DIFFICULTY_PROFILE = {
  0: { noiseScale: 0.0, impactEta: 0, capacityFloor: 1.0, hazardKappa: 1.2, newsNoise: 0.14 },
  1: { noiseScale: 0.5, impactEta: 0.5, capacityFloor: 0.6, hazardKappa: 1.2, newsNoise: 0.16 },
  2: { noiseScale: 1.0, impactEta: 0.8, capacityFloor: 0.25, hazardKappa: 1.0, newsNoise: 0.18 },
  3: { noiseScale: 1.4, impactEta: 1.0, capacityFloor: 0.1, hazardKappa: 0.6, newsNoise: 0.2 },
} as const;
