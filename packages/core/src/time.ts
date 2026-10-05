/**
 * 交易日历。
 *
 * 全部使用 UTC 构造，避免本地时区导致的日期漂移。
 * 节假日为纽约证券交易所 2007–2009 年的实际休市日。
 */

import type { DateStr } from './types.ts';

const MS_PER_DAY = 86_400_000;

/** NYSE 休市日（2007–2009）。危机期间市场从未休市——这一点很重要。 */
const HOLIDAYS = new Set<string>([
  // 2007
  '2007-01-01', // 元旦
  '2007-01-15', // 马丁·路德·金日
  '2007-02-19', // 总统日
  '2007-04-06', // 耶稣受难日
  '2007-05-28', // 阵亡将士纪念日
  '2007-07-04', // 独立日
  '2007-09-03', // 劳动节
  '2007-11-22', // 感恩节
  '2007-12-25', // 圣诞节
  // 2008
  '2008-01-01',
  '2008-01-21',
  '2008-02-18',
  '2008-03-21',
  '2008-05-26',
  '2008-07-04',
  '2008-09-01',
  '2008-11-27',
  '2008-12-25',
  // 2009
  '2009-01-01',
  '2009-01-19',
  '2009-02-16',
  '2009-04-10',
  '2009-05-25',
  '2009-07-03', // 独立日（周六）调休
  '2009-09-07',
  '2009-11-26',
  '2009-12-25',
]);

export function parseDate(s: DateStr): Date {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatDate(d: Date): DateStr {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(s: DateStr, n: number): DateStr {
  return formatDate(new Date(parseDate(s).getTime() + n * MS_PER_DAY));
}

export function dayOfWeek(s: DateStr): number {
  return parseDate(s).getUTCDay(); // 0 = 周日
}

export function isTradingDay(s: DateStr): boolean {
  const dow = dayOfWeek(s);
  if (dow === 0 || dow === 6) return false;
  return !HOLIDAYS.has(s);
}

export function nextTradingDay(s: DateStr): DateStr {
  let cur = addDays(s, 1);
  // 安全上限，避免死循环
  for (let i = 0; i < 30 && !isTradingDay(cur); i++) cur = addDays(cur, 1);
  return cur;
}

export function prevTradingDay(s: DateStr): DateStr {
  let cur = addDays(s, -1);
  for (let i = 0; i < 30 && !isTradingDay(cur); i++) cur = addDays(cur, -1);
  return cur;
}

/** 含首尾的交易日列表（若首日不是交易日，则从其后的第一个交易日起）。 */
export function tradingDaysBetween(start: DateStr, end: DateStr): DateStr[] {
  const out: DateStr[] = [];
  let cur = isTradingDay(start) ? start : nextTradingDay(start);
  let guard = 0;
  while (cur <= end && guard++ < 5000) {
    out.push(cur);
    cur = nextTradingDay(cur);
  }
  return out;
}

/** 在交易日序列上前后移动 n 步（n 可为负）。 */
export function shiftTradingDays(s: DateStr, n: number): DateStr {
  let cur = s;
  const step = n >= 0 ? nextTradingDay : prevTradingDay;
  for (let i = 0; i < Math.abs(n); i++) cur = step(cur);
  return cur;
}

/** 两个交易日之间的交易日数量差（b 晚于 a 时为正）。 */
export function tradingDayDiff(a: DateStr, b: DateStr): number {
  if (a === b) return 0;
  const forward = a < b;
  let cur = a;
  let n = 0;
  const limit = 5000;
  while (cur !== b && n < limit) {
    cur = forward ? nextTradingDay(cur) : prevTradingDay(cur);
    n++;
  }
  return forward ? n : -n;
}

/** 一年中的第几天，用于季节性（本作暂未使用，保留给供暖季/财报季）。 */
export function dayOfYear(s: DateStr): number {
  const d = parseDate(s);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((d.getTime() - start) / MS_PER_DAY) + 1;
}
