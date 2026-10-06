/**
 * D0 新手模式。
 *
 * ## 为什么单独做一个界面，而不是给主界面加 if
 *
 * 主界面是为「看懂危机」设计的：20 个标的、K 线 + 成交量 + 均线、
 * 回购折扣率、系统性风险分、机构脆弱度表……这些对已经入门的玩家是好东西，
 * 对第一次接触的人是一堵墙。
 *
 * 所以 D0 不是「主界面少显示几项」，而是**换一套交互模型**：
 *
 * | | D1+ 主界面 | D0 新手模式 |
 * |---|---|---|
 * | 标的 | 20 个（指数 + 机构 + 合成标的） | **2 个**，带一句话说明 |
 * | 图表 | 蜡烛 + 成交量 + MA20/MA60 | **一条价格线** + 起始基准 |
 * | 操作 | 做多/做空 25% 与 100%、清仓 | **买入 / 做空 / 观望 / 赎回** |
 * | 节奏 | 自己决定推进多少天 | **每个操作自动推进到下一条新闻** |
 * | 账户 | 权益、融资容量、展期率、SRS | **模拟盘**：现金 / 持仓 / 浮动盈亏 / 成交记录 |
 *
 * 唯一没有削减的是**新闻**——那是这个游戏的全部意义所在。
 *
 * ## 交互模型：一个动作 = 一条新闻
 *
 * 新手最容易卡住的地方是「我该什么时候点推进」。这里的答案是：
 * 你不需要想这件事。看新闻 → 做决定 → 点一个按钮 → 时间前进到下一条新闻。
 * 「观望」就是「这条新闻我不操作」，它不是什么都不做的死按钮。
 */

import { useCallback, useMemo, useReducer, useRef, useState } from 'react';

import type { Fill, GameEngine } from '@cyscc/core';

import { SimpleChart } from './SimpleChart.tsx';
import { Tip, useTip } from './Tip.tsx';
import { buildHints } from './glossary.ts';

/** D0 只保留两个标的——一个指数、一个单只股票。 */
const D0_INSTRUMENTS: Array<{ id: string; name: string; hint: string; desc: string }> = [
  {
    id: 'SPX',
    name: '标普 500',
    hint: '美国股市大盘',
    desc: '500 家最大公司的平均表现。它代表「整个市场」，跌起来慢，但很难躲开。',
  },
  {
    id: 'C',
    name: '花旗集团',
    hint: '美国最大的银行之一',
    desc: '单只股票。银行靠借钱做生意，所以危机里它跌得比大盘惨得多——这是本作最重要的一课。',
  },
];

const ACTIONS = {
  buy: '买入\n\n用你手上全部的现金买入，变成持仓。\n\n价格涨了你赚钱，跌了你亏钱。最坏情况是亏光本金，不会更多。',
  short:
    '做空\n\n先借来卖出，等价格跌了再买回来还掉，赚差价。\n\n' +
    '价格跌你赚钱；**价格涨你亏钱，而且亏损没有上限**——因为股价理论上可以无限涨。\n\n' +
    '这是本作风险最高的动作。历史上靠做空危机发财的人确实存在，但他们也是在崩盘之前就下注的。',
  wait:
    '观望\n\n这条新闻我不操作，直接看下一条。\n\n' +
    '**观望不是错误的决定。** 危机里空仓也是一种仓位——只是它只能拿到中等成绩。',
  redeem:
    '赎回\n\n把手上所有持仓全部卖掉，换回现金。\n\n' +
    '行情不好的时候，可能只能卖掉一部分——想跑却跑不掉，这是 2008 年的真实体感。',
} as const;

type ActionKind = keyof typeof ACTIONS;

const money = (v: number) =>
  v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const signed = (v: number) => `${v >= 0 ? '+' : ''}${money(v)}`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

interface Props {
  engine: GameEngine;
  /** 引擎状态变更后触发父组件重渲染 */
  onChange: () => void;
  onRestart: () => void;
}

