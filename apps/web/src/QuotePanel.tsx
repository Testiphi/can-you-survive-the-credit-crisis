/**
 * 行情数据面板。
 *
 * 「光秃秃的 K 线看着没意思」——一张只有蜡烛的图，玩家看不出
 * 现在的位置、历史区间、波动率水平。这个面板把那些信息补齐：
 *
 *   · 现价与当日涨跌
 *   · 当日开高低、振幅
 *   · 区间最高/最低（含日期）与当前距两端的位置
 *   · MA20 / MA60
 *   · 年化波动率（近 60 日与全期）
 *   · 成交量与 20 日均量
 *
 * 全部数据来自 visibleBars()，因此不存在未来函数泄露。
 */

import type { ReactNode } from 'react';
import type { Bar } from '@cyscc/core';
import { Tip } from './Tip.tsx';

export interface QuoteStats {
  last: Bar;
  prev: Bar;
  change: number;
  changePct: number;
  rangePct: number;
  high: number;
  highDate: string;
  low: number;
  lowDate: string;
  fromHigh: number;
  fromLow: number;
  ma20: number | null;
  ma60: number | null;
  vol60: number | null;
  volAll: number | null;
  avgVolume20: number | null;
  volumeRatio: number | null;
  bars: number;
}

/** 年化波动率（对数收益的标准差 × √252） */
function annualizedVol(bars: Bar[], window: number): number | null {
  if (bars.length < 4) return null;
  const slice = bars.slice(-(window + 1));
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const a = slice[i - 1].close;
    const b = slice[i].close;
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 3) return null;
  const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
  const variance = rets.reduce((x, y) => x + (y - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance * 252);
}

function movingAverage(bars: Bar[], window: number): number | null {
  if (bars.length < window) return null;
  const slice = bars.slice(-window);
  return slice.reduce((a, b) => a + b.close, 0) / window;
}

export function computeQuote(bars: Bar[]): QuoteStats | null {
  if (bars.length === 0) return null;
  const last = bars[bars.length - 1];
  const prev = bars.length > 1 ? bars[bars.length - 2] : last;

  let high = -Infinity;
  let low = Infinity;
  let highDate = last.date;
  let lowDate = last.date;
  for (const b of bars) {
    if (b.high > high) {
      high = b.high;
      highDate = b.date;
    }
    if (b.low < low) {
      low = b.low;
      lowDate = b.date;
    }
  }

  const avgVolume20 =
    bars.length >= 20 ? bars.slice(-20).reduce((a, b) => a + b.volume, 0) / 20 : null;

  return {
    last,
    prev,
    change: last.close - prev.close,
    changePct: prev.close > 0 ? last.close / prev.close - 1 : 0,
    rangePct: prev.close > 0 ? (last.high - last.low) / prev.close : 0,
    high,
    highDate,
    low,
    lowDate,
    fromHigh: high > 0 ? last.close / high - 1 : 0,
    fromLow: low > 0 ? last.close / low - 1 : 0,
    ma20: movingAverage(bars, 20),
    ma60: movingAverage(bars, 60),
    vol60: annualizedVol(bars, 60),
    volAll: annualizedVol(bars, bars.length),
    avgVolume20,
    volumeRatio: avgVolume20 && avgVolume20 > 0 ? last.volume / avgVolume20 : null,
    bars: bars.length,
  };
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const num = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 0 });

