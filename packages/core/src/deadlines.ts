import type { GameState } from './types.ts';
import { fundAvailableCash } from './fund.ts';
import { collateralState } from './refinance.ts';
import { reinsurancePrice } from './insurance.ts';
import { tradingDayDiff } from './time.ts';

/** 只读取当前已知义务；不预先生成未来赔款或行情。 */
export function nextFundingDecision(state: GameState) {
  if (state.player.bankrupt || state.bank?.defaulted || state.fund?.defaulted || state.insurer?.defaulted || state.date >= state.config.endDate) return undefined;
  const items: Array<{ date: string; label: string; amount?: number; optional?: boolean }> = [];
  for (const p of state.fund?.payments ?? []) {
    if (p.status === 'pending') items.push({ date: p.date, label: '投资者赎回', amount: p.amount });
  }
  for (const loan of state.player.loans ?? []) {
    if (loan.status === 'active') items.push({ date: loan.dueDate, label: `${loan.id.replace('loan-', '借款 ')} 到期`,
      amount: loan.principal + loan.accruedInterest + loan.principal * loan.annualRate / 252 * Math.max(0, tradingDayDiff(state.date, loan.dueDate)) });
  }
  if (state.bank?.collateralCallDue) {
    const c = collateralState(state.player, state.prices, state.macro.systemicStress);
    // 同日到期的抵押本金已在还款清单中，不能再当追缴重复相加。
    const maturing = (state.player.loans ?? []).filter(l => l.refinancing === 'secured' && l.dueDate <= state.bank!.collateralCallDue!)
      .reduce((sum, l) => sum + l.principal, 0);
    items.push({ date: state.bank.collateralCallDue, label: '抵押融资缺口期限', amount: Math.max(0, c.used - maturing - c.capacity) });
  }
  if (state.insurer) {
    if (!state.insurer.coverage && state.insurer.purchaseDeadline > state.date) items.push({ date: state.insurer.purchaseDeadline,
      label: '再保险购买截止（可选择不买）', optional: true, amount: reinsurancePrice(state.config.initialCapital, state.macro.systemicStress) });
    for (const c of state.insurer.claims) {
      if (c.status === 'scheduled') items.push({ date: c.assessmentDate, label: '赔款金额确认（次日支付）' });
      if (c.status === 'due') items.push({ date: c.dueDate, label: '赔款支付（已扣预计同日再保险回款）', amount: Math.max(0, (c.grossAmount ?? 0) - (c.recovery ?? 0)) });
    }
  }
  const date = items.filter(i => i.date > state.date).map(i => i.date).sort()[0];
  if (!date) return undefined;
  const sameDay = items.filter(i => i.date === date);
  const amount = sameDay.every(i => i.amount !== undefined) ? sameDay.reduce((sum, i) => sum + i.amount!, 0) : undefined;
  const availableCash = fundAvailableCash(state.player, state.prices);
  return { date, days: tradingDayDiff(state.date, date), labels: sameDay.map(i => i.label),
    optional: sameDay.every(i => i.optional), amount, availableCash,
    shortfall: amount === undefined ? undefined : Math.max(0, amount - availableCash) };
}
