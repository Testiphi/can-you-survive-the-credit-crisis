/**
 * 你能不能逃过信贷危机 —— P0 原型界面。
 *
 * 目标只有一个：验证「看新闻 → 做多/做空/清仓 → 承担后果」这个循环是否有张力。
 * 所以这里刻意只有三个操作按钮。
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  GameEngine,
  BEGINNER_PERIODS,
  INSTRUMENTS,
  LEVEL_LABEL,
  type Difficulty,
  type Identity,
  type TimelineMode,
} from '@cyscc/core';
import { dataset } from './dataset.ts';
import { KLineChart } from './KLineChart.tsx';
import { EquityChart } from './EquityChart.tsx';
import { Tip, useTip } from './Tip.tsx';
import { BUTTON_TIPS, FILL_REASON, GLOSSARY, buildHints } from './glossary.ts';
import { QuotePanel, computeQuote } from './QuotePanel.tsx';
import { BeginnerApp } from './BeginnerApp.tsx';

const TRADABLE = INSTRUMENTS.filter((i) => i.sector !== 'index');
const TABS = ['SPX', ...TRADABLE.map((i) => i.id)];

/**
 * 「快进到事件」的安全阀（交易日）。
 *
 * 危机后期事件会变稀疏——2009 年年中可能连续几个月没有卡片触发。
 * 没有上限的话，一次点击会一路推进到游戏结束，玩家会以为按钮坏了。
 * 约 6 个月是一个合理的「跳过平静期」尺度。
 */
const MAX_EVENT_HUNT_DAYS = 120;

const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  0: 'D0 · 新手模式（推荐第一次玩）',
  1: 'D1 · 标准（宏观指标 + 完整标的）',
  2: 'D2 · 进阶（加上融资与监管）',
  3: 'D3 · 硬核（噪声、监管、冲击全开）',
};

const IDENTITY_LABEL: Record<Identity, string> = {
  retail: '散户（$10 万）',
  hedge_fund: '对冲基金（$1000 万）',
  bank: '投行自营（$10 亿）',
  insurer: '保险 / 再保险（$100 亿）',
};