export function QuotePanel({ stats, instrumentId }: { stats: QuoteStats; instrumentId: string }) {
  const q = stats;
  const up = q.change >= 0;

  const row = (k: string, v: ReactNode, tip?: string) => (
    <div className="quote-row" key={k}>
      <span className="k">{tip ? <Tip text={tip}>{k} ⓘ</Tip> : k}</span>
      <span className="v">{v}</span>
    </div>
  );

  return (
    <div className="quote-grid">
      <div className="quote-head">
        <span className="sym">{instrumentId}</span>
        <span className={`px ${up ? 'pos' : 'neg'}`}>{q.last.close.toFixed(2)}</span>
        <span className={`chg ${up ? 'pos' : 'neg'}`}>
          {up ? '+' : ''}
          {q.change.toFixed(2)}（{up ? '+' : ''}
          {pct(q.changePct)}）
        </span>
      </div>

      {row(
        '今日开 / 高 / 低',
        `${q.last.open.toFixed(2)} / ${q.last.high.toFixed(2)} / ${q.last.low.toFixed(2)}`,
        '当日开盘价、最高价、最低价。\n\n注意：最大的损失往往发生在**开盘跳空**——' +
          '你设的止损根本没机会触发，价格直接跳过去了。',
      )}
      {row(
        '振幅',
        pct(q.rangePct),
        '（当日最高 − 当日最低）/ 昨收。\n\n平时约 1–2%，危机中可以超过 20%。振幅是「今天有多疯」的直接读数。',
      )}
      {row(
        '区间最高',
        <>
          {q.high.toFixed(2)} <span className="dim">{q.highDate}</span>
        </>,
        '从 2007 年初到今天的最高价，以及发生日期。',
      )}
      {row(
        '区间最低',
        <>
          {q.low.toFixed(2)} <span className="dim">{q.lowDate}</span>
        </>,
        '从 2007 年初到今天的最低价，以及发生日期。',
      )}
      {row(
        '距最高点',
        <span className={q.fromHigh < -0.2 ? 'neg' : ''}>{pct(q.fromHigh)}</span>,
        '现价相对区间最高价的涨跌幅。\n\n这就是「回撤」在单个标的上的含义——' +
          '决定你是在山腰还是谷底。',
      )}
      {row(
        '距最低点',
        <span className={q.fromLow > 0.2 ? 'pos' : ''}>+{pct(q.fromLow)}</span>,
        '现价相对区间最低价的涨幅。\n\n用于判断一段反弹已经走了多远。',
      )}
      {row(
        'MA20 / MA60',
        q.ma20 !== null && q.ma60 !== null ? (
          <>
            <span className={q.last.close >= q.ma20 ? 'pos' : 'neg'}>{q.ma20.toFixed(1)}</span>
            {' / '}
            <span className={q.last.close >= q.ma60 ? 'pos' : 'neg'}>{q.ma60.toFixed(1)}</span>
          </>
        ) : (
          <span className="dim">历史不足</span>
        ),
        '20 日与 60 日移动平均线（已叠加在 K 线上）。\n\n' +
          '价格在均线上方通常视为上升趋势，下方视为下降趋势。' +
          '危机中的均线会变成压力位——每次反弹到均线附近就掉头。',
      )}
      {row(
        '波动率 60日 / 全期',
        q.vol60 !== null && q.volAll !== null ? (
          <>
            <span className={q.vol60 > 0.5 ? 'neg' : ''}>{pct(q.vol60)}</span>
            <span className="dim"> / {pct(q.volAll)}</span>
          </>
        ) : (
          <span className="dim">历史不足</span>
        ),
        '年化波动率 = 日对数收益的标准差 × √252。\n\n' +
          '平时 15–30%；2008 年 10 月整个金融板块超过 100%。\n\n' +
          '波动率直接决定你的风险：同样的仓位，波动率翻倍就意味着爆仓概率大幅上升。',
      )}
      {row(
        '成交量 / 20日均量',
        q.volumeRatio !== null ? (
          <>
            {num(q.last.volume)} <span className={q.volumeRatio > 1.5 ? 'warn' : 'dim'}>（{q.volumeRatio.toFixed(2)}×）</span>
          </>
        ) : (
          num(q.last.volume)
        ),
        '今日成交量与 20 日平均成交量的比值。\n\n' +
          '放量下跌往往是恐慌抛售，缩量下跌则更像无人接盘。' +
          '比值同时决定你的订单能吃下多少——量越大，滑点越小。',
      )}
    </div>
  );
}
