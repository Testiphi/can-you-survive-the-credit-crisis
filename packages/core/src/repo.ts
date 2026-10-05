/**
 * 回购与融资机制（见 docs/07）。
 *
 * 这是本作最核心的机制：**杀死机构的不是股价下跌，是融资断裂。**
 *
 * 玩家的融资容量 = 多头持仓 × (1 − haircut)。
 * haircut 上升 → 容量下降 → 出现缺口 → 被迫卖出。
 */

import type { Account, Identity, MacroState, Money } from './types.ts';
import { grossLongValue } from './portfolio.ts';

/** 各身份对回购融资的依赖度。散户不依赖回购，所以这条机制对 D0 完全不激活。 */
const REPO_DEPENDENCE: Record<Identity, number> = {
  retail: 0,
  hedge_fund: 0.5,
  bank: 0.6,
  insurer: 0.55,
};

export interface RepoState {
  /** 当前加权回购折扣率 */
  haircut: number;
  /** 展期率 0..1 */
  rolloverRate: number;
  /** 融资容量 */
  capacity: Money;
  /** 已用融资 */
  used: Money;
  /** 今日到期 */
  maturing: Money;
  /** 今日融资缺口（正数表示缺口） */
  shortfall: Money;
  /** 是否因缺口而触发被迫卖出 */
  forcedSale: boolean;
}

/**
 * 玩家的展期率（见 docs/07 §5.3）。
 *
 * 注意最后三项：杠杆越高、SRS 越高，你的融资就越贵。
 * 这让「资金过大」的惩罚不只是监管，还有更贵的钱。
 */
export function playerRolloverRate(
  stress: number,
  lev: number,
  srs: number,
  hasDefaulted = false,
): number {
  const leverageExcess = Math.max(0, lev - 2) / 5;
  const raw =
    0.95 -
    0.4 * stress -
    0.3 * leverageExcess -
    0.25 * srs +
    (hasDefaulted ? 0 : 0.1);
  return Math.min(1, Math.max(0.05, raw));
}

export interface RepoParams {
  identity: Identity;
  difficulty: number;
  /** 规则导致的保证金/融资紧缩倍数 */
  marginMultiplier?: number;
}

/** 是否对玩家启用回购机制。D0/D1 与散户身份不启用。 */
export function repoEnabled(params: RepoParams): boolean {
  if (params.identity === 'retail' && params.difficulty < 2) return false;
  return REPO_DEPENDENCE[params.identity] > 0 && params.difficulty >= 2;
}

/**
 * 计算本回合的回购状况。
 *
 * 缺口来源有两处：
 *   ① 到期部分未能全额展期（挤兑）
 *   ② 融资容量本身收缩到低于已用额度（haircut 跳升）
 */
export function computeRepoState(
  account: Account,
  prices: Map<string, number>,
  macro: MacroState,
  lev: number,
  srs: number,
  params: RepoParams,
): RepoState {
  const haircut = macro.repoHaircut;
  const rolloverRate = playerRolloverRate(macro.systemicStress, lev, srs);

  if (!repoEnabled(params)) {
    return {
      haircut,
      rolloverRate,
      capacity: 0,
      used: 0,
      maturing: 0,
      shortfall: 0,
      forcedSale: false,
    };
  }

  const longValue = grossLongValue(account, prices);
  const dependence = REPO_DEPENDENCE[params.identity];
  const used = longValue * dependence;
  const capacity = longValue * (1 - haircut) * (params.marginMultiplier ? 1 / params.marginMultiplier : 1);

  const maturing = used;
  const rolled = maturing * rolloverRate;
  const rolloverGap = maturing - rolled; // ① 挤兑
  const capacityGap = Math.max(0, used - capacity); // ② haircut 跳升

  const shortfall = Math.max(0, rolloverGap + capacityGap);

  return {
    haircut,
    rolloverRate,
    capacity,
    used,
    maturing,
    shortfall,
    forcedSale: shortfall > 0,
  };
}

/**
 * 把回购缺口转换成被迫卖出的指令（金额）。
 * 这是「融资断裂 → 火售 → 价格下跌 → haircut 上升」螺旋的一环（见 docs/07 §5）。
 */
export function forcedSaleNotional(state: RepoState, slippageBuffer = 1.3): Money {
  return state.shortfall * slippageBuffer;
}
