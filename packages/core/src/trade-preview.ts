import type { Fill, GameState, Order, OrderSide } from './types.ts';
import { INSTRUMENT_BY_ID } from './instruments.ts';
import { COMMISSION_RATE, executeOrder } from './market.ts';
import { limitBeginnerFill } from './beginner.ts';
import { BANK_RULES } from './bank.ts';
import { Rng } from './rng.ts';
import { applyFill, markToMarket } from './portfolio.ts';
import { fundAvailableCash } from './fund.ts';
import { nextFundingDecision } from './deadlines.ts';
import { collateralState } from './refinance.ts';

export interface TradePreview {
  order: Order | null;
  fill: Fill | null;
  label: string;
  note?: string;
  beforeQty: number;
  afterQty: number;
  closing: number;
  opening: number;
  cashAfter: number;
  availableCashAfter: number;
  paymentGapAfter?: number;
  collateralGapAfter?: number;
}

function intent(current: number, side: OrderSide, quantity: number): string {
  if (side === 'buy') {
    if (current >= 0) return current > 0 ? '加仓买入' : '买入';
    return quantity > -current ? '回补并买入' : quantity === -current ? '平掉空头' : '回补空头';
  }
  if (current <= 0) return current < 0 ? '加仓做空' : '做空';
  return quantity > current ? '卖出并做空' : quantity === current ? '平掉多头' : '减仓卖出';
}

/** 使用当前可见报价估计；独立随机流和账户副本，不消耗真实引擎状态。
 * 返回的 order 是要提交的原始数量，fill 只是估计，不承诺次日成交。
 */
export function previewBeginnerTrade(state: GameState, instrumentId: string, side: OrderSide, fraction: number): TradePreview {
  const beforeQty = state.player.positions.get(instrumentId)?.quantity ?? 0;
  const result: TradePreview = { order: null, fill: null, label: side === 'buy' ? '买入' : '卖出 / 做空',
    beforeQty, afterQty: beforeQty, closing: 0, opening: 0, cashAfter: state.player.cash,
    availableCashAfter: fundAvailableCash(state.player, state.prices) };
  if (state.config.difficulty !== 0 || !['buy', 'sell'].includes(side) || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) return { ...result, note: '预览参数无效' };
  const price = state.prices.get(instrumentId);
  const def = INSTRUMENT_BY_ID.get(instrumentId);
  if (!price || !def) return { ...result, note: '没有可用报价' };
  const budget = Math.max(0, side === 'buy' ? state.player.cash : state.player.equity) * fraction;
  const quantity = Math.floor(budget / price);
  if (quantity <= 0) return { ...result, note: '预算不足一股，操作不会推进时间' };
  const order: Order = { instrumentId, side, quantity, kind: 'market', submittedAt: state.date };
  const bar = state.bars.get(instrumentId)?.filter(b => b.date <= state.date).at(-1);
  const quoted = executeOrder({ order, openPrice: price, adv20: bar?.adv20 ?? def.baseAdv,
    liquidity: state.macro.liquidity, dailyVol: def.idioVol + 0.01, currentQty: beforeQty, shortable: def.shortable,
    rng: new Rng(0, 'preview'), params: { eta: 0, marginRate: 0.25, commissionRate: COMMISSION_RATE, shortBanned: new Set() } });
  const fill = limitBeginnerFill(state.player, state.prices, quoted, state.bank ? BANK_RULES.exposureLimit : 1);
  const account = structuredClone(state.player);
  applyFill(account, fill, state.date);
  markToMarket(account, state.prices);
  const closing = beforeQty * (side === 'buy' ? 1 : -1) < 0 ? Math.min(Math.abs(beforeQty), fill.quantity) : 0;
  const next = nextFundingDecision({ ...state, player: account });
  return { order, fill, label: intent(beforeQty, side, quantity), beforeQty,
    afterQty: account.positions.get(instrumentId)?.quantity ?? 0,
    closing, opening: fill.quantity - closing, cashAfter: account.cash,
    availableCashAfter: fundAvailableCash(account, state.prices),
    paymentGapAfter: next?.optional ? undefined : next?.shortfall,
    collateralGapAfter: state.bank ? collateralState(account, state.prices, state.macro.systemicStress).shortfall : undefined,
    note: bar?.provenance === 'carried' ? '当前为沿用报价，次日仍缺行情时不会成交' : undefined };
}
