/**
 * K 线图组件。基于 TradingView lightweight-charts。
 *
 * 关键约束：**只能用 engine.visibleBars()**，绝不直接读 state.bars——
 * 后者包含未来数据。见 docs/02 §3.1 与 §8。
 *
 * 叠加了 MA20 / MA60 两条均线：一张只有蜡烛的图看不出「现在是趋势还是崩坏」，
 * 均线是判断这件事最便宜的参考线。
 */

import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type Time,
} from 'lightweight-charts';
import type { Bar } from '@cyscc/core';

interface Props {
  bars: Bar[];
  height?: number;
  /** 用于在切换标的时复用同一个图表实例 */
  instrumentId: string;
  /** 是否显示 MA20 / MA60 均线 */
  showMA?: boolean;
}

export function KLineChart({ bars, height = 340, instrumentId, showMA = true }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ma20Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ma60Ref = useRef<ISeriesApi<'Line'> | null>(null);

  // 创建图表（只做一次）
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
        vertLines: { color: '#161c26' },
        horzLines: { color: '#161c26' },
      },
      rightPriceScale: { borderColor: '#1f2733' },
      timeScale: { borderColor: '#1f2733', rightOffset: 6 },
      crosshair: { mode: 1 },
    });

    const candles = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });

    const volume = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      color: '#2a3646',
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    // 均线：让「现在是在趋势里还是在崩坏里」一眼可见
    const ma20 = chart.addLineSeries({
      color: '#f5a623',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    const ma60 = chart.addLineSeries({
      color: '#8d6e63',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;
    ma20Ref.current = ma20;
    ma60Ref.current = ma60;

    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    onResize();
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      ma20Ref.current = null;
      ma60Ref.current = null;
    };
  }, [height]);

  // 更新数据
  useEffect(() => {
    const candles = candleRef.current;
    const volume = volumeRef.current;
    const chart = chartRef.current;
    if (!candles || !volume || !chart) return;

    const candleData: CandlestickData<Time>[] = bars.map((b) => ({
      time: b.date as Time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));

    const volumeData: HistogramData<Time>[] = bars.map((b) => ({
      time: b.date as Time,
      value: b.volume,
      color: b.close >= b.open ? 'rgba(38,166,154,0.35)' : 'rgba(239,83,80,0.35)',
    }));

    candles.setData(candleData);
    volume.setData(volumeData);
    ma20Ref.current?.setData(movingAverageSeries(bars, 20, showMA));
    ma60Ref.current?.setData(movingAverageSeries(bars, 60, showMA));

    // 只显示最近 180 根，其余靠滚动
    const from = Math.max(0, bars.length - 180);
    chart.timeScale().setVisibleLogicalRange({ from, to: bars.length + 6 });
  }, [bars, instrumentId, showMA]);

  return <div ref={containerRef} style={{ width: '100%' }} />;
}

/** 计算移动平均序列。show=false 时返回空数据，等效于隐藏（用滚动窗口，O(n)）。 */
function movingAverageSeries(bars: Bar[], window: number, show: boolean): LineData<Time>[] {
  if (!show || bars.length < window) return [];
  const out: LineData<Time>[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= window) sum -= bars[i - window].close;
    if (i >= window - 1) {
      out.push({ time: bars[i].date as Time, value: sum / window });
    }
  }
  return out;
}
