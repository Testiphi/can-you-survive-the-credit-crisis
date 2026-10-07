/**
 * 账户、保证金与强平。
 *
 * 会计恒等式：equity = cash + Σ (qty × price) − 未偿借款本金与应计利息
 * 做空不会创造权益：卖空 100 股 @10 → cash +1000，持仓 -100，equity 不变。
 */

import type { Account, Fill, Money, Position, Ratio } from './types.ts';
import { INSTRUMENT_BY_ID } from './instruments.ts';

export const DEFAULT_MARGIN_RATE = 0.25;
/** 做空的维持保证金率更高 */
export const SHORT_MARGIN_RATE = 0.3;
/** 清算容差，避免浮点误差导致「差一分钱被强平」（见 docs/02 §9.3） */
export const MARGIN_EPSILON = 1e-6;

export function loanLiabilities(account: Account): Money {
  return (account.loans ?? []).reduce((sum, loan) => sum + loan.principal + loan.accruedInterest, 0);
}

export function createAccount(initialCapital: Money): Account {
  return {
    cash: initialCapital,
    positions: new Map<string, Position>(),
    equity: initialCapital,
    repoCapacity: 0,
    repoUsed: 0,
    repoRolloverRate: 1,
    marginRequirement: 0,
    maintenanceMargin: 0,
    marginCall: false,
    peakEquity: initialCapital,
    maxDrawdown: 0,
    bankrupt: false,
  };
}

/** 应用一笔成交，更新现金与持仓。 */
export function applyFill(account: Account, fill: Fill, date: string): void {
  if (fill.quantity <= 0) return;
  const id = fill.order.instrumentId;
  const signedQty = fill.order.side === 'buy' ? fill.quantity : -fill.quantity;

  const existing = account.positions.get(id);
  if (!existing) {
    account.positions.set(id, {
      instrumentId: id,
      quantity: signedQty,
      avgPrice: fill.price,
      openedAt: date,
      borrowFeeRate: signedQty < 0 ? 0.005 : 0,
    });
  } else {
    const newQty = existing.quantity + signedQty;
    if (newQty === 0) {
      // 完全平仓
      account.positions.delete(id);
    } else if (existing.quantity * newQty < 0) {
      // 穿越零：反向开仓，成本重置为本次成交价
      existing.quantity = newQty;
      existing.avgPrice = fill.price;
      existing.openedAt = date;
      existing.borrowFeeRate = newQty < 0 ? 0.005 : 0;
    } else if (Math.abs(newQty) > Math.abs(existing.quantity)) {
      // 同向**加仓**：加权平均更新成本
      const totalCost =
        existing.avgPrice * Math.abs(existing.quantity) + fill.price * Math.abs(signedQty);
      existing.avgPrice = totalCost / Math.abs(newQty);
      existing.quantity = newQty;
    } else {
      // 同向**减仓**（部分平仓）：成本价不变。实现的盈亏通过现金体现。
      //
      // 这个分支是必需的，不能和「加仓」合并。早前只判断了同号/异号，
      // 于是部分平仓也走进了加权平均公式——把**卖掉**的数量当成买入算进成本：
      //
      //     avg' = (avg×100 + price×30) / 70        （100 股里卖了 30 股）
      //          = avg×1.4286 + price×0.4286
      //
      // 价格接近成本时，每部分平仓一次均价就乘上约 1.857。玩家反复用
      // 「做空 25%」减仓，8 次之后成本就从 $1400 涨到 $201,934——
      // 盈亏比例随之爆炸。
      existing.quantity = newQty;
    }
  }

  // 现金流：买入付出，卖出收到
  account.cash -= signedQty * fill.price;
  account.cash -= fill.commission;
}

/** 盯市：更新权益、峰值与最大回撤。 */
export function markToMarket(account: Account, prices: Map<string, number>): void {
  let positionsValue = 0;
  for (const pos of account.positions.values()) {
    const p = prices.get(pos.instrumentId);
    if (p === undefined) continue;
    positionsValue += pos.quantity * p;
  }
  account.equity = account.cash + positionsValue - loanLiabilities(account);

  const performanceEquity = account.equity + (account.distributedCapital ?? 0);
  if (performanceEquity > account.peakEquity) account.peakEquity = performanceEquity;
  if (account.peakEquity > 0) {
    const dd = 1 - performanceEquity / account.peakEquity;
    if (dd > account.maxDrawdown) account.maxDrawdown = dd;
  }
  if (account.equity <= 0) account.bankrupt = true;
}

/** 总多头敞口（用于回购容量）。 */
export function grossLongValue(account: Account, prices: Map<string, number>): Money {
  let v = 0;
  for (const pos of account.positions.values()) {
    if (pos.quantity <= 0) continue;
    const p = prices.get(pos.instrumentId) ?? pos.avgPrice;
    v += pos.quantity * p;
  }
  return v;
}

