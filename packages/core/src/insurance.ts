import type { Account, GameConfig, InsurerState, NewsItem } from './types.ts';
import { fundAvailableCash } from './fund.ts';
import { markToMarket } from './portfolio.ts';
import { nextTradingDay, shiftTradingDays } from './time.ts';

export const INSURANCE_RULES = { dailyPremium: 0.0004, deductible: 0.05, share: 0.5 } as const;
const roundMoney = (n: number) => Math.round(n * 100) / 100;
const pressure = (stress: number) => Math.max(0, Math.min(1, stress));

export function createInsurer(config: GameConfig): InsurerState {
  return { defaulted: false, purchaseDeadline: shiftTradingDays(config.startDate, 5),
    claims: [15, 30].map(offset => {
      const assessmentDate = shiftTradingDays(config.startDate, offset);
      return { assessmentDate, dueDate: nextTradingDay(assessmentDate), status: 'scheduled' as const };
    }).filter(c => c.dueDate <= config.endDate) };
}

export function reinsurancePrice(initialCapital: number, stress: number): number {
  return roundMoney(initialCapital * (0.05 + 0.04 * pressure(stress)));
}

/** 两笔教学赔案：金额在确认日确定，先记赔款负债和再保险应收，次日收付。
 * 再保险承担每案超过初始资本 5% 部分的一半，同日回款，不模拟对手违约。
 */
export function settleInsurance(state: InsurerState, account: Account, prices: Map<string, number>,
  config: GameConfig, date: string, stress: number, buyCoverage: boolean) {
  const premiumIncome = state.claims.some(c => date <= c.dueDate)
    ? roundMoney(config.initialCapital * INSURANCE_RULES.dailyPremium) : 0;
  let claimExpense = 0, reinsurancePremium = 0, claimsPaid = 0, recoveriesReceived = 0;
  const news: NewsItem[] = [];
  const emit = (id: string, headline: string, body: string) => news.push({ id: `insurance-${id}-${date}`, date, headline, body, source: 'system' as const, isTrue: true, credibility: 1 });
  account.cash += premiumIncome;
  if (buyCoverage) {
    const cost = reinsurancePrice(config.initialCapital, stress);
    if (state.coverage || date > state.purchaseDeadline || fundAvailableCash(account, prices) + 1e-6 < cost) {
      emit('rejected', '再保险未成交，未扣费', '购买期限已过、已购买或可用现金不足。');
    } else {
      account.cash -= cost;
      reinsurancePremium = cost;
      state.coverage = { purchasedOn: date, premium: cost };
      emit('purchased', '再保险已生效', `支付一次性保费 $${cost.toFixed(2)}。每笔赔案由你承担初始资本 5% 的自留额，再保险承担超出部分的 50%。`);
    }
  }
  for (const claim of state.claims) {
    if (claim.status === 'scheduled' && claim.assessmentDate === date) {
      const gross = roundMoney(config.initialCapital * (0.03 + 0.17 * pressure(stress)));
      const recovery = state.coverage ? roundMoney(Math.max(0, gross - config.initialCapital * INSURANCE_RULES.deductible) * INSURANCE_RULES.share) : 0;
      claim.grossAmount = gross; claim.recovery = recovery; claim.status = 'due';
      account.claimsPayable = (account.claimsPayable ?? 0) + gross;
      account.reinsuranceReceivable = (account.reinsuranceReceivable ?? 0) + recovery;
      claimExpense += gross - recovery;
      emit('assessed', '赔款已确认，下一交易日支付', `应付赔款 $${gross.toFixed(2)}，应收再保险回款 $${recovery.toFixed(2)}，本次确认净损失 $${(gross - recovery).toFixed(2)}。请在 ${claim.dueDate} 收盘前准备现金；支付时不再重复记损失。`);
    }
    if (claim.status === 'due' && claim.dueDate === date) {
      const recovery = claim.recovery ?? 0, gross = claim.grossAmount ?? 0;
      account.cash += recovery;
      account.reinsuranceReceivable = Math.max(0, (account.reinsuranceReceivable ?? 0) - recovery);
      recoveriesReceived += recovery;
      const available = fundAvailableCash(account, prices);
      if (available + 1e-6 >= gross) {
        account.cash -= gross;
        account.claimsPayable = Math.max(0, (account.claimsPayable ?? 0) - gross);
        claimsPaid += gross; claim.status = 'paid';
      } else {
        state.defaulted = true; claim.status = 'missed';
      }
      emit('payment', claim.status === 'paid' ? '赔款已支付' : '赔款现金不足，本局结束', `再保险到账 $${recovery.toFixed(2)}，支付前可用现金 $${available.toFixed(2)}，应付 $${gross.toFixed(2)}。未付赔款继续计入负债。`);
    }
  }
  if (!state.coverage && nextTradingDay(date) === state.purchaseDeadline) {
    emit('deadline', '下一交易日是再保险购买截止日', '可以现在提交购买指令，也可以保留现金自行承担赔付。截止后不能等赔款金额揭晓再购买。');
  }
  markToMarket(account, prices);
  return { premiumIncome, claimExpense, reinsurancePremium, claimsPaid, recoveriesReceived, news };
}
