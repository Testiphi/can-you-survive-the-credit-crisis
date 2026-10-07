/**
 * 新手模式的简化图表：一条价格线 + 面积填充。
 *
 * 为什么不用 K 线：对完全没接触过交易的人来说，一排红绿蜡烛、叠加的均线、
 * 下方的成交量柱，是纯粹的信息噪声——**看不出该看什么**。
 * 一条线配一条起始基准，能回答新手唯一关心的问题：
 * 「现在比我第一次看到它的时候，是高了还是低了？」
 */

import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
} from 'lightweight-charts';
import type { Bar } from '@cyscc/core';

interface Props {
  bars: Bar[];
  height?: number;
  /** 切换标的时重建数据 */
  instrumentId: string;
}

export function SimpleChart({ bars, height = 260, instrumentId }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const areaRef = useRef<ISeriesApi<'Area'> | null>(null);
  const baseRef = useRef<ISeriesApi<'Line'> | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: '#0a0e14' },
        textColor: '#7d8b99',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#141a23' },
        horzLines: { color: '#141a23' },
      },
      rightPriceScale: { borderColor: '#1f2733' },
      timeScale: { borderColor: '#1f2733', rightOffset: 4 },
      // 新手模式不要十字光标——它带来的交互复杂度大于价值
      crosshair: { mode: 0 },
      handleScale: false,
      handleScroll: false,
    });

    const area = chart.addAreaSeries({
      lineColor: '#4a9eff',
      lineWidth: 2,
      topColor: 'rgba(74,158,255,0.28)',
      bottomColor: 'rgba(74,158,255,0.02)',
      priceLineVisible: false,
      lastValueVisible: true,
    });

    // 起始基准线：让「涨了还是跌了」有一个明确的参照
    const base = chart.addLineSeries({
      color: '#5a6b7c',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    chartRef.current = chart;
    areaRef.current = area;
    baseRef.current = base;

    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    onResize();
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      chart.remove();
      chartRef.current = null;
      areaRef.current = null;
      baseRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    const area = areaRef.current;
    const base = baseRef.current;
    const chart = chartRef.current;
    if (!area || !base || !chart || bars.length === 0) return;

    const line: LineData<Time>[] = bars.map((b) => ({ time: b.date as Time, value: b.close }));
    area.setData(line);

    const start = bars[0].close;
    base.setData([
      { time: bars[0].date as Time, value: start },
      ...(bars.length > 1 ? [{ time: bars[bars.length - 1].date as Time, value: start }] : []),
    ]);

    const from = Math.max(0, bars.length - 160);
    chart.timeScale().setVisibleLogicalRange({ from, to: bars.length + 2 });
  }, [bars, instrumentId]);

  return <div ref={containerRef} style={{ width: '100%' }} />;
}
