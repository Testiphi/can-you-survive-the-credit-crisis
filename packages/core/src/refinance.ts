import type { Account, Loan, RefinanceRequest } from './types.ts';
import { loanLiabilities } from './portfolio.ts';
import { fundAvailableCash } from './fund.ts';
import { shiftTradingDays, tradingDayDiff } from './time.ts';

/** 所有利率与折扣是教学规则；只改变银行合同，不改写历史价格。 */
export function collateralState(account: Account, prices: Map<string, number>, stress: number) {
  const haircut = 0.2 + 0.5 * Math.min(1, Math.max(0, stress));
  let marketValue = 0;
  for (const p of account.positions.values()) {
    if (p.quantity > 0) marketValue += p.quantity * (prices.get(p.instrumentId) ?? p.avgPrice);
  }
  const capacity = marketValue * (1 - haircut);
  const used = (account.loans ?? []).filter(l => l.refinancing === 'secured').reduce((sum, l) => sum + l.principal, 0);
  return { haircut, marketValue, capacity, used, shortfall: Math.max(0, used - capacity) };
}

export function refinanceQuote(account: Account, prices: Map<string, number>, stress: number,
  date: string, endDate: string, loan: Loan, plan: RefinanceRequest['plan']) {
  const pressure = Math.min(1, Math.max(0, stress));
  const secured = plan === 'secured';
  const annualRate = (secured ? 0.06 : 0.1) + pressure * 0.04;
  const dueDate = [shiftTradingDays(date, secured ? 10 : 20), endDate].sort()[0];
  const collateral = collateralState(account, prices, stress);
  const remainingCapacity = Math.max(0, collateral.capacity - collateral.used);
  const principalRepaid = secured ? Math.max(0, loan.principal - remainingCapacity) : 0;
  const newPrincipal = loan.principal - principalRepaid;
  const fee = newPrincipal * (secured ? 0.002 : 0.005);
  const cashRequired = loan.accruedInterest + principalRepaid + fee;
  let equity = account.cash - loanLiabilities(account);
  for (const p of account.positions.values()) equity += p.quantity * (prices.get(p.instrumentId) ?? p.avgPrice);
  const reason = loan.status !== 'active' ? '借款已结清或违约'
    : loan.refinancing ? '每笔借款只能展期一次'
    : date > loan.dueDate || tradingDayDiff(date, loan.dueDate) > 5 ? '仅在到期前五个交易日至到期日接受申请'
    : dueDate <= loan.dueDate ? '剩余时期不足以延长期限'
    : equity <= fee ? '净资产不足以承担展期手续费'
    : newPrincipal <= 0 ? '没有可支持续借的抵押资产'
    : !secured && equity < loan.principal * 0.5 ? '无抵押展期要求净资产至少为本笔本金的一半'
    : fundAvailableCash(account, prices) + 1e-6 < cashRequired ? '可用现金不足以支付利息、手续费与需补还本金'
    : undefined;
  return { annualRate, dueDate, principalRepaid, newPrincipal, fee, cashRequired, haircut: collateral.haircut, reason };
}

export function executeRefinance(account: Account, prices: Map<string, number>, stress: number,
  date: string, endDate: string, request: RefinanceRequest) {
  const loan = account.loans?.find(l => l.id === request.loanId);
  if (!loan) return { ok: false as const, reason: '未找到借款' };
  const quote = refinanceQuote(account, prices, stress, date, endDate, loan, request.plan);
  if (quote.reason) return { ok: false as const, reason: quote.reason };
  const interestPaid = loan.accruedInterest;
  account.cash -= quote.cashRequired;
  loan.principal = quote.newPrincipal;
  loan.accruedInterest = 0;
  loan.annualRate = quote.annualRate;
  loan.dueDate = quote.dueDate;
  loan.refinancing = request.plan;
  return { ok: true as const, quote, interestPaid };
}
