import type { Account, Fill } from './types.ts';
import { applyFill, markToMarket, loanLiabilities } from './portfolio.ts';

/** 教学规则，不随事件、评级或市场压力改变。 */
export const BEGINNER_RULES = {
  borrowFeeRate: 0.005,
  shortMaintenanceRate: 0.3,
} as const;

/** D0 只为做空设固定风险底线；全额现金多头不触发追保。 */
export function beginnerMaintenance(account: Account, prices: Map<string, number>): number {
  let shortValue = 0;
  for (const p of account.positions.values()) {
    if (p.quantity < 0) shortValue += -p.quantity * (prices.get(p.instrumentId) ?? p.avgPrice);
  }
  return shortValue * BEGINNER_RULES.shortMaintenanceRate;
}

/** 收盘权益不足空头市值的 30% 时，按收盘价自动回补全部空头。
 * D0 不模拟补资期限或惩罚滑点；跳空仍可能导致负权益。
 */
export function settleBeginnerRisk(
  account: Account, prices: Map<string, number>, date: string, commissionRate: number,
  unavailable: ReadonlySet<string> = new Set(),
): Fill[] {
  const required = beginnerMaintenance(account, prices);
  const fills: Fill[] = [];
  if (required > 0 && account.equity + 1e-6 < required) {
    for (const pos of [...account.positions.values()]) {
      if (pos.quantity >= 0) continue;
      if (unavailable.has(pos.instrumentId)) continue;
      const price = prices.get(pos.instrumentId) ?? pos.avgPrice;
      const quantity = -pos.quantity;
      const fill: Fill = {
        order: { instrumentId: pos.instrumentId, side: 'buy', quantity, kind: 'market', submittedAt: date },
        filledAt: date, price, quantity, impact: 0,
        commission: quantity * price * commissionRate, reason: 'risk_close',
      };
      applyFill(account, fill, date);
      fills.push(fill);
    }
    markToMarket(account, prices);
  }
  account.maintenanceMargin = beginnerMaintenance(account, prices);
  account.marginCall = account.maintenanceMargin > 0 && account.equity + 1e-6 < account.maintenanceMargin;
  account.marginCallSince = undefined;
  return fills;
}

/** D0: new exposure is limited to opening equity; reducing risk is always allowed.
 * Prices are opening quotes, never the day's not-yet-observed closing prices.
 * Called after each execution so queued orders share the same buying power.
 */
export function limitBeginnerFill(account: Account, prices: Map<string, number>, fill: Fill, exposureLimit = 1): Fill {
  if (fill.quantity <= 0) return fill;
  const id = fill.order.instrumentId;
  const current = account.positions.get(id)?.quantity ?? 0;
  const sign = fill.order.side === 'buy' ? 1 : -1;
  const price = fill.price;
  const feePerShare = fill.commission / fill.quantity;
  let equity = account.cash - loanLiabilities(account);
  let otherExposure = 0;
  for (const pos of account.positions.values()) {
    const p = prices.get(pos.instrumentId) ?? pos.avgPrice;
    equity += pos.quantity * p;
    if (pos.instrumentId !== id) otherExposure += Math.abs(pos.quantity) * p;
  }
  const closing = current * sign < 0 ? Math.min(Math.abs(current), fill.quantity) : 0;
  let lo = closing;
  let hi = fill.quantity;
  while (lo < hi) {
    const q = Math.ceil((lo + hi) / 2);
    const cash = account.cash - sign * q * price - q * feePerShare;
    const exposure = otherExposure + Math.abs(current + sign * q) * price;
    if (cash >= 0 && exposure <= exposureLimit * (equity - q * feePerShare)) lo = q;
    else hi = q - 1;
  }
  if (lo === fill.quantity) return fill;
  return { ...fill, quantity: lo, commission: lo * feePerShare,
    reason: lo > 0 ? 'partial' : 'insufficient_funds' };
}
