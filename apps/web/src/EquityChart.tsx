/**
 * 净值曲线 —— P0 交付物之一。
 *
 * 两条线放在同一尺度上：
 *   · 你的净值（面积图）
 *   · 标普 500 买入持有基准（折线，按初始资金归一化）
 *
 * 第二条线是刻意加的：没有基准，"赚了 40%" 是没有意义的——
 * 如果同期大盘涨了 60%，你其实做得很差。**相对表现才是这个游戏的记分方式。**
 */

import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type AreaData,
  type LineData,
  type Time,
} from 'lightweight-charts';

export interface CurvePoint {
  time: string;
  value: number;
}

interface Props {
  /** 玩家净值序列 */
  equity: CurvePoint[];
  /** 基准序列（已按初始资金归一化） */
  benchmark: CurvePoint[];
  height?: number;
}

export function EquityChart({ equity, benchmark, height = 170 }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const equityRef = useRef<ISeriesApi<'Area'> | null>(null);
  const benchRef = useRef<ISeriesApi<'Line'> | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: '#0d1219' },
        textColor: '#7d8b99',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: '#151c26' },
        horzLines: { color: '#151c26' },
      },
      rightPriceScale: { borderColor: '#1f2733' },
      timeScale: { borderColor: '#1f2733', rightOffset: 4, visible: true },
      crosshair: { mode: 1 },
      handleScale: false,
      handleScroll: false,
    });

    const equitySeries = chart.addAreaSeries({
      lineColor: '#4a9eff',
      topColor: 'rgba(74,158,255,0.28)',
      bottomColor: 'rgba(74,158,255,0.02)',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });

    const benchSeries = chart.addLineSeries({
      color: '#6f7d8c',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: true,
    });

    chartRef.current = chart;
    equityRef.current = equitySeries;
    benchRef.current = benchSeries;

    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    onResize();
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      chart.remove();
      chartRef.current = null;
      equityRef.current = null;
      benchRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    const eq = equityRef.current;
    const bm = benchRef.current;
    const chart = chartRef.current;
    if (!eq || !bm || !chart) return;

    eq.setData(equity.map((p) => ({ time: p.time as Time, value: p.value })) as AreaData<Time>[]);
    bm.setData(benchmark.map((p) => ({ time: p.time as Time, value: p.value })) as LineData<Time>[]);

    const n = equity.length;
    const from = Math.max(0, n - 130);
    chart.timeScale().setVisibleLogicalRange({ from, to: n + 4 });
  }, [equity, benchmark]);

  return <div ref={containerRef} style={{ width: '100%' }} />;
}
