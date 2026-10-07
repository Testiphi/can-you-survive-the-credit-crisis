/** D0: trades advance one day; waiting advances at most five trading days with risk stops. */

import { useCallback, useMemo, useReducer, useRef, useState } from 'react';

import type { Fill, GameEngine } from '@cyscc/core';
import { BEGINNER_RULES, beginnerPeriod, reviewRun, fundAvailableCash, BANK_RULES, loanLiabilities, collateralState, refinanceQuote, nextTradingDay, INSURANCE_RULES, reinsurancePrice } from '@cyscc/core';

import { SimpleChart } from './SimpleChart.tsx';
import { Tip, useTip } from './Tip.tsx';
import { buildHints, FILL_REASON } from './glossary.ts';
import { nextFundingDecision } from '@cyscc/core';
import { previewBeginnerTrade } from '@cyscc/core';
import { OrderPreview } from './OrderPreview.tsx';

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
  buy: '买入方向\n\n按选定比例的现金提交订单；实际成交会预留手续费，并受持仓额度限制。\n\n已有空头时先回补，超出回补数量才建立多头；已有多头时增加持仓。请先查看预览中的方向与数量。',
  short:
    '卖出方向\n\n已有多头时先减仓，卖出数量超过多头持仓后才建立空头。已有空头时继续增加空头。\n\n' +
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
  const fund = engine.state.fund;
  const bank = engine.state.bank;
  const insurer = engine.state.insurer;
  const collateral = bank ? collateralState(engine.state.player, engine.state.prices, engine.state.macro.systemicStress) : undefined;
  const obligationsFailed = !!(fund?.defaulted || bank?.defaulted || insurer?.defaulted);
  const distributed = engine.state.player.distributedCapital ?? 0;
  const roleName = insurer ? '保险公司（教学版）' : bank ? '银行资金经理（教学版）' : fund ? '基金经理（教学版）' : '散户';
  const review = reviewRun(engine.config, s.equity, s.maxDrawdown, s.bankrupt, engine.turnReports, fund ?? bank ?? insurer);
  const lastReport = engine.turnReports.at(-1);
  const nextDecision = nextFundingDecision(engine.state);
  const buyPreview = previewBeginnerTrade(engine.state, selected, 'buy', fraction);
  const sellPreview = previewBeginnerTrade(engine.state, selected, 'sell', fraction);
  const inst = D0_INSTRUMENTS.find((i) => i.id === selected) ?? D0_INSTRUMENTS[0];
  const bars = useMemo(
    () => engine.visibleBars(selected),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, selected, engine.state.turnIndex],
  );

  const ret = (s.equity + distributed) / engine.config.initialCapital - 1;

  /** 交易只推进一天；观望有明确上限和风险暂停。 */
  const advanceSession = useCallback(
    (log: Fill[], days: number) => {
      const e = engineRef.current;
      let advanced = 0;
      const startingEquity = e.state.player.equity + (e.state.player.distributedCapital ?? 0);
      let reason = '已到达本次推进上限';
      for (let i = 0; i < days; i++) {
        if (e.isOver) break;
        const res = e.advance();
        advanced++;
        if (res.fills.length > 0) log.push(...res.fills);
        const fundNotice = res.news.some(n => n.id.startsWith('fund-') || n.id.startsWith('bank-') || n.id.startsWith('insurance-'));
        if (e.isOver || fundNotice || res.marginCall || res.fills.length > 0 || res.firedEventIds.length > 0 || res.equity + (e.state.player.distributedCapital ?? 0) <= startingEquity * 0.97) {
          reason = e.isOver ? '本局结束' : fundNotice ? '请查看资金到期与偿付安排' : res.marginCall ? '需要处理账户风险' : res.fills.length > 0 ? '请查看成交结果' : res.firedEventIds.length > 0 ? '出现新事件' : '期间净值下跌达到 3%';
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

      if (kind === 'buy' || kind === 'short') {
        const preview = previewBeginnerTrade(e.state, selected, kind === 'buy' ? 'buy' : 'sell', fraction);
        if (!preview.order) { setStepNote(preview.note ?? '无法提交订单'); return; }
        e.submitOrder(preview.order);
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
          <span className="k">{roleName} · 账户净资产</span>
          <span className="v">{money(s.equity)}</span>
          <span className={`d ${ret >= 0 ? 'pos' : 'neg'}`}>
            {ret >= 0 ? '+' : ''}
            {pct(ret)}{fund ? '（已加回兑付）' : ''}
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
        <p>目标：结束时保留至少 {money(engine.config.initialCapital * chapter.capitalFloor)} {fund ? '净资产与累计兑付之和，并完成全部到期兑付' : bank ? '净资产，并按期清偿全部借款' : insurer ? '净资产，并按期支付全部赔款' : '净资产'}。
        风控挑战：最大回撤不超过 {pct(chapter.drawdownLimit)}，且不触发自动回补。保留现金同样可以完成目标。</p>
      </div>}
      {nextDecision && <div className={`banner ${!nextDecision.optional && (nextDecision.shortfall ?? 0) > 0 ? 'danger' : 'info'}`}>
        <b>最近期限：{nextDecision.date} · 剩余 {nextDecision.days} 个交易日</b>
        <div>{nextDecision.labels.join('；')}</div>
        <div>{nextDecision.amount === undefined ? '金额尚未确认，请按赔付范围预留资金。' : `当前估计需自有现金 ${money(nextDecision.amount)}，可用 ${money(nextDecision.availableCash)}，${nextDecision.optional ? '如购买还需准备' : '缺口'} ${money(nextDecision.shortfall ?? 0)}。`}</div>
        <div>按当前合同与仓位估计，实际金额以结算为准。下单在下一交易日开盘执行，请在期限前安排操作。</div>
      </div>}
      {bank && <div className={`banner ${bank.defaulted ? 'danger' : 'info'}`}>
        <b>银行资产负债表与到期借款</b>
        <p>开局自有资本 {money(engine.config.initialCapital)}，借入等额资金，继承约 1.5 倍资本的证券组合，其余为现金。
        当前负债合计 {money(loanLiabilities(engine.state.player))}，可偿债现金 {money(fundAvailableCash(engine.state.player, engine.state.prices))}。</p>
        {(engine.state.player.loans ?? []).map(loan => <div key={loan.id}>
          {loan.id.replace('loan-', '借款 ')} · {loan.dueDate} 收盘到期 · 本金 {money(loan.principal)} · 已计提利息 {exactMoney(loan.accruedInterest)} · {loan.status === 'repaid' ? '已偿还' : loan.status === 'defaulted' ? '违约' : '未到期'} · 年化 {pct(loan.annualRate)}{loan.refinancing ? ` · 已办理${loan.refinancing === 'secured' ? '抵押' : '无抵押'}展期` : ''}
          {loan.status === 'active' && !loan.refinancing && <details>
            <summary>查看这笔借款的展期方案</summary>
            {(['secured', 'term'] as const).map(plan => {
              const quote = refinanceQuote(engine.state.player, engine.state.prices, engine.state.macro.systemicStress, nextTradingDay(engine.state.date), engine.config.endDate, loan, plan);
              return <div key={plan} style={{ margin: '10px 0' }}>
                <b>{plan === 'secured' ? '抵押展期（10 个交易日）' : '无抵押展期（20 个交易日）'}</b>
                <div>预计新到期日 {quote.dueDate} · 年化 {pct(quote.annualRate)} · 手续费 {money(quote.fee)}</div>
                <div>预计需要现金 {money(quote.cashRequired)}（包括利息、手续费、补还本金 {money(quote.principalRepaid)}）</div>
                {plan === 'secured' && <div>当前抵押折扣 {pct(quote.haircut)}；以后资产下跌或折扣提高，可能要求补还本金。</div>}
                {quote.reason && <div>{quote.reason}</div>}
                <button disabled={engine.isOver || !!quote.reason} onClick={() => { engine.requestBankRefinance({ loanId: loan.id, plan }); advanceSession([], 1); }}>
                  {plan === 'secured' ? '申请抵押展期' : '申请无抵押展期'}
                </button>
              </div>;
            })}
            <p>以上为当前行情下的估计，不含下一日新增利息；点击后推进一天，按次日收盘行情重新审核。被拒绝时原合同继续有效。</p>
          </details>}
        </div>)}
        {collateral && collateral.used > 0 && <p>
          共享抵押池：折扣 {pct(collateral.haircut)} · 认可额度 {money(collateral.capacity)} · 已占用本金 {money(collateral.used)} · 缺口 {money(collateral.shortfall)}。
          {bank.collateralCallDue ? `处理期限：${bank.collateralCallDue} 收盘。` : '出现缺口时先用可用现金补还；不足时给一交易日处理。'}
        </p>}
        <p>初始借款按未还本金年化 {pct(BANK_RULES.annualRate)}、每交易日 1/252 计息。到期前五个交易日起可申请展期，每笔仅一次，新期限不会超过本局结束日。到期按本息足额偿还，不自动展期。卖空担保资金不可还债；现金不足即结束本局。</p>
        <button disabled={engine.isOver || !(engine.state.player.loans ?? []).some(l => l.status === 'active')} onClick={() => {
          engine.requestBankRepayment(); advanceSession([], 1);
        }}>提前偿债（用可用现金，推进一天）</button>
        <p>指令在下一交易日收盘执行，先支付应计利息，再按到期顺序还本金，允许部分提前偿还。还本同时减少现金和负债，不计作亏损。</p>
      </div>}
      {insurer && <div className={`banner ${insurer.defaulted ? 'danger' : 'info'}`}>
        <b>赔付安排与再保险</b>
        <p>每笔赔款按确认日系统压力计算，为初始资本的 3%—20%，确认后下一交易日支付。
        当前压力 {pct(engine.state.macro.systemicStress)}；可支付现金 {money(fundAvailableCash(engine.state.player, engine.state.prices))}。</p>
        {insurer.claims.map(c => <div key={c.assessmentDate}>
          {c.assessmentDate} 确认 → {c.dueDate} 支付 · {c.status === 'scheduled' ? '金额待确认' : `应付 ${money(c.grossAmount ?? 0)}，再保险回款 ${money(c.recovery ?? 0)}`} · {c.status === 'paid' ? '已支付' : c.status === 'missed' ? '未支付' : '待处理'}
        </div>)}
        <p>现有保单在最后赔付日前每日收入初始资本的 {(INSURANCE_RULES.dailyPremium * 100).toFixed(2)}%；赔案确认当日计入损失，支付时不重复扣减净资产。
        再保险在赔付日到账，本教学版不模拟再保险方违约。</p>
        {insurer.coverage ? <p>再保险已生效：一次性保费 {money(insurer.coverage.premium)}。
          每笔先自留初始资本的 5%，超出部分由再保险承担 50%。</p> : <>
          <p>可选再保险：当前估计保费 {money(reinsurancePrice(engine.config.initialCapital, engine.state.macro.systemicStress))}，一次性支付；每笔赔款超过初始资本 5% 的部分，赔付 50%。必须在 {insurer.purchaseDeadline} 收盘前成交。</p>
          <button disabled={engine.isOver || nextTradingDay(engine.state.date) > insurer.purchaseDeadline} onClick={() => { engine.requestReinsurance(); advanceSession([], 1); }}>购买再保险（推进一天）</button>
          <p>次日按当时压力重算报价并检查现金；购买后不退费。也可以保留现金，自行承担赔款。</p>
        </>}
      </div>}
      {fund && <div className={`banner ${fund.defaulted ? 'danger' : 'info'}`}>
        <b>投资者赎回安排</b> · 当前可兑付现金 {money(fundAvailableCash(engine.state.player, engine.state.prices))}
        <p>每笔在标注日期收盘结算。请提前保留现金或提交减仓；卖空所得与等额担保资金不能用于兑付。未能按期支付即结束本局，即使账面净资产仍为正。</p>
        {fund.payments.map(p => <div key={p.date}>{p.date} · {money(p.amount)} · {p.status === 'paid' ? '已兑付' : p.status === 'missed' ? '未兑付' : '待兑付'}</div>)}
        <p>累计已返还 {money(distributed)}。收益和回撤使用“剩余净资产＋已返还资本”计算；账户资金可用量仍按实际余额判断。</p>
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

          {engine.isOver && !s.bankrupt && !obligationsFailed && (
            <div className="banner info">本局已到达 {engine.config.endDate}。查看右侧复盘了解资金变化。</div>
          )}
          {bank?.defaulted && <div className="banner danger">未能按时履行融资义务，本局结束。未偿本金和利息仍计入负债。</div>}
          {insurer?.defaulted && <div className="banner danger">赔款未能按期支付，本局结束。未付赔款继续计入负债。</div>}
          {fund?.defaulted && <div className="banner danger">未能按时兑付投资者赎回，本局结束。未支付金额没有从账户扣除。</div>}
          {s.bankrupt && (
            <div className="banner danger">
              <b>你的钱亏光了，这一局结束。</b> 让你出局的往往不是判断错了方向，
              而是**在正确的方向上没能活到明天**。
            </div>
          )}

          {stepNote && <div className="banner info" role="status">{stepNote}</div>}
          <label className="b-actions-note">
            本次交易比例（买入方向按现金，卖出方向按净资产）：
            <select value={fraction} disabled={engine.isOver} onChange={e => setFraction(Number(e.target.value))}>
              <option value={0.25}>25%</option><option value={0.5}>50%</option><option value={1}>100%</option>
            </select>
          </label>
          {!engine.isOver && <OrderPreview buy={buyPreview} sell={sellPreview} />}
          <div className="b-actions">
            <button className="big buy" onClick={() => act('buy')} disabled={engine.isOver || !buyPreview.order} {...buyTip}>
              {buyPreview.label}
            </button>
            <button className="big sell" onClick={() => act('short')} disabled={engine.isOver || !sellPreview.order} {...shortTip}>
              {sellPreview.label}
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
            买卖与平仓推进 1 个交易日；观望最多推进 5 日，遇到事件或风险提前暂停。新增仓位须满足持仓总额不超过账户权益的 {bank ? 2 : 1} 倍，且现金不能透支。
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
            {lastReport.capitalOutflow !== undefined && <div className="line">投资者赎回（资本返还）：−{exactMoney(lastReport.capitalOutflow)}</div>}
            {lastReport.loanInterest !== undefined && <>
              <div className="line">展期手续费：−{exactMoney(lastReport.financingFees ?? 0)}</div>
              <div className="line">当日借款利息成本：−{exactMoney(lastReport.loanInterest)}</div>
              <div className="line">偿债现金流：本金 {exactMoney(lastReport.principalRepaid ?? 0)}，已计提利息 {exactMoney(lastReport.interestPaid ?? 0)}（不重复扣减净资产）</div>
            </>}
            {lastReport.premiumIncome !== undefined && <>
              <div className="line">保费收入：+{exactMoney(lastReport.premiumIncome)}</div>
              <div className="line">新确认净赔款损失：−{exactMoney(lastReport.claimExpense ?? 0)}</div>
              <div className="line">购买再保险：−{exactMoney(lastReport.reinsurancePremium ?? 0)}</div>
              <div className="line">赔付现金流：支付 {exactMoney(lastReport.claimsPaid ?? 0)}，再保险到账 {exactMoney(lastReport.recoveriesReceived ?? 0)}（不重复记损益）</div>
            </>}
            <div className="line">期末净资产：{exactMoney(lastReport.equityAfter)}</div>
          </div>}
          {engine.isOver && <div className="b-panel">
            <h3>本局复盘</h3>
            <p>{s.bankrupt ? '账户已破产。' : insurer?.defaulted ? '赔款未能按期支付。' : bank?.defaulted ? '融资义务未能按期履行。' : fund?.defaulted ? '投资者赎回未能按期兑付。' : '已完成本局。'} 净收益 {signed(s.equity + distributed - engine.config.initialCapital)}，最大回撤 {pct(s.maxDrawdown)}。</p>
            {chapter && <p>本金目标：{review.capitalPreserved && review.survived ? '完成' : '未完成'}；
              回撤挑战：{review.drawdownControlled ? '完成' : '未完成'}；
              避免自动回补：{review.noForcedClose ? '完成' : '未完成'}。</p>}
            <p>累计手续费 {money(review.commissions)}，做空持有费 {money(review.borrowFees)}{bank ? `，借款利息 ${money(review.loanInterest)}，展期手续费 ${money(review.financingFees)}` : ''}，自动回补 {review.riskCloses} 次。</p>
            {insurer && <p>累计保费收入 {money(review.premiumIncome)}，已确认净赔款损失 {money(review.claimExpense)}，再保险保费 {money(review.reinsurancePremium)}。</p>}
            {review.worstDay && review.worstDay.equityAfter + (review.worstDay.capitalOutflow ?? 0) < review.worstDay.equityBefore && <p>
              最大单日净损失发生在 {review.worstDay.date}：{money(review.worstDay.equityBefore - review.worstDay.equityAfter - (review.worstDay.capitalOutflow ?? 0))}。
              当日持仓与交易价差 {signed(review.worstDay.marketPnl)}，费用合计 {money(review.worstDay.commission + review.worstDay.borrowFees + (review.worstDay.loanInterest ?? 0) + (review.worstDay.financingFees ?? 0))}。
              {insurer && <>当日保费收入 {money(review.worstDay.premiumIncome ?? 0)}，确认净赔款损失 {money(review.worstDay.claimExpense ?? 0)}，再保险保费 {money(review.worstDay.reinsurancePremium ?? 0)}。</>}
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
              D0 {roleName}规则：不启用 NPC、传闻、回购融资和监管处罚。
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
              {insurer && <>
                <div className="line"><span>未付赔款负债</span><b>{money(engine.state.player.claimsPayable ?? 0)}</b></div>
                <div className="line"><span>应收再保险回款</span><b>{money(engine.state.player.reinsuranceReceivable ?? 0)}</b></div>
              </>}
              {bank && <div className="line"><span>借款本金与应计利息</span><b>{money(loanLiabilities(engine.state.player))}</b></div>}
              <div className="line total">
                <span>净资产</span>
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
