/**
 * 你能不能逃过信贷危机 —— P0 原型界面。
 *
 * 目标只有一个：验证「看新闻 → 做多/做空/清仓 → 承担后果」这个循环是否有张力。
 * 所以这里刻意只有三个操作按钮。
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  GameEngine,
  INSTRUMENTS,
  LEVEL_LABEL,
  type Difficulty,
  type Identity,
} from '@cyscc/core';
import { dataset } from './dataset.ts';
import { KLineChart } from './KLineChart.tsx';

const TRADABLE = INSTRUMENTS.filter((i) => i.sector !== 'index');
const TABS = ['SPX', ...TRADABLE.map((i) => i.id)];

const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  0: 'D0 看懂危机（K线 + 成交量 + 新闻标题）',
  1: 'D1 基本面（+ 利率 / TED / VIX / 信用利差）',
  2: 'D2 专业层（+ 保证金 / 融资 / 回购折扣率）',
  3: 'D3 太大而不能动（+ 监管约束与冲击成本）',
};

const IDENTITY_LABEL: Record<Identity, string> = {
  retail: '散户（$10 万）',
  hedge_fund: '对冲基金（$1000 万）',
  bank: '投行自营（$10 亿）',
  insurer: '保险 / 再保险（$100 亿）',
};

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function App() {
  const [started, setStarted] = useState(false);
  const [seed, setSeed] = useState(42);
  const [difficulty, setDifficulty] = useState<Difficulty>(1);
  const [identity, setIdentity] = useState<Identity>('retail');
  const [, forceRender] = useState(0);
  const [selected, setSelected] = useState('LEH');

  const engineRef = useRef<GameEngine | null>(null);
  const tickRef = useRef(0);

  const createEngine = useCallback(
    (opts: { seed: number; difficulty: Difficulty; identity: Identity }) => {
      engineRef.current = new GameEngine(dataset, {
        config: {
          seed: opts.seed,
          difficulty: opts.difficulty,
          identity: opts.identity,
          timeline: 'jittered',
        },
      });
      tickRef.current = 0;
      setSelected('LEH');
      forceRender((n) => n + 1);
    },
    [],
  );

  const engine = engineRef.current;

  const proceed = useCallback(
    (steps: number, stopOnEvent: boolean) => {
      const e = engineRef.current;
      if (!e) return;
      for (let i = 0; i < steps; i++) {
        if (e.isOver) break;
        const res = e.advance();
        tickRef.current++;
        if (stopOnEvent && res.firedEventIds.length > 0) break;
      }
      forceRender((n) => n + 1);
    },
    [],
  );

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
      e.submitByNotional(selected, side === 'buy' ? notional : -notional);
      forceRender((n) => n + 1);
    },
    [selected],
  );

  const flatten = useCallback(() => {
    const e = engineRef.current;
    if (!e) return;
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

  // ------------------------------------------------------------ 开始界面

  if (!started) {
    return (
      <div className="setup">
        <h1>你能不能逃过信贷危机</h1>
        <p>
          2007 年 1 月，你手握一笔资金。市场会崩，但你不知道哪天崩。
          <br />
          你只能看到今天及以前的信息——明天是未知的。
        </p>
        <div style={{ marginTop: 26 }}>
          <label>
            <span>随机种子（同一个种子 = 同一场危机）</span>
            <input
              type="number"
              value={seed}
              onChange={(e) => setSeed(Number(e.target.value) || 0)}
              style={{ width: 140 }}
            />
          </label>
          <label>
            <span>难度</span>
            <select value={difficulty} onChange={(e) => setDifficulty(Number(e.target.value) as Difficulty)}>
              {([0, 1, 2, 3] as Difficulty[]).map((d) => (
                <option key={d} value={d}>
                  {DIFFICULTY_LABEL[d]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>身份</span>
            <select value={identity} onChange={(e) => setIdentity(e.target.value as Identity)}>
              {(Object.keys(IDENTITY_LABEL) as Identity[]).map((k) => (
                <option key={k} value={k}>
                  {IDENTITY_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary"
            onClick={() => {
              createEngine({ seed, difficulty, identity });
              setStarted(true);
            }}
          >
            开始
          </button>
        </div>
        <p style={{ marginTop: 26, fontSize: 11 }}>
          已载入 {dataset.events.length} 张事件卡 · {dataset.institutions.institutions.length} 家机构 ·{' '}
          {dataset.rumors.templates.length} 类传闻
        </p>
      </div>
    );
  }

  if (!engine) return null;

  const s = engine.summary();
  const m = s.macro;
  const ret = s.equity / engine.config.initialCapital - 1;
  const news = [...engine.state.news].reverse().slice(0, 40);
  const lateEvents = engine.state.firedEvents.slice(-3);

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
          <span className="k">最大回撤</span>
          <span className="v warn">{pct(s.maxDrawdown)}</span>
        </div>
        <div className="stat">
          <span className="k">标普 / VIX</span>
          <span className="v">
            {m.spx.toFixed(0)} / {m.vix.toFixed(1)}
          </span>
        </div>
        <span className="spacer" />
        <button onClick={() => advanceDays(1)} disabled={engine.isOver}>
          推进 1 天
        </button>
        <button onClick={() => proceed(1, true)} disabled={engine.isOver}>
          快进到事件
        </button>
        <button onClick={() => proceed(21, false)} disabled={engine.isOver}>
          快进 1 个月
        </button>
        <button
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
          </div>
          <KLineChart bars={bars} instrumentId={selected} />

          <div className="panel" style={{ marginTop: 10 }}>
            <h3>下单 · {selected}</h3>
            <div className="actions">
              <button className="buy" onClick={() => order('buy', 0.25)} disabled={engine.isOver}>
                做多 25%
              </button>
              <button className="buy" onClick={() => order('buy', 1.0)} disabled={engine.isOver}>
                做多 100%
              </button>
              <button className="sell" onClick={() => order('sell', 0.25)} disabled={engine.isOver}>
                做空 25%
              </button>
              <button className="sell" onClick={() => order('sell', 1.0)} disabled={engine.isOver}>
                做空 100%
              </button>
              <button onClick={flatten} disabled={engine.isOver}>
                清仓全部
              </button>
            </div>
            <div className="dim" style={{ marginTop: 7, fontSize: 11 }}>
              挂单 {engine.state.pendingOrders.length} 笔 · 以次日开盘价成交，含滑点。
              订单提交后不可撤销。
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
            <div className="bar-row">
              <span className="k">系统性压力</span>
              <span>{pct(m.systemicStress)}</span>
            </div>
            <div className="bar-row">
              <span className="k">信用利差</span>
              <span>{m.creditSpread.toFixed(0)} bp</span>
            </div>
            <div className="bar-row">
              <span className="k">TED 利差</span>
              <span>{m.tedSpread.toFixed(2)}%</span>
            </div>
            <div className="bar-row">
              <span className="k">市场流动性</span>
              <span className={m.liquidity < 0.3 ? 'neg' : ''}>{pct(m.liquidity)}</span>
            </div>
            {(engine.config.difficulty >= 2 || engine.config.identity !== 'retail') && (
              <>
                <div className="bar-row">
                  <span className="k">回购折扣率</span>
                  <span className={m.repoHaircut > 0.3 ? 'neg' : ''}>{pct(m.repoHaircut)}</span>
                </div>
                <div className="bar-row">
                  <span className="k">融资容量</span>
                  <span>{money(engine.state.player.repoCapacity)}</span>
                </div>
                <div className="bar-row">
                  <span className="k">预计展期率</span>
                  <span>{pct(engine.state.player.repoRolloverRate)}</span>
                </div>
              </>
            )}
          </div>

          <div className="panel">
            <h3>你的系统性足迹</h3>
            <div className="bar-row">
              <span className="k">空头集中度</span>
              <span className={engine.state.regulator.shortConcentration > 0.04 ? 'warn' : ''}>
                {pct(engine.state.regulator.shortConcentration)}（5% 触发披露）
              </span>
            </div>
            <div className="bar-row">
              <span className="k">SRS</span>
              <span>{engine.state.regulator.srs.toFixed(3)}</span>
            </div>
            <div className="bar-row">
              <span className="k">监管关注度</span>
              <span className={s.regulatorLevel >= 2 ? 'warn' : 'dim'}>
                L{s.regulatorLevel} {LEVEL_LABEL[s.regulatorLevel]}
              </span>
            </div>
            {engine.state.regulator.rules.length > 0 && (
              <div className="dim" style={{ marginTop: 6, fontSize: 11 }}>
                生效规则：
                {engine.state.regulator.rules.map((r) => `${r.kind}(${r.scope.join('/')} 至 ${r.effectiveTo})`).join('、')}
              </div>
            )}
          </div>

          <div className="panel">
            <h3>机构状态</h3>
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
        {engine.config.difficulty} · 铁人模式 {engine.config.ironman ? '开' : '关'}
      </div>
    </div>
  );
}