const TIMELINE_LABEL: Record<TimelineMode, string> = {
  historical: '历史回放（事件按史实日期发生）',
  jittered: '小幅抖动 ±10 交易日（推荐）',
  parallel: '平行时间线 ±30 交易日',
};

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function App() {
  const [started, setStarted] = useState(false);
  const [seed, setSeed] = useState(42);
  const [difficulty, setDifficulty] = useState<Difficulty>(0);
  const [identity, setIdentity] = useState<Identity>('retail');
  const [periodId, setPeriodId] = useState('crisis');
  const [timeline, setTimeline] = useState<TimelineMode>('jittered');
  const [, forceRender] = useState(0);
  const [selected, setSelected] = useState('LEH');
  const [showMA, setShowMA] = useState(true);
  const [skipNote, setSkipNote] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState<string | null>(null);

  const [storageNote, setStorageNote] = useState('');
  const [hasSave, setHasSave] = useState(() => {
    try { return localStorage.getItem('cyscc-d0-save') !== null; } catch { return false; }
  });
  const persist = useCallback((e: GameEngine) => {
    if (e.config.difficulty !== 0) return;
    try {
      localStorage.setItem('cyscc-d0-save', JSON.stringify(e.save()));
      setHasSave(true);
      setStorageNote(`已自动保存至 ${e.state.date}。刷新后可在开始页继续。`);
    } catch {
      setStorageNote('自动保存失败：浏览器存储不可用或已满。当前游戏仍可继续，请先不要关闭页面。');
    }
  }, []);
  const engineRef = useRef<GameEngine | null>(null);
  const tickRef = useRef(0);

  const createEngine = useCallback(
    (opts: { seed: number; difficulty: Difficulty; identity: Identity; timeline: TimelineMode }) => {
      const period = BEGINNER_PERIODS.find(p => p.id === periodId);
      engineRef.current = new GameEngine(dataset, {
        config: {
          seed: opts.seed,
          difficulty: opts.difficulty,
          identity: opts.identity,
          timeline: opts.timeline,
          ...(opts.difficulty === 0 && period ? {
            startDate: period.startDate, endDate: period.endDate,
          } : {}),
        },
      });
      tickRef.current = 0;
      setSelected('LEH');
      persist(engineRef.current);
      forceRender((n) => n + 1);
    },
    [persist, periodId],
  );

  const engine = engineRef.current;

  const proceed = useCallback(
    (steps: number, stopOnEvent: boolean) => {
      const e = engineRef.current;
      if (!e) return 0;
      let advanced = 0;
      let fired = 0;
      let rejected: string | null = null;
      for (let i = 0; i < steps; i++) {
        if (e.isOver) break;
        const res = e.advance();
        tickRef.current++;
        advanced++;
        fired += res.firedEventIds.length;
        // 记录被拒绝/未成交的订单。早前这些失败完全静默——
        // 玩家点了「做空」，什么也没发生，也没有任何提示。
        for (const f of res.fills) {
          if (!rejected && (f.quantity <= 0 || f.reason !== 'ok')) {
            rejected = `${f.order.instrumentId}：${FILL_REASON[f.reason] ?? f.reason}`;
          }
        }
        if (stopOnEvent && res.firedEventIds.length > 0) break;
      }
      setRejectNote(rejected);
      // 快进到事件却没撞上事件时给出明确反馈，
      // 否则玩家会以为按钮坏了（危机后期事件确实会变稀疏）
      if (stopOnEvent) {
        setSkipNote(
          fired === 0 && advanced > 0 && !e.isOver
            ? `快进 ${advanced} 个交易日 —— 这段时间没有任何历史事件。市场平静得不太正常。`
            : null,
        );
      } else {
        setSkipNote(null);
      }
      forceRender((n) => n + 1);
      return advanced;
    },
    [],
  );

  /**
   * 快进到下一个事件。
   *
   * 上限 MAX_EVENT_HUNT_DAYS 是必要的安全阀：危机后期事件稀疏
   * （例如 2009 年年中可能连续几个月没有卡片触发），没有上限会一路跑到底。
   */
  const proceedToEvent = useCallback(() => {
    proceed(MAX_EVENT_HUNT_DAYS, true);
  }, [proceed]);

  const advanceDays = useCallback(
    (n: number) => {
      const e = engineRef.current;
      if (!e) return;
      const date = e.state.date;
      // 玩家在 t 日下单，t+1 成交——所以先推进再下单会有未来函数风险。
      // 这里的顺序是：先下单（针对次日），再推进。
      void date;
      proceed(n, false);
    },
    [proceed],
  );

  const order = useCallback(
    (side: 'buy' | 'sell', fraction: number) => {
      const e = engineRef.current;
      if (!e) return;
      const notional = Math.max(0, e.state.player.equity * fraction);
      if (notional < 1) return;
      setSkipNote(null);
      e.submitByNotional(selected, side === 'buy' ? notional : -notional);
      forceRender((n) => n + 1);
    },
    [selected],
  );

  const flatten = useCallback(() => {
    const e = engineRef.current;
    if (!e) return;
    setSkipNote(null);
    for (const p of [...e.state.player.positions.values()]) {
      e.submitOrder({
        instrumentId: p.instrumentId,
        side: p.quantity > 0 ? 'sell' : 'buy',
        quantity: Math.abs(p.quantity),
        kind: 'market',
        submittedAt: e.state.date,
      });
    }
    forceRender((n) => n + 1);
  }, []);

  const bars = useMemo(
    () => (engine ? engine.visibleBars(selected) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, selected, tickRef.current],
  );

  // 行情统计（现价、区间高低、均线、波动率……）——同样只基于可见 K 线
  const quote = useMemo(() => computeQuote(bars), [bars]);

  // 净值曲线与「标普买入持有」基准。
  // 基准按初始资金归一化，两条线才能放在同一尺度上比较。
  const equityCurve = useMemo(
    () => (engine ? engine.state.score.map((snap) => ({ time: snap.date, value: snap.equity })) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, tickRef.current],
  );

  const benchmarkCurve = useMemo(() => {
    if (!engine) return [];
    const spxBars = engine.visibleBars('SPX');
    const base = spxBars[0]?.close ?? 1;
    const capital = engine.config.initialCapital;
    return spxBars.map((b) => ({ time: b.date, value: (capital * b.close) / base }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, tickRef.current]);

  // 所有按钮的悬浮说明。useTip 是 hook，必须在任何条件返回之前调用。
  const startTip = useTip(
    '开始\n\n用当前选择的种子、难度和身份开始一局。\n\n同一个种子会生成完全相同的市场与事件时点，' +
      '所以你可以用同一个种子对比不同策略，也可以把种子告诉别人来比成绩。',
  );
  const buy25Tip = useTip(BUTTON_TIPS.buy25);
  const buy100Tip = useTip(BUTTON_TIPS.buy100);
  const sell25Tip = useTip(BUTTON_TIPS.sell25);
  const sell100Tip = useTip(BUTTON_TIPS.sell100);
  const flattenTip = useTip(BUTTON_TIPS.flatten);
  const advance1Tip = useTip(BUTTON_TIPS.advance1);
  const advanceEventTip = useTip(BUTTON_TIPS.advanceEvent);
  const advanceMonthTip = useTip(BUTTON_TIPS.advanceMonth);
  const restartTip = useTip(BUTTON_TIPS.restart);
  const maTip = useTip(
    '均线开关\n\n切换 K 线上的 MA20（橙）与 MA60（棕）移动平均线。\n\n' +
      '均线是用来看趋势的：价格在均线上方通常是上升趋势，下方是下降趋势。\n\n' +
      '危机里均线会变成压力位——每次反弹到均线附近就掉头向下。',
  );

  // ------------------------------------------------------------ 开始界面

  if (!started) {
    return (
      <div className="setup">
        <h1>你能不能逃过信贷危机</h1>
        <p>
          你手握一笔资金，进入信贷危机中的市场。选择短章节或完整复演，练习管理风险。
          <br />
          你只能看到今天及以前的信息——明天是未知的。
        </p>
        <div style={{ marginTop: 26 }}>
          <label>
            <span>
              <Tip text={BUTTON_TIPS.seed}>随机种子 ⓘ</Tip>（同一个种子 = 同一场危机）
            </span>
            <input
              type="number"
              value={seed}
              onChange={(e) => setSeed(Number(e.target.value) || 0)}
              style={{ width: 140 }}
            />
          </label>
          <label>
            <span>
              <Tip text={BUTTON_TIPS.difficulty}>难度 ⓘ</Tip>
            </span>
            <select value={difficulty} onChange={(e) => setDifficulty(Number(e.target.value) as Difficulty)}>
              {([0, 1, 2, 3] as Difficulty[]).map((d) => (
                <option key={d} value={d}>
                  {DIFFICULTY_LABEL[d]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>
              <Tip text={BUTTON_TIPS.identity}>身份 ⓘ</Tip>
            </span>
            <select value={difficulty === 0 ? 'retail' : identity} disabled={difficulty === 0} onChange={(e) => setIdentity(e.target.value as Identity)}>
              {(Object.keys(IDENTITY_LABEL) as Identity[]).map((k) => (
                <option key={k} value={k}>
                  {IDENTITY_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>
              <Tip text={BUTTON_TIPS.timeline}>时间线模式 ⓘ</Tip>
            </span>
            <select value={difficulty === 0 ? 'historical' : timeline} disabled={difficulty === 0} onChange={(e) => setTimeline(e.target.value as TimelineMode)}>
              {(Object.keys(TIMELINE_LABEL) as TimelineMode[]).map((k) => (
                <option key={k} value={k}>
                  {TIMELINE_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          {difficulty === 0 && (
            <label>
              <span>游玩时期</span>
              <select value={periodId} onChange={e => setPeriodId(e.target.value)}>
                {BEGINNER_PERIODS.map(p => <option key={p.id} value={p.id}>{p.title}（{p.startDate.slice(0, 7)} 至 {p.endDate.slice(0, 7)}）</option>)}
                <option value="full">完整复演：2007—2009</option>
              </select>
            </label>
          )}
          <button
            className="primary"
            {...startTip}
            onClick={() => {
              createEngine({ seed, difficulty, identity, timeline });
              setStarted(true);
            }}
          >
            开始
          </button>
        </div>
        {hasSave && (
          <button className="primary" onClick={() => {
            try {
              const raw = localStorage.getItem('cyscc-d0-save');
              if (!raw) throw new Error('未找到存档');
              const restored = GameEngine.restore(dataset, JSON.parse(raw));
              engineRef.current = restored;
              tickRef.current = restored.state.turnIndex;
              setStarted(true);
              setStorageNote(`已恢复至 ${restored.state.date}。`);
            } catch (error) {
              setStorageNote(`无法恢复：${error instanceof Error ? error.message : String(error)}。原存档未删除。`);
            }
          }}>继续上次 D0 游戏</button>
        )}
        {storageNote && <p role="status">{storageNote}</p>}
        {hasSave && <p>开始新的 D0 游戏会覆盖上次存档；D1 及以上暂不提供自动续玩。</p>}
        {difficulty === 0 && (
          <div className="hint info" style={{ marginTop: 22, textAlign: 'left' }}>
            <b>D0 是新手模式：只有 2 个标的、4 个按钮。</b>
            {'\n\n'}
            固定使用散户账户和历史时间线，事件日期不随种子漂移。先练习买入、做空和管理持仓，不启用 NPC、真假传闻、回购融资或监管处罚。
            {'\n\n'}
            买入、做空和平仓推进 1 个交易日；观望最多推进 5 日，遇到事件或风险提前暂停。
            {'\n\n'}
            保留适合新手的历史事件新闻。做空按固定费率收费，触及明确的风险底线时自动回补；具体规则可在账户面板查看。
          </div>
        )}
        {difficulty !== 0 && (
          <div className="hint info" style={{ marginTop: 22, textAlign: 'left' }}>
            <b>D1 及以上是标准模式：完整标的、K 线、宏观指标。</b>
            {'\n\n'}
            每个按钮、每个指标名都可以把鼠标停上去看说明。
            {'\n\n'}
            如果你是第一次玩，建议退回 <b>D0 新手模式</b>——先弄懂这个游戏在讲什么，
            再来看这些数字。
          </div>
        )}
        <p style={{ marginTop: 22, fontSize: 11 }}>
          已载入 {dataset.events.length} 张事件卡 · {dataset.institutions.institutions.length} 家机构 ·{' '}
          {dataset.rumors.templates.length} 类传闻
        </p>
      </div>
    );
  }

  if (!engine) return null;

  // ---- D0 新手模式：换一套完全不同的交互模型，而不是「少显示几项」 ----
  // 见 BeginnerApp.tsx 顶部的说明。这里只做分发。
  if (engine.config.difficulty === 0) {
    return (
      <BeginnerApp
        engine={engine}
        storageNote={storageNote}
        onChange={() => { persist(engine); forceRender((n) => n + 1); }}
        onRestart={() => {
          setStarted(false);
          engineRef.current = null;
          forceRender((n) => n + 1);
        }}
      />
    );
  }

  const s = engine.summary();
  const m = s.macro;
  const ret = s.equity / engine.config.initialCapital - 1;
  // 相对「标普买入持有」的表现——这个游戏真正的记分方式
  const benchNow = benchmarkCurve[benchmarkCurve.length - 1]?.value ?? engine.config.initialCapital;
  const relVsBench = benchNow > 0 ? s.equity / benchNow - 1 : 0;
  const news = [...engine.state.news].reverse().slice(0, 40);
  const lateEvents = engine.state.firedEvents.slice(-3);

  // 情境提示：低难度给更多、更直白的引导
  const hints = buildHints(engine);

  // 难度门控 —— 与 docs/01 §4.2 的难度矩阵保持一致：
  //   D0 只有 K 线 / 成交量 / 新闻标题
  //   D1 加上宏观指标（信用利差 / TED / VIX / 流动性）
  //   D2+ 加上融资机制（回购折扣率 / 融资容量 / 展期率）
  //   D2+ 才显示监管足迹（小资金玩家的 SRS 永远接近 0，机制不激活）
  const showMacro = engine.config.difficulty >= 1;
  const showFunding = engine.config.difficulty >= 2 || engine.config.identity !== 'retail';
  const showRegulator = engine.config.difficulty >= 2 || engine.config.identity !== 'retail';

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">你能不能逃过信贷危机</span>
        <div className="stat">
          <span className="k">日期</span>
          <span className="v">{s.date}</span>
        </div>
        <div className="stat">
          <span className="k">权益</span>
          <span className="v">{money(s.equity)}</span>
        </div>
        <div className="stat">
          <span className="k">收益率</span>
          <span className={`v ${ret >= 0 ? 'pos' : 'neg'}`}>{pct(ret)}</span>
        </div>
        <div className="stat">
          <span className="k">现金</span>
          <span className="v">{money(s.cash)}</span>
        </div>
        <div className="stat">
          <span className="k">
            <Tip text={GLOSSARY.maxDrawdown.detail}>最大回撤 ⓘ</Tip>
          </span>
          <span className="v warn">{pct(s.maxDrawdown)}</span>
        </div>
        <div className="stat">
          <span className="k">
            <Tip text={`${GLOSSARY.spx.plain}\n\n${GLOSSARY.vix.plain}\n\n${GLOSSARY.vix.detail}`}>
              标普 / VIX ⓘ
            </Tip>
          </span>
          <span className="v">
            {m.spx.toFixed(0)} / {m.vix.toFixed(1)}
          </span>
        </div>
        <span className="spacer" />
        <button onClick={() => advanceDays(1)} disabled={engine.isOver} {...advance1Tip}>
          推进 1 天
        </button>
        <button onClick={proceedToEvent} disabled={engine.isOver} {...advanceEventTip}>
          快进到事件
        </button>
        <button onClick={() => proceed(21, false)} disabled={engine.isOver} {...advanceMonthTip}>
          快进 1 个月
        </button>
        <button
          {...restartTip}
          onClick={() => {
            setStarted(false);
            engineRef.current = null;
          }}
        >
          重开
        </button>
      </div>

      <div className="main">
        {/* ---------------- 左：K 线 ---------------- */}
        <div className="col">
          <div className="tabs">
            {TABS.map((id) => (
              <button key={id} className={id === selected ? 'active' : ''} onClick={() => setSelected(id)}>
                {id}
              </button>
            ))}
            <span className="spacer" style={{ flex: 1 }} />
            <button
              className={showMA ? 'active' : ''}
              onClick={() => setShowMA((v) => !v)}
              {...maTip}
            >
              {showMA ? '均线 开' : '均线 关'}
            </button>
          </div>
          <KLineChart bars={bars} instrumentId={selected} showMA={showMA} />

          {quote && (
            <div className="panel" style={{ marginTop: 10 }}>
              <h3>
                <Tip
                  text={
                    '行情数据\n\n' +
                    '全部来自「今天及以前」的 K 线，不包含未来信息。\n\n' +
                    '把鼠标停在任意一行上会解释它的含义与危险水平。'
                  }
                >
                  行情数据 ⓘ
                </Tip>
              </h3>
              <QuotePanel stats={quote} instrumentId={selected} />
            </div>
          )}

          <div className="panel" style={{ marginTop: 10 }}>
            <h3>
              <Tip text={`${GLOSSARY.spx.plain}\n\n${GLOSSARY.spx.detail}`}>净值曲线 ⓘ</Tip>
            </h3>
            <div className="curve-legend">
              <span>
                <i className="dot-eq" />
                你的净值
              </span>
              <span>
                <i className="dot-bm" />
                标普买入持有
              </span>
              <span className="spacer" />
              <span>
                相对基准{' '}
                <b className={relVsBench >= 0 ? 'pos' : 'neg'}>
                  {relVsBench >= 0 ? '+' : ''}
                  {pct(relVsBench)}
                </b>
              </span>
            </div>
            <EquityChart equity={equityCurve} benchmark={benchmarkCurve} />
          </div>

          <div className="panel" style={{ marginTop: 10 }}>
            <h3>下单 · {selected}</h3>
            <div className="actions">
              <button className="buy" onClick={() => order('buy', 0.25)} disabled={engine.isOver} {...buy25Tip}>
                做多 25%
              </button>
              <button className="buy" onClick={() => order('buy', 1.0)} disabled={engine.isOver} {...buy100Tip}>
                做多 100%
              </button>
              <button className="sell" onClick={() => order('sell', 0.25)} disabled={engine.isOver} {...sell25Tip}>
                做空 25%
              </button>
              <button className="sell" onClick={() => order('sell', 1.0)} disabled={engine.isOver} {...sell100Tip}>
                做空 100%
              </button>
              <button onClick={flatten} disabled={engine.isOver} {...flattenTip}>
                清仓全部
              </button>
            </div>
            <div className="dim" style={{ marginTop: 7, fontSize: 11 }}>
              <Tip text={GLOSSARY.pendingOrders.detail}>
                挂单 {engine.state.pendingOrders.length} 笔 ⓘ
              </Tip>{' '}
              · 以次日开盘价成交，含滑点。订单提交后不可撤销。
            </div>
          </div>
        </div>

        {/* ---------------- 中：新闻 ---------------- */}
        <div className="col">
          {s.bankrupt && (
            <div className="banner danger">
              <b>你爆仓了。</b> 游戏结束。这一局你亏掉了全部本金——这不是因为你看错了方向，
              而是因为在正确的方向上，你没能活到明天。
            </div>
          )}
          {s.marginCall && !s.bankrupt && (
            <div className="banner warn">
              <b>⚠ 收到追加保证金通知。</b> 你的权益已低于维持保证金要求。请立即补充资金或减仓，
              否则将被强制平仓（强平价格带 2 倍惩罚性滑点）。
            </div>
          )}
          {engine.isOver && !s.bankrupt && (
            <div className="banner info">
              <b>2009 年结束了。</b> 你活了下来。
            </div>
          )}

          {hints.map((h, i) => (
            <div key={i} className={`hint ${h.level}`}>
              {h.text}
            </div>
          ))}

          {skipNote && !engine.isOver && <div className="hint info">{skipNote}</div>}
          {rejectNote && (
            <div className="hint warn">订单未成交 —— {rejectNote}</div>
          )}

          <div className="panel">
            <h3>新闻流</h3>
            {news.length === 0 && <div className="dim">尚未有消息。推进时间看看。</div>}
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

        {/* ---------------- 右：账户 ---------------- */}
        <div className="col">
          <div className="panel">
            <h3>持仓</h3>
            {s.positions.length === 0 ? (
              <div className="dim">空仓</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>标的</th>
                    <th>数量</th>
                    <th>成本</th>
                    <th>现价</th>
                    <th>盈亏</th>
                  </tr>
                </thead>
                <tbody>
                  {s.positions.map((p) => (
                    <tr key={p.id} className="clickable" onClick={() => setSelected(p.id)}>
                      <td>{p.id}</td>
                      <td className={p.qty >= 0 ? 'pos' : 'neg'}>{p.qty}</td>
                      <td>{p.avgPrice.toFixed(2)}</td>
                      <td>{p.price.toFixed(2)}</td>
                      <td className={p.pnl >= 0 ? 'pos' : 'neg'}>
                        {p.pnl.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <h3>市场</h3>
            {!showMacro && (
              <div className="locked-note">
                <b>D0 不显示宏观指标——这是刻意的。</b>
                {'\n\n'}
                你只有 K 线、成交量和新闻标题。
                {'\n\n'}
                你以为你缺的是数据，但 2008 年的专业机构拿着这些数据，也一样没跑掉。
                低难度的课题不是「看到更多」，而是**从新闻里读出方向**。
                {'\n\n'}
                想要指标？下一局选 D1 或更高。
              </div>
            )}
            {showMacro && (
              <>
                <div className="bar-row">
                  <span className="k">
                    <Tip text={`${GLOSSARY.systemicStress.plain}\n\n${GLOSSARY.systemicStress.detail}`}>
                      系统性压力 ⓘ
                    </Tip>
                  </span>
                  <span className={m.systemicStress > 0.5 ? 'neg' : m.systemicStress > 0.3 ? 'warn' : ''}>
                    {pct(m.systemicStress)}
                  </span>
                </div>
                <div className="bar-row">
                  <span className="k">
                    <Tip text={`${GLOSSARY.creditSpread.plain}\n\n${GLOSSARY.creditSpread.detail}`}>
                      信用利差 ⓘ
                    </Tip>
                  </span>
                  <span className={m.creditSpread > 800 ? 'neg' : m.creditSpread > 450 ? 'warn' : ''}>
                    {m.creditSpread.toFixed(0)} bp
                  </span>
                </div>
                <div className="bar-row">
                  <span className="k">
                    <Tip text={`${GLOSSARY.tedSpread.plain}\n\n${GLOSSARY.tedSpread.detail}`}>
                      TED 利差 ⓘ
                    </Tip>
                  </span>
                  <span className={m.tedSpread > 2 ? 'neg' : m.tedSpread > 1 ? 'warn' : ''}>
                    {m.tedSpread.toFixed(2)}%
                  </span>
                </div>
                <div className="bar-row">
                  <span className="k">
                    <Tip text={`${GLOSSARY.liquidity.plain}\n\n${GLOSSARY.liquidity.detail}`}>
                      市场流动性 ⓘ
                    </Tip>
                  </span>
                  <span className={m.liquidity < 0.3 ? 'neg' : m.liquidity < 0.6 ? 'warn' : ''}>
                    {pct(m.liquidity)}
                  </span>
                </div>
              </>
            )}
            {showMacro && showFunding && (
              <>
                <div className="bar-row">
                  <span className="k">
                    <Tip text={`${GLOSSARY.repoHaircut.plain}\n\n${GLOSSARY.repoHaircut.detail}`}>
                      回购折扣率 ⓘ
                    </Tip>
                  </span>
                  <span className={m.repoHaircut > 0.3 ? 'neg' : m.repoHaircut > 0.15 ? 'warn' : ''}>
                    {pct(m.repoHaircut)}
                  </span>
                </div>
                <div className="bar-row">
                  <span className="k">
                    <Tip text={`${GLOSSARY.repoCapacity.plain}\n\n${GLOSSARY.repoCapacity.detail}`}>
                      融资容量 ⓘ
                    </Tip>
                  </span>
                  <span>{money(engine.state.player.repoCapacity)}</span>
                </div>
                <div className="bar-row">
                  <span className="k">
                    <Tip text={`${GLOSSARY.rolloverRate.plain}\n\n${GLOSSARY.rolloverRate.detail}`}>
                      预计展期率 ⓘ
                    </Tip>
                  </span>
                  <span className={engine.state.player.repoRolloverRate < 0.6 ? 'neg' : ''}>
                    {pct(engine.state.player.repoRolloverRate)}
                  </span>
                </div>
              </>
            )}
          </div>

          <div className="panel">
            <h3>
              <Tip text={`${GLOSSARY.srs.plain}\n\n${GLOSSARY.srs.detail}`}>你的系统性足迹 ⓘ</Tip>
            </h3>
            {!showRegulator ? (
              <div className="locked-note">
                监管机制要到 D2 才会激活。
                {'\n\n'}
                原因很简单：小资金玩家的仓位小到不会影响市场，
                SRS 永远接近 0，监管根本不会注意到你。
                {'\n\n'}
                **你想被监管盯上，先得大到「不能不管」。**
              </div>
            ) : (
              <>
                <div className="bar-row">
                  <span className="k">
                    <Tip
                      text={`${GLOSSARY.shortConcentration.plain}\n\n${GLOSSARY.shortConcentration.detail}`}
                    >
                      空头集中度 ⓘ
                    </Tip>
                  </span>
                  <span className={engine.state.regulator.shortConcentration > 0.04 ? 'warn' : ''}>
                    {pct(engine.state.regulator.shortConcentration)}（5% 触发披露）
                  </span>
                </div>
                <div className="bar-row">
                  <span className="k">
                    <Tip text={GLOSSARY.srs.detail}>SRS ⓘ</Tip>
                  </span>
                  <span className={engine.state.regulator.srs > 0.5 ? 'neg' : engine.state.regulator.srs > 0.2 ? 'warn' : ''}>
                    {engine.state.regulator.srs.toFixed(3)}
                  </span>
                </div>
                <div className="bar-row">
                  <span className="k">
                    <Tip text={`${GLOSSARY.regulatorLevel.plain}\n\n${GLOSSARY.regulatorLevel.detail}`}>
                      监管关注度 ⓘ
                    </Tip>
                  </span>
                  <span className={s.regulatorLevel >= 2 ? 'warn' : 'dim'}>
                    L{s.regulatorLevel} {LEVEL_LABEL[s.regulatorLevel]}
                  </span>
                </div>
                {engine.state.regulator.rules.length > 0 && (
                  <div className="dim" style={{ marginTop: 6, fontSize: 11 }}>
                    生效规则：
                    {engine.state.regulator.rules
                      .map((r) => `${r.kind}(${r.scope.join('/')} 至 ${r.effectiveTo})`)
                      .join('、')}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="panel">
            <h3>
              <Tip
                text={
                  '机构脆弱度\n\n' +
                  '由杠杆、回购融资依赖度、资产受损程度、市场信心、对手方敞口和资本缓冲合成。\n\n' +
                  '**先倒下的，是脆弱度最高的那一个——而不是随机被选中的。**\n\n' +
                  '这也是本作的核心设计：随机性作用于「谁先撑不住」，而不是「凭空指定谁先死」。' +
                  '所以你可以通过观察哪些机构在恶化来预判，只是预判不会 100% 准确。'
                }
              >
                机构状态 ⓘ
              </Tip>
            </h3>
            <table>
              <tbody>
                {engine
                  .institutionList()
                  .slice(0, 12)
                  .map((inst) => {
                    const st = engine.institutionState(inst.id);
                    return (
                      <tr key={inst.id}>
                        <td>{inst.name}</td>
                        <td className={st && !st.alive ? 'neg' : 'dim'}>
                          {st?.alive ? (st.fragility).toFixed(2) : '已倒下'}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            <div className="dim" style={{ marginTop: 6, fontSize: 10 }}>
              数字为脆弱度。先倒下的，是脆弱度最高的那一个——而不是随机被选中的。
            </div>
          </div>

          {lateEvents.length > 0 && (
            <div className="panel">
              <h3>已触发事件（最近）</h3>
              <div className="dim" style={{ fontSize: 11, lineHeight: 1.6 }}>
                共 {engine.state.firedEvents.length} / {dataset.events.length} 张
                <br />
                {lateEvents.join(' · ')}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="disclaimer">
        历史模拟，非投资建议，不构成对任何机构或个人的评价。事件冲击数值为设计校准值，
        用于产生正确的相对强度，不是精确回测输出。种子 {engine.config.seed} · 难度 D
        {engine.config.difficulty} · 时间线 {TIMELINE_LABEL[engine.config.timeline].split('（')[0]} ·
        铁人模式 {engine.config.ironman ? '开' : '关'}
      </div>
    </div>
  );
}
