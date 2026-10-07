import type { Account, GameConfig, NewsItem } from './types.ts';
import { applyFill, markToMarket } from './portfolio.ts';
import { fundAvailableCash } from './fund.ts';
import { nextTradingDay, shiftTradingDays } from './time.ts';

export const BANK_RULES = { annualRate: 0.05, exposureLimit: 2 } as const;

/** 继承的教学资产负债表：借入一倍自有资本，持有约 1.5 倍资本的证券。
 * 初始持仓是场景禀赋，不是一次隐形下单，不收取开局成交费用。
 */
export function initializeBank(account: Account, prices: Map<string, number>, config: GameConfig): void {
  account.loans = [15, 30].map((offset, i) => ({
    id: `loan-${i + 1}`, principal: config.initialCapital / 2, accruedInterest: 0,
    annualRate: BANK_RULES.annualRate,
    dueDate: [shiftTradingDays(config.startDate, offset), config.endDate].sort()[0],
    status: 'active' as const,
  }));
  account.cash += config.initialCapital;
  for (const [id, weight] of [['SPX', 1], ['C', 0.5]] as const) {
    const price = prices.get(id)!;
    const quantity = Math.floor(config.initialCapital * weight / price);
    if (quantity <= 0) continue;
    applyFill(account, { order: { instrumentId: id, side: 'buy', quantity, kind: 'market', submittedAt: config.startDate },
      quantity, price, impact: 0, commission: 0, reason: 'ok', filledAt: config.startDate }, config.startDate);
  }
  markToMarket(account, prices);
}

/** 先按余额计息，再处理主动提前还款，最后检查当日到期合同。 */
export function settleBank(account: Account, prices: Map<string, number>, date: string, repayEarly: boolean) {
  let loanInterest = 0;
  let principalRepaid = 0;
  let interestPaid = 0;
  let defaulted = false;
  const news: NewsItem[] = [];
  const emit = (id: string, headline: string, body: string) => news.push({ id: `bank-${id}-${date}`, date, headline, body, source: 'system' as const, isTrue: true, credibility: 1 });
  for (const loan of account.loans ?? []) {
    if (loan.status !== 'active') continue;
    const interest = loan.principal * loan.annualRate / 252;
    loan.accruedInterest += interest;
    loanInterest += interest;
    const debt = loan.principal + loan.accruedInterest;
    const available = fundAvailableCash(account, prices);
    const due = loan.dueDate <= date;
    if (repayEarly || due) {
      // 到期必须足额；提前还款可以部分支付，先清利息，再减少本金。
      const payment = due && available + 1e-6 < debt ? 0 : Math.min(debt, available);
      const paidInterest = Math.min(payment, loan.accruedInterest);
      const paidPrincipal = Math.min(loan.principal, Math.max(0, payment - paidInterest));
      account.cash -= paidInterest + paidPrincipal;
      loan.accruedInterest -= paidInterest;
      loan.principal -= paidPrincipal;
      interestPaid += paidInterest;
      principalRepaid += paidPrincipal;
      if (loan.principal + loan.accruedInterest < 1e-6) {
        loan.principal = 0; loan.accruedInterest = 0; loan.status = 'repaid';
      } else if (due) {
        loan.status = 'defaulted'; defaulted = true;
      }
    }
    if (due) emit(loan.id, loan.status === 'defaulted' ? '到期借款未能偿还，本局结束' : '到期借款已偿还',
      `${loan.id} 本次到期本息 $${debt.toFixed(2)}，结算前可用现金 $${available.toFixed(2)}。还本不改变净资产，利息按每日余额计入成本。`);
    else if (loan.status === 'active' && loan.dueDate === nextTradingDay(date)) emit(`reminder-${loan.id}`, '下一交易日有借款到期，请准备现金',
      `${loan.id} 在 ${loan.dueDate} 收盘到期；当前本息 $${(loan.principal + loan.accruedInterest).toFixed(2)}，到期日还会计提一天利息。现在可提交平仓或提前偿债指令。`);
  }
  if (repayEarly) emit('repayment', '提前偿债指令已处理', `归还本金 $${principalRepaid.toFixed(2)}，支付已计提利息 $${interestPaid.toFixed(2)}。现金不足时只偿还可支付的部分；不会额外借款。`);
  markToMarket(account, prices);
  return { loanInterest, principalRepaid, interestPaid, defaulted, news };
}
