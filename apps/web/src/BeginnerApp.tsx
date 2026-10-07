/** D0: trades advance one day; waiting advances at most five trading days with risk stops. */

import { useCallback, useMemo, useReducer, useRef, useState } from 'react';

import type { Fill, GameEngine } from '@cyscc/core';
import { BEGINNER_RULES, beginnerPeriod, reviewRun } from '@cyscc/core';

import { SimpleChart } from './SimpleChart.tsx';
import { Tip, useTip } from './Tip.tsx';
import { buildHints, FILL_REASON } from './glossary.ts';

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
  buy: '买入\n\n按选定比例的现金提交买入；实际成交会预留手续费，并受新手持仓额度限制。\n\n价格涨了你赚钱，跌了你亏钱。最坏情况是亏光本金，不会更多。',
  short:
    '做空\n\n先借来卖出，等价格跌了再买回来还掉，赚差价。\n\n' +
    '价格跌你赚钱；**价格涨你亏钱，而且亏损没有上限**——因为股价理论上可以无限涨。\n\n' +
    '若已有同一标的的多头，会先卖出多头，剩余数量才建立空头。请以成交后持仓为准。',
  wait:
    '观望\n\n最多观望 5 个交易日；遇到事件、成交、追保或期间净值下跌 3% 时提前暂停。\n\n' +
    '**观望不是错误的决定。** 危机里可以保留现金，等待更清楚的信号。',
  redeem:
    '平仓\n\n卖出多头、买回空头，退出持仓。\n\n' +
    '行情不好的时候，可能只能卖掉一部分——想跑却跑不掉，这是 2008 年的真实体感。',
} as const;

type ActionKind = keyof typeof ACTIONS;

const money = (v: number) =>
  v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const exactMoney = (v: number) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (v: number) => `${v >= 0 ? '+' : ''}${money(v)}`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

interface Props {
  engine: GameEngine;
  /** 引擎状态变更后触发父组件重渲染 */
  onChange: () => void;
  onRestart: () => void;
  storageNote?: string;
}

