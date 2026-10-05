/**
 * K 线图组件。基于 TradingView lightweight-charts。
 *
 * 关键约束：**只能用 engine.visibleBars()**，绝不直接读 state.bars——
 * 后者包含未来数据。见 docs/02 §3.1 与 §8。
 */

import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type Time,
} from 'lightweight-charts';
import type { Bar } from '@cyscc/core';

interface Props {
  bars: Bar[];
  height?: number;
  /** 用于在切换标的时复用同一个图表实例 */
  instrumentId: string;
}

export function KLineChart({ bars, height = 360, instrumentId }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);

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

    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;

    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    onResize();
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
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
    // 只显示最近 180 根，其余靠滚动
    const from = Math.max(0, bars.length - 180);
    chart.timeScale().setVisibleLogicalRange({ from, to: bars.length + 6 });
  }, [bars, instrumentId]);

  return <div ref={containerRef} style={{ width: '100%' }} />;
}
