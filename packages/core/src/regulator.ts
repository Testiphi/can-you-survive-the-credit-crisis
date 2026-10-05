/**
 * 监管：系统性风险分（SRS）与监管阶梯 L0–L5。
 *
 * 设计立场（见 docs/03 §8.1）：监管**不是**「系统针对玩家」的惩罚。
 * 它是状态相关的、有滞后的、正反两面的，也是会误伤的。
 *
 * 玩家越成功（做空赚得越多），SRS 越高，监管越可能出手，
 * 最终在最高难度下把玩家的策略直接锁死——**玩家成为自己成功的受害者。**
 */

import type {
  Account,
  ActiveRule,
  DateStr,
  InstitutionState,
  Money,
  RegulatorLevel,
  RegulatorState,
} from './types.ts';
import { floatShares, grossExposure, netExposure } from './portfolio.ts';
import { addDays } from './time.ts';

export const SRS_WEIGHTS = {
  shortConcentration: 0.35,
  leverage: 0.2,
  fragilityExposure: 0.2,
  priceImpact: 0.25,
};

/** 触发强制披露的空头集中度门槛（历史：5% 流通股） */
export const DISCLOSURE_THRESHOLD = 0.05;

export function createRegulatorState(): RegulatorState {
  return {
    srs: 0,
    level: 0,
    rules: [],
    shortConcentration: 0,
    priceImpactShare: 0,
  };
}

export interface SrsInputs {
  account: Account;
  prices: Map<string, number>;
  institutions: Record<string, InstitutionState>;
  /** 各机构对应的可交易标的（用于估算敞口） */
  institutionToTicker: Record<string, string>;
  /** 累计的玩家冲击金额 */
  cumulativePlayerImpact: Money;
  /** 累计的市场跌幅绝对值（用于份额） */
  cumulativeMarketDecline: Money;
}

export interface SrsResult {
  srs: number;
  shortConcentration: number;
  leverageScore: number;
  fragilityScore: number;
  impactScore: number;
  leverage: number;
}