export function BeginnerApp({ engine, onChange, onRestart, storageNote }: Props) {
  const [selected, setSelected] = useState('SPX');
  const [trades, setTrades] = useState<Fill[]>(() => engine.turnReports.flatMap(r => r.fills).slice(-6));
  const [fraction, setFraction] = useState(0.5);
  const [stepNote, setStepNote] = useState('');
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const engineRef = useRef(engine);
  engineRef.current = engine;

  const buyTip = useTip(ACTIONS.buy);
  const shortTip = useTip(ACTIONS.short);
  const waitTip = useTip(ACTIONS.wait);
  const redeemTip = useTip(ACTIONS.redeem);
  const restartTip = useTip('重开\n\n回到开始界面，重新选择种子、难度与时间线。');

  const s = engine.summary();
  const chapter = beginnerPeriod(engine.config);
  const review = reviewRun(engine.config, s.equity, s.maxDrawdown, s.bankrupt, engine.turnReports);
  const lastReport = engine.turnReports.at(-1);
  const inst = D0_INSTRUMENTS.find((i) => i.id === selected) ?? D0_INSTRUMENTS[0];
  const bars = useMemo(
    () => engine.visibleBars(selected),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, selected, engine.state.turnIndex],
  );

  const ret = s.equity / engine.config.initialCapital - 1;

  /** 交易只推进一天；观望有明确上限和风险暂停。 */
  const advanceSession = useCallback(
    (log: Fill[], days: number) => {
      const e = engineRef.current;
      let advanced = 0;
      const startingEquity = e.state.player.equity;
      let reason = '已到达本次推进上限';
      for (let i = 0; i < days; i++) {
        if (e.isOver) break;
        const res = e.advance();
        advanced++;
        if (res.fills.length > 0) log.push(...res.fills);
        if (e.isOver || res.marginCall || res.fills.length > 0 || res.firedEventIds.length > 0 || res.equity <= startingEquity * 0.97) {
          reason = e.isOver ? '本局结束' : res.marginCall ? '需要处理账户风险' : res.fills.length > 0 ? '请查看成交结果' : res.firedEventIds.length > 0 ? '出现新事件' : '期间净值下跌达到 3%';
          break;
        }
      }
      if (log.length > 0) setTrades((prev) => [...prev, ...log].slice(-6));
      setStepNote(`推进 ${advanced} 个交易日：${reason}。`);
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
        // 按现金提交，开盘时由引擎按实际价格与账户额度裁剪。
        const cash = Math.max(0, e.state.player.cash);
        if (cash >= 1) e.submitByNotional(selected, cash * fraction);
      } else if (kind === 'short') {
        const equity = Math.max(0, e.state.player.equity);
        if (equity >= 1) e.submitByNotional(selected, -equity * fraction);
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

      advanceSession(log, kind === 'wait' ? 5 : 1);
      bump();
    },
    [selected, fraction, advanceSession],
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

      {storageNote && <div className="b-actions-note" role="status">{storageNote}</div>}
      {chapter && <div className="banner info">
        <b>{chapter.title}</b> · {engine.config.startDate} 至 {engine.config.endDate} · 剩余 {engine.isOver ? 0 : engine.remainingTurns} 个交易日
        <p>{chapter.briefing}</p>
        <p>目标：结束时保留至少 {money(engine.config.initialCapital * chapter.capitalFloor)} 净资产。
        风控挑战：最大回撤不超过 {pct(chapter.drawdownLimit)}，且不触发自动回补。保留现金同样可以完成目标。</p>
      </div>}
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
              <p className="desc">
                行情来源：{last?.provenance === 'historical' ? '数据集历史日线' : last?.provenance === 'estimated' ? '数据集简化或回填日线，开盘价未必是历史真实开盘价' : last?.provenance === 'carried' ? '当日数据缺失，沿用上一日估值；暂停该标的交易' : '合成估算价格'}。
                历史日线不叠加事件涨跌；新闻在事件日期或下一交易日显示。
              </p>
            </div>
          </div>

          {hints.map((h, i) => (
            <div key={i} className={`hint ${h.level}`}>
              {h.text}
            </div>
          ))}

          {engine.isOver && !s.bankrupt && (
            <div className="banner info">本局已到达 {engine.config.endDate}。查看右侧复盘了解资金变化。</div>
          )}
          {s.bankrupt && (
            <div className="banner danger">
              <b>你的钱亏光了，这一局结束。</b> 让你出局的往往不是判断错了方向，
              而是**在正确的方向上没能活到明天**。
            </div>
          )}

          {stepNote && <div className="banner info" role="status">{stepNote}</div>}
          <label className="b-actions-note">
            本次交易比例（买入按现金，做空按净资产）：
            <select value={fraction} disabled={engine.isOver} onChange={e => setFraction(Number(e.target.value))}>
              <option value={0.25}>25%</option><option value={0.5}>50%</option><option value={1}>100%</option>
            </select>
          </label>
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
              平仓
            </button>
          </div>
          <div className="b-actions-note">
            买卖与平仓推进 1 个交易日；观望最多推进 5 日，遇到事件或风险提前暂停。新增仓位须满足持仓总额不超过账户权益。
          </div>
        </div>

        {/* ---------------- 右：模拟盘与新闻 ---------------- */}
        <div className="b-right">
          {lastReport && <div className="b-panel">
            <h3>本回合资金变化 · {lastReport.date}</h3>
            <div className="line">期初净资产：{exactMoney(lastReport.equityBefore)}</div>
            <div className="line">持仓与交易价差：{lastReport.marketPnl >= 0 ? '+' : ''}{exactMoney(lastReport.marketPnl)}</div>
            <div className="line">交易手续费：−{exactMoney(lastReport.commission)}</div>
            <div className="line">做空持有费：−{exactMoney(lastReport.borrowFees)}</div>
            <div className="line">期末净资产：{exactMoney(lastReport.equityAfter)}</div>
          </div>}
          {engine.isOver && <div className="b-panel">
            <h3>本局复盘</h3>
            <p>{s.bankrupt ? '账户已破产。' : '已完成本局。'} 净收益 {signed(s.equity - engine.config.initialCapital)}，最大回撤 {pct(s.maxDrawdown)}。</p>
            {chapter && <p>本金目标：{review.capitalPreserved && review.survived ? '完成' : '未完成'}；
              回撤挑战：{review.drawdownControlled ? '完成' : '未完成'}；
              避免自动回补：{review.noForcedClose ? '完成' : '未完成'}。</p>}
            <p>累计手续费 {money(review.commissions)}，做空持有费 {money(review.borrowFees)}，自动回补 {review.riskCloses} 次。</p>
            {review.worstDay && review.worstDay.equityAfter < review.worstDay.equityBefore && <p>
              最大单日净损失发生在 {review.worstDay.date}：{money(review.worstDay.equityBefore - review.worstDay.equityAfter)}。
              当日持仓与交易价差 {signed(review.worstDay.marketPnl)}，费用合计 {money(review.worstDay.commission + review.worstDay.borrowFees)}。
              {review.worstDay.fills.some(f => f.reason === 'risk_close') ? '当日触及空头风险底线并自动回补。' : ''}
            </p>}
            <p>复盘只依据本局实际成交与每日净值，未把同时出现的新闻认定为损失的唯一原因。</p>
          </div>}

          <div className="b-panel">
            <h3>
              <Tip
                text={
                  '模拟盘\n\n' +
                  `这是一个虚拟账户，起始资金 ${money(engine.config.initialCapital)}，和真实交易无关。\n\n` +
                  '「买入」用你的现金换持仓；「做空」是借来先卖、跌了再买回；' +
                  '「平仓」把持仓换回现金。'
                }
              >
                我的模拟盘 ⓘ
              </Tip>
            </h3>

            <p className="desc">
              D0 散户教学规则：不启用 NPC、传闻、回购融资和监管处罚。
              做空按空头市值收取年化 {pct(BEGINNER_RULES.borrowFeeRate)} 的费用，每交易日按年费的 1/252 计提。
              收盘净资产低于空头市值的 {pct(BEGINNER_RULES.shortMaintenanceRate)} 时，按收盘价自动买回全部空头，另收正常手续费。
              跳空仍可能导致损失超过本金。
            </p>

            <div className="b-acct">
              <div className="line">
                <span>账户现金（含卖空所得）</span>
                <b>{money(s.cash)}</b>
              </div>
              <div className="line">
                <span>持仓总额（多空绝对值）</span>
                <b>{money(marketValue)}</b>
              </div>
              <div className="line total">
                <span>总资产</span>
                <b>{money(s.equity)}</b>
              </div>
              {s.positions.some((p) => p.qty < 0) && (
                <div className="line">
                  <span>空头风险底线（净资产）</span>
                  <b>{money(engine.state.player.maintenanceMargin)}</b>
                </div>
              )}
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
                  const rejected = f.quantity <= 0;
                  return (
                    <div key={i} className="trade">
                      <span className="dim">{f.filledAt}</span>
                      <span className={f.order.side === 'buy' ? 'pos' : 'neg'}>
                        {f.order.side === 'buy' ? '买入' : '卖出'}
                      </span>
                      {rejected ? (
                        // 显示「卖出 0 股」等于什么都没说。玩家必须知道为什么没成交。
                        <span className="neg">
                          {nm} · {FILL_REASON[f.reason] ?? f.reason}
                        </span>
                      ) : (
                        <>
                          <span>
                            {nm} {f.quantity} 股
                          </span>
                          <span className="dim">@{f.price.toFixed(2)}{f.reason !== 'ok' ? ` · ${FILL_REASON[f.reason] ?? f.reason}` : ''}</span>
                        </>
                      )}
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
                <div className="body">{n.source === 'historical' && !engine.isOver ? '历史后续与回顾解读将在本局结束后展示，避免提前透露行情。' : n.body}</div>
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
        历史时间线（行情含简化数据，以面板来源说明为准）
      </div>
    </div>
  );
}
