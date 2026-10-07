import type { Account, FundState, GameConfig, NewsItem } from './types.ts';
import { markToMarket } from './portfolio.ts';
import { nextTradingDay, shiftTradingDays } from './time.ts';

/** 首版基金角色只有两笔预先公布的兑付，属于教学任务，不是假定真实基金合同。 */
export function createFund(config: GameConfig): FundState {
  return {
    defaulted: false,
    payments: [10, 25].map(offset => ({
      date: shiftTradingDays(config.startDate, offset),
      amount: Math.round(config.initialCapital * 0.1 * 100) / 100,
      status: 'pending' as const,
    })).filter(p => p.date <= config.endDate),
  };
}

/** 卖空所得与等额自有资金均留作空头担保，不能拿去兑付。 */
export function fundAvailableCash(account: Account, prices: Map<string, number>): number {
  let shortValue = 0;
  for (const pos of account.positions.values()) {
    if (pos.quantity < 0) shortValue += -pos.quantity * (prices.get(pos.instrumentId) ?? pos.avgPrice);
  }
  return Math.max(0, account.cash - 2 * shortValue);
}

export function settleFund(fund: FundState, account: Account, prices: Map<string, number>, date: string) {
  const news: NewsItem[] = [];
  let capitalOutflow = 0;
  for (const payment of fund.payments) {
    if (payment.status !== 'pending') continue;
    if (payment.date === date) {
      const available = fundAvailableCash(account, prices);
      if (!account.bankrupt && available + 1e-6 >= payment.amount) {
        account.cash -= payment.amount;
        account.distributedCapital = (account.distributedCapital ?? 0) + payment.amount;
        capitalOutflow += payment.amount;
        payment.status = 'paid';
        markToMarket(account, prices);
      } else {
        payment.status = 'missed';
        fund.defaulted = true;
      }
      news.push({ id: `fund-payment-${date}`, date, source: 'system', isTrue: true, credibility: 1,
        headline: payment.status === 'paid' ? '投资者赎回已兑付' : '投资者赎回未能按期兑付，本局结束',
        body: `本次应付 $${payment.amount.toFixed(2)}，结算前可兑付现金 $${available.toFixed(2)}。已兑付资本不是投资亏损；卖空担保资金不能用于兑付。`,
      });
    } else if (payment.date === nextTradingDay(date)) {
      news.push({ id: `fund-reminder-${date}`, date, source: 'system', isTrue: true, credibility: 1,
        headline: '下一交易日有投资者赎回，请检查现金',
        body: `${payment.date} 收盘需兑付 $${payment.amount.toFixed(2)}。现在提交的平仓订单在下一交易日开盘执行，兑付在收盘、扣费和空头风险处理后检查。`,
      });
    }
  }
  return { capitalOutflow, news };
}
