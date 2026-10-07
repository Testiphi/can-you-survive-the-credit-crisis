import type { Bar } from '../../../packages/core/src/types.ts';

/** 不把缺少日内信息的估算值画成真实蜡烛，也不展示合成成交量。 */
export function prepareKlineData(bars: Bar[]) {
  const estimated = (b: Bar) => b.provenance === 'estimated' || b.provenance === 'carried';
  return {
    estimatedCount: bars.filter(estimated).length,
    candles: bars.map(b => estimated(b) ? { time: b.date } : { time: b.date, open: b.open, high: b.high, low: b.low, close: b.close }),
    estimates: bars.map((b, i) => estimated(b) || (i > 0 && estimated(bars[i - 1])) || (i + 1 < bars.length && estimated(bars[i + 1]))
      ? { time: b.date, value: b.close } : { time: b.date }),
    volumes: bars.map(b => estimated(b) ? { time: b.date } : { time: b.date, value: b.volume, color: b.close >= b.open ? 'rgba(38,166,154,0.35)' : 'rgba(239,83,80,0.35)' }),
  };
}