/** 计算系统性风险分。 */
export function computeSrs(inputs: SrsInputs): SrsResult {
  const { account, prices, institutions, institutionToTicker } = inputs;

  // ① 空头集中度：取全部空头持仓中「占流通股比例」最高的一个
  let maxConc = 0;
  for (const pos of account.positions.values()) {
    if (pos.quantity >= 0) continue;
    const float = floatShares(pos.instrumentId);
    if (float <= 0) continue;
    const conc = Math.abs(pos.quantity) / float;
    if (conc > maxConc) maxConc = conc;
  }

  // ② 杠杆水平
  const lev = account.equity > 0 ? grossExposure(account, prices) / account.equity : 99;
  const leverageScore = clamp01((lev - 1) / 5);

  // ③ 对问题机构的敞口
  let fragileValue = 0;
  for (const pos of account.positions.values()) {
    const p = prices.get(pos.instrumentId) ?? pos.avgPrice;
    const value = Math.abs(pos.quantity) * p;
    // 判断该标的对应的机构是否脆弱
    for (const [instId, instState] of Object.entries(institutions)) {
      if (institutionToTicker[instId] !== pos.instrumentId) continue;
      if (!instState.alive || instState.fragility > 0.75) fragileValue += value;
    }
  }
  const equity = Math.max(1, account.equity);
  const fragilityScore = clamp01(fragileValue / equity / 2);

  // ④ 市场压力贡献
  const impactScore = clamp01(
    inputs.cumulativeMarketDecline > 0
      ? inputs.cumulativePlayerImpact / inputs.cumulativeMarketDecline / 0.3
      : 0,
  );

  const shortConcScore = clamp01(maxConc / DISCLOSURE_THRESHOLD);

  const srs =
    SRS_WEIGHTS.shortConcentration * shortConcScore +
    SRS_WEIGHTS.leverage * leverageScore +
    SRS_WEIGHTS.fragilityExposure * fragilityScore +
    SRS_WEIGHTS.priceImpact * impactScore;

  return {
    srs,
    shortConcentration: maxConc,
    leverageScore,
    fragilityScore,
    impactScore,
    leverage: lev,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** SRS 加监管规则共同决定阶梯等级。 */
export function levelFromSrs(
  srs: number,
  shortConcentration: number,
  bankrupt: boolean,
  marketDown: boolean,
): RegulatorLevel {
  if (bankrupt) return 5;
  if (srs > 0.75 && marketDown) return 4;
  if (srs > 0.5) return 3;
  if (shortConcentration > DISCLOSURE_THRESHOLD) return 2;
  if (srs > 0.2) return 1;
  return 0;
}

export const LEVEL_LABEL: Record<RegulatorLevel, string> = {
  0: '无事',
  1: '监控',
  2: '强制披露',
  3: '交易限制',
  4: '紧急规则',
  5: '处置',
};

/** 清理过期规则。 */
export function expireRules(regulator: RegulatorState, date: DateStr): ActiveRule[] {
  const expired = regulator.rules.filter((r) => r.effectiveTo < date);
  regulator.rules = regulator.rules.filter((r) => r.effectiveTo >= date);
  return expired;
}

/** 添加一条规则（若同 kind + scope 已存在则延长有效期）。 */
export function addRule(
  regulator: RegulatorState,
  rule: Omit<ActiveRule, 'effectiveTo'> & { durationDays: number; date: DateStr },
): ActiveRule {
  const effectiveTo = addDays(rule.date, rule.durationDays);
  const existing = regulator.rules.find(
    (r) => r.kind === rule.kind && r.scope.join(',') === rule.scope.join(','),
  );
  if (existing) {
    if (effectiveTo > existing.effectiveTo) existing.effectiveTo = effectiveTo;
    return existing;
  }
  const created: ActiveRule = {
    id: `${rule.kind}-${rule.date}`,
    kind: rule.kind,
    scope: rule.scope,
    effectiveFrom: rule.date,
    effectiveTo,
    sourceEventId: rule.sourceEventId,
  };
  regulator.rules.push(created);
  return created;
}

/** 由阶梯等级派生的自动规则（L3 起提高保证金）。 */
export function derivedMarginMultiplier(regulator: RegulatorState): number {
  let mult = 1;
  for (const r of regulator.rules) {
    if (r.kind === 'margin_hike') mult *= 1.5;
  }
  if (regulator.level >= 3) mult *= 1.5;
  return mult;
}

/** 因规则而不可做空的标的集合。 */
export function bannedShortScope(regulator: RegulatorState): Set<string> {
  const out = new Set<string>();
  for (const r of regulator.rules) {
    if (r.kind !== 'short_ban') continue;
    for (const s of r.scope) out.add(s);
  }
  return out;
}

/** 监管阶梯对融资成本的额外压力（喂给 repo 的 marginMultiplier）。 */
export function regulatorFinancingPressure(regulator: RegulatorState): number {
  return derivedMarginMultiplier(regulator);
}

/** 面向 UI 的「市场足迹」面板数据，见 docs/03 §8.4。 */
export interface FootprintPanel {
  shortConcentration: number;
  disclosureThreshold: number;
  leverage: number;
  srs: number;
  level: RegulatorLevel;
  levelLabel: string;
  activeRules: Array<{ kind: string; scope: string[]; until: DateStr }>;
  priceImpactShare: number;
}

export function footprintPanel(
  regulator: RegulatorState,
  leverage: number,
): FootprintPanel {
  return {
    shortConcentration: regulator.shortConcentration,
    disclosureThreshold: DISCLOSURE_THRESHOLD,
    leverage,
    srs: regulator.srs,
    level: regulator.level,
    levelLabel: LEVEL_LABEL[regulator.level],
    activeRules: regulator.rules.map((r) => ({ kind: r.kind, scope: r.scope, until: r.effectiveTo })),
    priceImpactShare: regulator.priceImpactShare,
  };
}