/** 总敞口绝对值（用于杠杆计算）。 */
export function grossExposure(account: Account, prices: Map<string, number>): Money {
  let v = 0;
  for (const pos of account.positions.values()) {
    const p = prices.get(pos.instrumentId) ?? pos.avgPrice;
    v += Math.abs(pos.quantity) * p;
  }
  return v;
}

/** 净敞口（正=偏多）。 */
export function netExposure(account: Account, prices: Map<string, number>): Money {
  let v = 0;
  for (const pos of account.positions.values()) {
    const p = prices.get(pos.instrumentId) ?? pos.avgPrice;
    v += pos.quantity * p;
  }
  return v;
}

export interface MarginParams {
  /** 规则导致的保证金倍数（如 margin_hike） */
  marginMultiplier: number;
  /**
   * 空头维持保证金率。默认 SHORT_MARGIN_RATE。
   * 危机中由 dynamicShortMarginRate(stress) 上调——这是
   * 「你在反弹中被追保、然后被强平」的机制来源。
   */
  shortMarginRate?: number;
}

/** 维持保证金要求。做空按更高的比率计提。 */
export function computeMaintenanceMargin(
  account: Account,
  prices: Map<string, number>,
  params: MarginParams = { marginMultiplier: 1 },
): Money {
  const shortRate = params.shortMarginRate ?? SHORT_MARGIN_RATE;
  let mm = 0;
  for (const pos of account.positions.values()) {
    const p = prices.get(pos.instrumentId) ?? pos.avgPrice;
    const rate = pos.quantity < 0 ? shortRate : DEFAULT_MARGIN_RATE;
    mm += Math.abs(pos.quantity) * p * rate;
  }
  return mm * params.marginMultiplier;
}

export type MarginStatus = 'ok' | 'margin_call' | 'liquidate';

/**
 * 保证金检查。
 *   equity >= MM            → ok
 *   equity <  MM            → margin_call（追保，T+1 期限）
 *   equity <  MM × 0.8      → liquidate（强制平仓）
 */
export function checkMargin(
  account: Account,
  prices: Map<string, number>,
  mm: Money,
): { status: MarginStatus; deficit: Money } {
  const equity = account.equity;
  if (equity + MARGIN_EPSILON >= mm) return { status: 'ok', deficit: 0 };
  if (equity < mm * 0.8 - MARGIN_EPSILON) return { status: 'liquidate', deficit: mm - equity };
  return { status: 'margin_call', deficit: mm - equity };
}

export interface LiquidationInstruction {
  instrumentId: string;
  quantity: number;
}

/**
 * 生成强平指令：按绝对敞口从大到小卖出，直到足以覆盖缺口。
 * 卖出方向：多头卖出现货；空头买入回补。
 */
export function planLiquidation(
  account: Account,
  prices: Map<string, number>,
  deficit: Money,
  targetBuffer = 1.3,
): LiquidationInstruction[] {
  const need = deficit * targetBuffer;
  const entries = [...account.positions.values()]
    .map((pos) => {
      const p = prices.get(pos.instrumentId) ?? pos.avgPrice;
      return { pos, p, value: Math.abs(pos.quantity) * p };
    })
    .sort((a, b) => b.value - a.value);

  const out: LiquidationInstruction[] = [];
  let covered = 0;
  for (const { pos, p } of entries) {
    if (covered >= need) break;
    const remaining = need - covered;
    const qty = Math.min(Math.abs(pos.quantity), remaining / Math.max(0.01, p));
    if (qty <= 0) continue;
    // 多头 → 卖出；空头 → 买入回补
    out.push({
      instrumentId: pos.instrumentId,
      quantity: pos.quantity > 0 ? Math.floor(qty) : -Math.ceil(qty),
    });
    covered += qty * p;
  }
  return out.filter((i) => i.quantity !== 0);
}

/** 借券费的逐日计提（年化 → 日）。 */
export function accrueBorrowFees(account: Account, prices: Map<string, number>): Money {
  let fee = 0;
  for (const pos of account.positions.values()) {
    if (pos.quantity >= 0) continue;
    const p = prices.get(pos.instrumentId) ?? pos.avgPrice;
    const value = Math.abs(pos.quantity) * p;
    fee += (value * pos.borrowFeeRate) / 252;
  }
  account.cash -= fee;
  return fee;
}

/** 便捷：账户当前的杠杆。 */
export function leverage(account: Account, prices: Map<string, number>): Ratio {
  if (account.equity <= 0) return 99;
  return grossExposure(account, prices) / account.equity;
}

/** 便捷：把持仓解析成可序列化的数组（用于 UI）。 */
export function positionList(account: Account) {
  return [...account.positions.values()];
}

/** 便捷：某标的的持仓数量。 */
export function positionQty(account: Account, instrumentId: string): number {
  return account.positions.get(instrumentId)?.quantity ?? 0;
}

/** 便捷：某标的的流通股数（用于空头集中度）。 */
export function floatShares(instrumentId: string): number {
  return INSTRUMENT_BY_ID.get(instrumentId)?.sharesOutstanding ?? 0;
}
