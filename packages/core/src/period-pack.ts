import type { EventCard, GameConfig, MacroState, MarketData } from './types.ts';
import { isTradingDay, tradingDaysBetween } from './time.ts';
import { haircutFromStress } from './economy.ts';

export interface PeriodPack {
  id: '2010-q2-v1';
  market: MarketData;
  events: EventCard[];
  macro: Array<{ date: string; vix: number; tedSpread: number; tedAsOf: string }>;
}

export function validatePeriodConfig(config: Partial<GameConfig>): void {
  if (config.periodPack === undefined) {
    if ((config.startDate ?? '') > '2009-12-31' || (config.endDate ?? '') > '2009-12-31') {
      throw new Error('2010 年必须选择已验证的时期数据包');
    }
    return;
  }
  if (config.periodPack !== '2010-q2-v1') throw new Error('不支持的时期数据包版本');
  if (config.difficulty !== 0 || config.demoVersion !== 1 || config.calendar !== 'nyse-2010') {
    throw new Error('2010 数据包仅支持 D0 演示规则及 nyse-2010 日历');
  }
  const { startDate: start, endDate: end } = config;
  const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
  if (!start || !end || !validDate(start) || !validDate(end) || start < '2010-04-01' || end > '2010-06-30' || start > end ||
      !isTradingDay(start, config.calendar) || !isTradingDay(end, config.calendar)) {
    throw new Error('时期数据包日期范围无效');
  }
}

/** Refuse partial packages instead of carrying a 2009 quote into 2010. */
export function validatePeriodPack(pack: PeriodPack): void {
  if (pack.id !== '2010-q2-v1' || pack.market.version !== 1 ||
      pack.market.range.join('/') !== '2010-04-01/2010-06-30') throw new Error('时期数据包范围或版本错误');
  const days = tradingDaysBetween('2010-04-01', '2010-06-30', 'nyse-2010');
  for (const id of ['SPX', 'C', 'GS', 'MS', 'JPM', 'AIG']) {
    const rows = pack.market.series[id];
    if (!rows || rows.length !== days.length) throw new Error(`时期行情缺失: ${id}`);
    rows.forEach((b, i) => {
      if (b.date !== days[i] || b.filled || ![b.open, b.high, b.low, b.close, b.volume].every(n => Number.isFinite(n) && n > 0) ||
          b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close)) {
        throw new Error(`时期行情无效: ${id}/${b.date}`);
      }
    });
  }
  if (pack.macro.length !== days.length) throw new Error('时期宏观数据缺失');
  pack.macro.forEach((m, i) => {
    if (m.date !== days[i] || !Number.isFinite(m.vix) || m.vix <= 0 ||
        !Number.isFinite(m.tedSpread) || m.tedSpread < 0 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(m.tedAsOf) || m.tedAsOf > m.date ||
        !Number.isFinite(Date.parse(m.tedAsOf)) || Date.parse(m.date) - Date.parse(m.tedAsOf) > 4 * 86400000) {
      throw new Error(`时期宏观数据无效: ${m.date}`);
    }
  });
}

/** VIX/TED are observations; credit/liquidity/haircuts/stress remain teaching estimates. */
export function periodMacro(pack: PeriodPack, config: GameConfig): MacroState[] {
  const closes = new Map(pack.market.series.SPX.map(b => [b.date, b.close]));
  const norm = (n: number, lo: number, hi: number) => Math.min(1, Math.max(0, (n - lo) / (hi - lo)));
  return pack.macro.filter(m => m.date >= config.startDate && m.date <= config.endDate).map(m => {
    const stress = 0.6 * norm(m.vix, 12, 50) + 0.4 * norm(m.tedSpread, 0.1, 0.5);
    return { date: m.date, spx: closes.get(m.date)!, vix: m.vix, tedSpread: m.tedSpread,
      creditSpread: 250 + 12 * Math.max(0, m.vix - 12), systemicStress: stress,
      liquidity: Math.max(0.05, 1 - 0.95 * stress), repoHaircut: haircutFromStress(stress) };
  });
}
