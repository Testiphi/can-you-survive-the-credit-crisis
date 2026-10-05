/**
 * 机构脆弱度与竞争风险模型。
 *
 * 核心思想（见 docs/05）：**谁先倒下不是随机洗牌决定的，而是从机构脆弱度中涌现的。**
 * 随机性作用于「谁先撑不住」，而不是「凭空指定谁先死」。
 */

import type {
  Institution,
  InstitutionState,
  InstitutionsFile,
  FragilityWeights,
  HazardModel,
  MacroState,
} from './types.ts';

/** 归一化区间，用于把量纲不同的资产负债表指标放在同一尺度上。 */
const NORM_RANGES = {
  leverage: [5, 55],
  repoDependence: [0, 0.8],
  counterpartyExposure: [0, 1],
  capitalBuffer: [0, 1],
} as const;

function normalize(v: number, [lo, hi]: readonly [number, number]): number {
  return Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
}

/** 机构的初始状态。 */
export function initInstitutionStates(file: InstitutionsFile): Record<string, InstitutionState> {
  const out: Record<string, InstitutionState> = {};
  for (const inst of file.institutions) {
    out[inst.id] = {
      id: inst.id,
      fragility: inst.fragility0,
      confidence: inst.confidence0,
      alive: true,
    };
  }
  return out;
}

/**
 * 由机构的静态属性与当前市场状态计算脆弱度。
 *
 * F = w1·norm(leverage) + w2·norm(repoDependence) + w3·assetImpairment
 *   + w4·(1 − confidence) + w5·norm(counterpartyExposure) + w6·norm(capitalBuffer)
 *
 * 注意 w6（资本缓冲）在配置文件里是负数——缓冲越厚，脆弱度越低。
 */
export function computeFragility(
  inst: Institution,
  state: InstitutionState,
  weights: FragilityWeights,
  stress: number,
): number {
  const assetImpairment = Math.min(1, inst.assetImpairment * (1 + 0.6 * stress));

  const raw =
    weights.leverage * normalize(inst.leverage, NORM_RANGES.leverage) +
    weights.repoDependence * normalize(inst.repoDependence, NORM_RANGES.repoDependence) +
    weights.assetImpairment * assetImpairment +
    weights.confidenceDeficit * (1 - state.confidence) +
    weights.counterpartyExposure * normalize(inst.counterpartyExposure, NORM_RANGES.counterpartyExposure) +
    weights.capitalBuffer * normalize(inst.capitalBuffer, NORM_RANGES.capitalBuffer);

  return Math.max(0, raw);
}

/** 全表平均脆弱度与标准差——竞争风险模型的分母。 */
export function fragilityStats(states: Record<string, InstitutionState>): {
  mean: number;
  sigma: number;
} {
  const values = Object.values(states).filter((s) => s.alive).map((s) => s.fragility);
  if (values.length === 0) return { mean: 0, sigma: 1 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, sigma: Math.max(0.02, Math.sqrt(variance)) };
}

/**
 * 单个机构在给定交易日的失败风险率。
 *
 * hazard_i = baseHazard × exp(κ·(F_i − F̄)/σ_F) × 系统性压力因子
 *
 * κ 越大越接近历史顺序，越小越接近随机。见 docs/05 §2.2。
 */
export function failureHazard(
  state: InstitutionState,
  stats: { mean: number; sigma: number },
  stress: number,
  model: HazardModel,
  kappaOverride?: number,
): number {
  const kappa = kappaOverride ?? model.kappa;
  const z = (state.fragility - stats.mean) / stats.sigma;
  // 压力因子：保证平静期有基础风险，危机期成倍放大
  const stressFactor = 0.15 + 1.7 * stress;
  return model.baseHazard * Math.exp(kappa * z) * stressFactor;
}

/**
 * 竞争风险抽样：在多个候选机构之间决定「今天谁倒下」。
 *
 * 用指数分布竞速（exponential race）：每个候选机构采一个到达时间，
 * 最早的那个获胜。这等价于「风险率越高，越可能先发生」。
 *
 * @returns 获胜机构的 id，或 null（今天没人倒下）
 */
export function raceForFailure(
  candidates: Array<{ id: string; hazard: number }>,
  exponential: (rate: number) => number,
): string | null {
  let bestId: string | null = null;
  let bestTime = Infinity;
  for (const c of candidates) {
    if (c.hazard <= 0) continue;
    const t = exponential(c.hazard);
    if (t < bestTime) {
      bestTime = t;
      bestId = c.id;
    }
  }
  return bestId;
}

/** 事件卡 affectsFragility 的应用。支持 'all_financials' 伪键。 */
export function applyFragilityDelta(
  states: Record<string, InstitutionState>,
  file: InstitutionsFile,
  deltas: Record<string, number> | undefined,
): void {
  if (!deltas) return;
  const financialIds = file.institutions
    .filter((i) => i.tier === 'investment_bank' || i.tier === 'commercial_bank')
    .map((i) => i.id);

  for (const [key, delta] of Object.entries(deltas)) {
    if (key === 'all_financials') {
      for (const id of financialIds) {
        if (states[id]) states[id].fragility = Math.max(0, states[id].fragility + delta);
      }
      continue;
    }
    if (states[key]) {
      states[key].fragility = Math.max(0, states[key].fragility + delta);
    }
  }
}

/** 市场信心随压力下降（顺周期变量）。 */
export function updateConfidence(
  states: Record<string, InstitutionState>,
  macro: MacroState,
): void {
  const decay = 0.02 + 0.08 * macro.systemicStress;
  for (const s of Object.values(states)) {
    if (!s.alive) continue;
    s.confidence = Math.max(0.05, s.confidence - decay * macro.systemicStress);
  }
}

/** 标记机构失败。 */
export function markFailed(
  states: Record<string, InstitutionState>,
  id: string,
  date: string,
  mode: string,
): void {
  const s = states[id];
  if (!s) return;
  s.alive = false;
  s.failedOn = date;
  s.failureMode = mode;
  s.confidence = 0;
}
