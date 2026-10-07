import type { MarketBar, MarketData, MarketPatch } from './types.ts';

export function isEstimatedMarketBar(bar: MarketBar): boolean {
  return !!bar.filled || (bar.volume === 0 && bar.open === bar.high && bar.high === bar.low && bar.low === bar.close);
}

/** 只覆盖已确认的回填区间，绝不覆写原本有完整 OHLC 的日线。 */
export function applyMarketRevision(market: MarketData | undefined, patch: MarketPatch | undefined): MarketData {
  if (!market || !patch || patch.version !== 1) throw new Error('缺少受支持的行情修订数据');
  const expected = market.series.SPX.filter(b => b.date >= '2007-01-03' && b.date <= '2007-03-16').map(b => b.date);
  if (expected.length !== 51) throw new Error('行情补丁日历不匹配');
  const series = { ...market.series };
  for (const id of ['GS', 'MS', 'AIG', 'C', 'JPM']) {
    const corrections = patch.series[id];
    if (!corrections || corrections.length !== expected.length || corrections.some((b, i) => b.date !== expected[i])) throw new Error(`行情补丁日期不完整：${id}`);
    const original = new Map(series[id]?.map(b => [b.date, b]));
    for (const b of corrections) {
      const old = original.get(b.date);
      if (!old || !isEstimatedMarketBar(old)) throw new Error(`拒绝覆写非回填行情：${id}/${b.date}`);
      if (![b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) || b.low <= 0 || b.volume <= 0 || b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close)) throw new Error(`补丁 OHLC 无效：${id}/${b.date}`);
    }
    const byDate = new Map(corrections.map(b => [b.date, b]));
    series[id] = series[id].map(b => byDate.has(b.date) ? { ...byDate.get(b.date)! } : b);
  }
  return { ...market, series, source: `${market.source}+yahoo`, sourceNote: patch.sourceNote };
}
