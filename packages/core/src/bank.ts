import type { Account, BankState, GameConfig, NewsItem, RefinanceRequest } from './types.ts';
import { collateralState, executeRefinance } from './refinance.ts';
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
export function settleBank(account: Account, prices: Map<string, number>, date: string, repayEarly: boolean,
  financing?: { bank: BankState; stress: number; endDate: string; request?: RefinanceRequest }) {
  let loanInterest = 0;
  let principalRepaid = 0;
  let interestPaid = 0;
  let defaulted = false;
  let financingFees = 0;
  const news: NewsItem[] = [];
  const emit = (id: string, headline: string, body: string) => news.push({ id: `bank-${id}-${date}`, date, headline, body, source: 'system' as const, isTrue: true, credibility: 1 });
  for (const loan of account.loans ?? []) {
    if (loan.status !== 'active') continue;
    const interest = loan.principal * loan.annualRate / 252;
    loan.accruedInterest += interest;
    loanInterest += interest;
  }
  if (financing?.request) {
    const result = executeRefinance(account, prices, financing.stress, date, financing.endDate, financing.request);
    if (result.ok) {
      principalRepaid += result.quote.principalRepaid;
      interestPaid += result.interestPaid;
      financingFees += result.quote.fee;
      emit('refinance', '展期已成交', `新到期日 ${result.quote.dueDate}，年化利率 ${(result.quote.annualRate * 100).toFixed(2)}%，手续费 $${result.quote.fee.toFixed(2)}，补还本金 $${result.quote.principalRepaid.toFixed(2)}，支付利息 $${result.interestPaid.toFixed(2)}。新合同利率从下一交易日起计息。`);
    } else emit('refinance-rejected', '展期申请未成交，原合同继续有效', result.reason);
  }
  for (const loan of [...(account.loans ?? [])].sort((a, b) => a.dueDate.localeCompare(b.dueDate))) {
    if (loan.status !== 'active') continue;
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
  if (financing && !defaulted) {
    const collateral = collateralState(account, prices, financing.stress);
    if (collateral.shortfall > 1e-6) {
      const available = fundAvailableCash(account, prices);
      if (available + 1e-6 >= collateral.shortfall) {
        let remaining = collateral.shortfall;
        for (const loan of [...(account.loans ?? [])].sort((a, b) => a.dueDate.localeCompare(b.dueDate))) {
          if (loan.refinancing !== 'secured' || loan.status !== 'active') continue;
          const payment = Math.min(remaining, loan.principal);
          account.cash -= payment; loan.principal -= payment;
          principalRepaid += payment; remaining -= payment;
          if (remaining <= 1e-6) break;
        }
        delete financing.bank.collateralCallDue;
        emit('collateral-payment', '抵押额度下降，已用现金补还本金', `补还 $${collateral.shortfall.toFixed(2)}，抵押折扣 ${(collateral.haircut * 100).toFixed(1)}%。现金与负债等额下降，不额外扣减净资产。`);
      } else if (financing.bank.collateralCallDue && date >= financing.bank.collateralCallDue) {
        defaulted = true;
        emit('collateral-default', '抵押融资缺口逾期，本局结束', `缺口 $${collateral.shortfall.toFixed(2)}，可用现金 $${available.toFixed(2)}。未支付部分仍保留在负债中。`);
      } else if (!financing.bank.collateralCallDue) {
        financing.bank.collateralCallDue = [nextTradingDay(date), financing.endDate].sort()[0];
        defaulted = financing.bank.collateralCallDue <= date;
        emit('collateral-call', defaulted ? '结束日抵押融资缺口未清偿' : '抵押融资出现缺口，请在下一交易日处理',
          `当前需补还本金 $${collateral.shortfall.toFixed(2)}，可用现金 $${available.toFixed(2)}，期限 ${financing.bank.collateralCallDue}。出售资产、提前还款或抵押品价格恢复均会改变下一日重新计算的缺口。`);
      }
    } else delete financing.bank.collateralCallDue;
  }
  if (repayEarly) emit('repayment', '提前偿债指令已处理', `归还本金 $${principalRepaid.toFixed(2)}，支付已计提利息 $${interestPaid.toFixed(2)}。现金不足时只偿还可支付的部分；不会额外借款。`);
  markToMarket(account, prices);
  return { loanInterest, principalRepaid, interestPaid, financingFees, defaulted, news };
}