export function BeginnerApp({ engine, onChange, onRestart }: Props) {
  const [selected, setSelected] = useState('SPX');
  const [trades, setTrades] = useState<Fill[]>([]);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const engineRef = useRef(engine);
  engineRef.current = engine;

  const buyTip = useTip(ACTIONS.buy);
  const shortTip = useTip(ACTIONS.short);
  const waitTip = useTip(ACTIONS.wait);
  const redeemTip = useTip(ACTIONS.redeem);
  const restartTip = useTip('重开\n\n回到开始界面，重新选择种子、难度与时间线。');

  const s = engine.summary();
  const inst = D0_INSTRUMENTS.find((i) => i.id === selected) ?? D0_INSTRUMENTS[0];
  const bars = useMemo(
    () => engine.visibleBars(selected),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, selected, engine.state.turnIndex],
  );

  const ret = s.equity / engine.config.initialCapital - 1;

  /** 推进到下一条新闻（带安全上限）。 */
  const advanceToNews = useCallback(
    (log: Fill[]) => {
      const e = engineRef.current;
      let advanced = 0;
      for (let i = 0; i < 120; i++) {
        if (e.isOver) break;
        const res = e.advance();
        advanced++;
        if (res.fills.length > 0) log.push(...res.fills);
        if (res.firedEventIds.length > 0) break;
      }
      if (log.length > 0) setTrades((prev) => [...prev, ...log].slice(-6));
      onChange();
      return advanced;
    },
    [onChange],
  );

  const act = useCallback(
    (kind: ActionKind) => {
      const e = engineRef.current;
      if (e.isOver) return;
      const log: Fill[] = [];

      if (kind === 'buy') {
        // 用可用现金全仓买入——新手模式不引入融资，所以不会买超
        const cash = Math.max(0, e.state.player.cash);
        if (cash >= 1) e.submitByNotional(selected, cash);
      } else if (kind === 'short') {
        const equity = Math.max(0, e.state.player.equity);
        if (equity >= 1) e.submitByNotional(selected, -equity);
      } else if (kind === 'redeem') {
        for (const p of [...e.state.player.positions.values()]) {
          e.submitOrder({
            instrumentId: p.instrumentId,
            side: p.quantity > 0 ? 'sell' : 'buy',
            quantity: Math.abs(p.quantity),
            kind: 'market',
            submittedAt: e.state.date,
          });
        }
      }
      // wait：什么都不做，直接推进

      advanceToNews(log);
      bump();
    },
    [selected, advanceToNews],
  );

  const hints = buildHints(engine).slice(0, 2);
  const news = [...engine.state.news].slice(-6).reverse();
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2] ?? last;
  const chg = last && prev ? last.close - prev.close : 0;
  const chgPct = last && prev && prev.close > 0 ? last.close / prev.close - 1 : 0;
  const up = chg >= 0;

  const held = s.positions.filter((p) => Math.abs(p.qty) > 0);
  const marketValue = held.reduce((a, p) => a + Math.abs(p.qty) * p.price, 0);
  const floatPnl = held.reduce((a, p) => a + p.pnl, 0);

  return (
    <div className="beginner">
      <div className="b-top">
        <div className="b-date">
          <b>{s.date}</b>
          <span className="dim">第 {s.turnIndex} 个交易日</span>
        </div>
        <div className="b-equity">
          <span className="k">总资产</span>
          <span className="v">{money(s.equity)}</span>
          <span className={`d ${ret >= 0 ? 'pos' : 'neg'}`}>
            {ret >= 0 ? '+' : ''}
            {pct(ret)}
          </span>
        </div>
        <button className="ghost" onClick={onRestart} {...restartTip}>
          重开
        </button>
      </div>

      <div className="b-body">
        {/* ---------------- 左：行情与操作 ---------------- */}
        <div className="b-left">
          <div className="b-tabs">
            {D0_INSTRUMENTS.map((i) => (
              <button
                key={i.id}
                className={i.id === selected ? 'active' : ''}
                onClick={() => setSelected(i.id)}
              >
                <b>{i.name}</b>
                <span>{i.hint}</span>
              </button>
            ))}
          </div>

          <div className="b-quote">
            <div className="b-quote-head">
              <span className="nm">{inst.name}</span>
              <span className={`px ${up ? 'pos' : 'neg'}`}>{last ? last.close.toFixed(2) : '—'}</span>
              <span className={`chg ${up ? 'pos' : 'neg'}`}>
                {up ? '+' : ''}
                {chg.toFixed(2)}（{up ? '+' : ''}
                {pct(chgPct)}）
              </span>
            </div>
            <SimpleChart bars={bars} instrumentId={selected} />
            <div className="b-quote-foot">
              <div className="row">
                <span className="k">今日</span>
                <span>
                  开 {last?.open.toFixed(2)} · 高 {last?.high.toFixed(2)} · 低 {last?.low.toFixed(2)}
                </span>
              </div>
              <div className="row">
                <span className="k">区间</span>
                <span>
                  最高 {Math.max(...bars.map((b) => b.high)).toFixed(2)} · 最低{' '}
                  {Math.min(...bars.map((b) => b.low)).toFixed(2)}
                </span>
              </div>
              <p className="desc">{inst.desc}</p>
            </div>
          </div>

          {hints.map((h, i) => (
            <div key={i} className={`hint ${h.level}`}>
              {h.text}
            </div>
          ))}

          {engine.isOver && !s.bankrupt && (
            <div className="banner info">2009 年结束了。你活了下来——这在这个游戏里已经不算容易。</div>
          )}
          {s.bankrupt && (
            <div className="banner danger">
              <b>你的钱亏光了，这一局结束。</b> 让你出局的往往不是判断错了方向，
              而是**在正确的方向上没能活到明天**。
            </div>
          )}

          <div className="b-actions">
            <button className="big buy" onClick={() => act('buy')} disabled={engine.isOver} {...buyTip}>
              买入
            </button>
            <button className="big sell" onClick={() => act('short')} disabled={engine.isOver} {...shortTip}>
              做空
            </button>
            <button className="big wait" onClick={() => act('wait')} disabled={engine.isOver} {...waitTip}>
              观望
            </button>
            <button
              className="big redeem"
              onClick={() => act('redeem')}
              disabled={engine.isOver || held.length === 0}
              {...redeemTip}
            >
              赎回
            </button>
          </div>
          <div className="b-actions-note">
            每个按钮都会推进到下一条新闻 —— 你不需要考虑「该什么时候前进」。
          </div>
        </div>

        {/* ---------------- 右：模拟盘与新闻 ---------------- */}
        <div className="b-right">
          <div className="b-panel">
            <h3>
              <Tip
                text={
                  '模拟盘\n\n' +
                  '这是一个虚拟账户，起始资金 10 万美元，和真实交易无关。\n\n' +
                  '「买入」用你的现金换持仓；「做空」是借来先卖、跌了再买回；' +
                  '「赎回」把持仓换回现金。'
                }
              >
                我的模拟盘 ⓘ
              </Tip>
            </h3>

            <div className="b-acct">
              <div className="line">
                <span>可用现金</span>
                <b>{money(s.cash)}</b>
              </div>
              <div className="line">
                <span>持仓市值</span>
                <b>{money(marketValue)}</b>
              </div>
              <div className="line total">
                <span>总资产</span>
                <b>{money(s.equity)}</b>
              </div>
              {held.length > 0 && (
                <div className="line">
                  <span>浮动盈亏</span>
                  <b className={floatPnl >= 0 ? 'pos' : 'neg'}>{signed(floatPnl)}</b>
                </div>
              )}
            </div>

            <table className="b-holdings">
              <thead>
                <tr>
                  <th>标的</th>
                  <th>股数</th>
                  <th>成本</th>
                  <th>现价</th>
                  <th>盈亏</th>
                </tr>
              </thead>
              <tbody>
                {held.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="dim" style={{ textAlign: 'center', padding: '10px 0' }}>
                      空仓
                    </td>
                  </tr>
                ) : (
                  held.map((p) => {
                    const nm = D0_INSTRUMENTS.find((i) => i.id === p.id)?.name ?? p.id;
                    return (
                      <tr key={p.id}>
                        <td>{nm}</td>
                        <td className={p.qty >= 0 ? 'pos' : 'neg'}>{p.qty}</td>
                        <td>{p.avgPrice.toFixed(2)}</td>
                        <td>{p.price.toFixed(2)}</td>
                        <td className={p.pnl >= 0 ? 'pos' : 'neg'}>
                          {signed(p.pnl)}
                          <span className="dim">
                            {' '}
                            ({pct(p.avgPrice > 0 ? p.price / p.avgPrice - 1 : 0)})
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>

            {trades.length > 0 && (
              <div className="b-trades">
                <div className="dim" style={{ marginBottom: 4 }}>
                  最近成交
                </div>
                {trades.map((f, i) => {
                  const nm = D0_INSTRUMENTS.find((x) => x.id === f.order.instrumentId)?.name ?? f.order.instrumentId;
                  return (
                    <div key={i} className="trade">
                      <span className="dim">{f.filledAt}</span>
                      <span className={f.order.side === 'buy' ? 'pos' : 'neg'}>
                        {f.order.side === 'buy' ? '买入' : '卖出'}
                      </span>
                      <span>
                        {nm} {f.quantity} 股
                      </span>
                      <span className="dim">@{f.price.toFixed(2)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="b-panel">
            <h3>新闻</h3>
            {news.length === 0 && <div className="dim">还没有消息。点任意操作按钮推进时间。</div>}
            {news.map((n) => (
              <div
                key={n.id}
                className={`news ${n.source === 'historical' ? 'crisis' : n.source === 'generated' ? 'rumor' : ''}`}
              >
                <div className="head">
                  {n.source === 'generated' && (
                    <span className="tag">传闻 · 可信度 {Math.round(n.credibility * 100)}%</span>
                  )}
                  {n.headline}
                </div>
                <div className="body">{n.body}</div>
                <div className="dim" style={{ fontSize: 10, marginTop: 4 }}>
                  {n.date}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="disclaimer">
        历史模拟，非投资建议。种子 {engine.config.seed} · 难度 D0（新手模式）· 数据来源{' '}
        {engine.config.timeline === 'historical' ? '历史回放' : '小幅抖动'}
      </div>
    </div>
  );
}
