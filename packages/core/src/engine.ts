/**
 * GameEngine —— 引擎的唯一对外门面。
 *
 * 单回合时序严格遵循 docs/02 §4：
 *   事件注入 → NPC 决策 → 市场出价 → 成交（t+1 开盘价） → 盯市 → 保证金 → 监管
 *
 * 铁律：玩家在 t 日看到的只有 ≤ t 日的信息，成交发生在 t+1。
 */

import { BEGINNER_RULES, limitBeginnerFill, settleBeginnerRisk } from './beginner.ts';
import { fingerprint, SAVE_VERSION, validateSave, type GameSave } from './save.ts';
import { createFund, settleFund } from './fund.ts';
import { BANK_RULES, initializeBank, settleBank } from './bank.ts';
import { createInsurer, settleInsurance } from './insurance.ts';
import { demoEvents } from './demo.ts';
import { applyMarketRevision, isEstimatedMarketBar } from './market-revision.ts';
import type {
  Account,
  Bar,
  EventCard,
  Fill,
  GameConfig,
  GameState,
  ImpactVector,
  Institution,
  InstitutionState,
  InstitutionsFile,
  MacroState,
  MarketData,
  MarketPatch,
  NewsItem,
  Order,
  PlayerAction,
  ScoreSnapshot,
  TurnResult,
  TurnReport,
  RefinanceRequest,
} from './types.ts';
import { DEFAULT_CONFIG, IDENTITY_PROFILE } from './types.ts';
import { Rng, createStreams, type Streams } from './rng.ts';
import { nextTradingDay, prevTradingDay, tradingDaysBetween, addDays } from './time.ts';
import { DIFFICULTY_PROFILE, buildMacroSeries, haircutFromStress, systemicStress } from './economy.ts';
import { INSTRUMENTS, INSTRUMENT_BY_ID, resolveImpact } from './instruments.ts';
import {
  applyFragilityDelta,
  computeFragility,
  initInstitutionStates,
  markFailed,
  updateConfidence,
} from './institutions.ts';
import { ScenarioEngine, JITTER_BY_TIMELINE, type FireDecision } from './scenario.ts';
import { COMMISSION_RATE, executeOrder, generateBar } from './market.ts';
import {
  accrueBorrowFees,
  applyFill,
  checkMargin,
  computeMaintenanceMargin,
  createAccount,
  positionQty,
  markToMarket,
  planLiquidation,
} from './portfolio.ts';
import { computeRepoState, forcedSaleNotional, repoEnabled } from './repo.ts';
import { borrowQuote, dynamicShortMarginRate, planRecall } from './securities-lending.ts';
import {
  addRule,
  bannedShortScope,
  createRegulatorState,
  computeSrs,
  derivedMarginMultiplier,
  expireRules,
  levelFromSrs,
} from './regulator.ts';
import { createAgents, flowToReturn, stepAgents } from './agents.ts';
import { generateRumors, newsFromEvent, type GeneratedRumor, type RumorsFile } from './news.ts';
import { makeContext } from './conditions.ts';
import { RealPriceSource, REAL_PATH_SHOCK_SCALE } from './market-data.ts';

export interface Dataset {
  marketPatch?: MarketPatch;
  events: EventCard[];
  institutions: InstitutionsFile;
  rumors: RumorsFile;
  /**
   * 真实历史市场数据（`data/processed/market.json`）。
   *
   * 可选：不提供时全部标的走「锚点插值 + beta + 噪声」的合成路径。
   * 提供时，有真实历史的标的改走真实路径，事件在其上做小幅扰动。
   * 见 market-data.ts。
   */
  market?: MarketData;
}

export interface EngineOptions {
  config?: Partial<GameConfig>;
  /** 覆盖竞争风险模型的 κ */
  kappa?: number;
  /** 覆盖事件日期抖动幅度（交易日）。默认由时间线模式决定。 */
  jitterDays?: number;
  /** 系统级事件的兜底触发余量（交易日） */
  forceFireMarginDays?: number;
  /** 关闭 NPC（用于单元测试与确定性回归） */
  disableAgents?: boolean;
  /** 关闭传闻生成 */
  disableRumors?: boolean;
}

/**
 * 事件卡 indexReturn 的施加系数。
 *
 * 基础路径本身就是历史锚点（已经包含崩盘），事件的市场冲击只应承担
 * 「再计时」职责——让价格在抖动后的日期上做出反应——而不是再叠加一次完整跌幅。
 * 1.0 会让标普在基础路径之上再跌 45%，个股则被系统性多杀一倍。
 */
const INDEX_SHOCK_SCALE = 0.15;

/** 机构 id → 可交易标的 id（用于 SRS 的敞口计算） */
function buildInstitutionTickerMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const inst of INSTRUMENTS) {
    if (inst.sector === 'index') continue;
    out[inst.id] = inst.id;
  }
  return out;
}

export class GameEngine {
  readonly config: GameConfig;
  readonly state: GameState;
  readonly dataset: Dataset;

  private scenario: ScenarioEngine;
  private streams: Streams;
  private baseMacro: MacroState[];
  private macroIndexByDate: Map<string, number>;
  private haircutRatchet: number;
  private cumulativePlayerImpact = 0;
  private cumulativeMarketDecline = 0;
  private adv20: Map<string, number> = new Map();
  private prevPrices: Map<string, number> = new Map();
  private rumorCooldownUntil: Map<string, number> = new Map();
  private opts: EngineOptions;
  private actions: PlayerAction[] = [];
  private datasetHash: string;
  private reports: TurnReport[] = [];

  get turnReports(): readonly TurnReport[] { return this.reports; }

  /** 真实历史价格源。为 null 时全部标的走合成路径。 */
  private realPrices: RealPriceSource | null = null;

  constructor(dataset: Dataset, options: EngineOptions = {}) {
    const { marketPatch, ...legacyDataset } = dataset;
    dataset = legacyDataset;
    if (options.config?.marketRevision !== undefined) {
      if (options.config.marketRevision !== 1) throw new Error('不支持的行情修订版本');
      dataset = { ...dataset, market: applyMarketRevision(dataset.market, marketPatch) };
    }
    if (options.config?.demoVersion !== undefined) {
      if (options.config.difficulty !== 0) throw new Error('演示版规则仅适用于 D0');
      dataset = { ...dataset, events: demoEvents(dataset.events, options.config.demoVersion) };
    }
    this.dataset = dataset;
    this.datasetHash = fingerprint(dataset);
    this.opts = options;

    const difficulty = options.config?.difficulty ?? DEFAULT_CONFIG.difficulty;
    const requestedIdentity = options.config?.identity ?? DEFAULT_CONFIG.identity;
    const identity = requestedIdentity;
    const profile = IDENTITY_PROFILE[identity];
    this.config = {
      ...DEFAULT_CONFIG,
      ...options.config,
      identity,
      timeline: difficulty === 0 ? 'historical' : options.config?.timeline ?? DEFAULT_CONFIG.timeline,
      initialCapital: options.config?.initialCapital ?? profile.capital,
    };

    const diff = DIFFICULTY_PROFILE[this.config.difficulty];

    this.realPrices = dataset.market ? new RealPriceSource(dataset.market) : null;

    this.streams = createStreams(this.config.seed);
    this.baseMacro = buildMacroSeries(this.config.startDate, this.config.endDate, this.streams.market, {
      noiseScale: diff.noiseScale,
      // 有真实标普序列时用它作基础路径，锚点插值只在缺口处兜底
      spxSeries: this.realPrices?.spxSeries(),
    });
    this.macroIndexByDate = new Map(this.baseMacro.map((m, i) => [m.date, i]));

    // O(1) 的交易日距离：直接查预计算的序号表。
    // 默认的 tradingDayDiff 是逐日遍历，在「每回合 × 每张卡」的兜底检查里会成为瓶颈。
    // 事件卡的 window 边界可能是周末/节假日，所以要向前回退到最近的交易日。
    const ordinalOf = (d: string): number | undefined => {
      const direct = this.macroIndexByDate.get(d);
      if (direct !== undefined) return direct;
      let cursor = d;
      for (let i = 0; i < 7; i++) {
        cursor = prevTradingDay(cursor);
        const found = this.macroIndexByDate.get(cursor);
        if (found !== undefined) return found;
      }
      return undefined;
    };
    const dayDiff = (a: string, b: string): number => {
      const ia = ordinalOf(a);
      const ib = ordinalOf(b);
      if (ia === undefined || ib === undefined) return 9999;
      return ib - ia;
    };

    // 三种时间线模式的真正区别：事件日期围绕史实日期的抖动幅度
    const jitterDays = difficulty === 0 ? 0 : options.jitterDays ?? JITTER_BY_TIMELINE[this.config.timeline];

    this.scenario = new ScenarioEngine(dataset.events, dataset.institutions, {
      timeline: this.config.timeline,
      difficulty: this.config.difficulty,
      kappa: options.kappa ?? diff.hazardKappa,
      forceFireMarginDays: options.forceFireMarginDays ?? 10,
      jitterDays,
      dayDiff,
    });

    const startMacro = this.baseMacro[0];
    const account = createAccount(this.config.initialCapital);

    // 初始 K 线。
    // 有真实数据的标的用真实的首个收盘价作为起始价——否则从 2007-01-02
    // 到数据起点之间会出现一段跳空。
    const bars = new Map<string, Bar[]>();
    const prices = new Map<string, number>();
    for (const inst of INSTRUMENTS) {
      const realFirst = difficulty === 0 || this.config.marketRevision === 1
        ? this.realPrices?.barOnOrBefore(inst.id, this.config.startDate)
        : this.realPrices?.firstBar(inst.id);
      const startPrice = realFirst ? realFirst.close : inst.startPrice;
      prices.set(inst.id, startPrice);
      this.prevPrices.set(inst.id, startPrice);
      this.adv20.set(inst.id, inst.baseAdv);
      bars.set(inst.id, [
        {
          date: this.config.startDate,
          provenance: this.config.marketRevision === 1
            ? realFirst?.date === this.config.startDate && !isEstimatedMarketBar(realFirst) ? 'historical' : realFirst ? 'estimated' : 'synthetic'
            : difficulty === 0 ? (realFirst ? 'estimated' : 'synthetic') : realFirst && isEstimatedMarketBar(realFirst) ? 'estimated' : undefined,
          open: this.config.marketRevision === 1 && realFirst?.date === this.config.startDate ? realFirst.open : startPrice,
          high: this.config.marketRevision === 1 && realFirst?.date === this.config.startDate ? realFirst.high : startPrice,
          low: this.config.marketRevision === 1 && realFirst?.date === this.config.startDate ? realFirst.low : startPrice,
          close: startPrice,
          volume: realFirst?.volume || Math.round(inst.baseAdv / Math.max(0.5, startPrice)),
          adv20: inst.baseAdv,
        },
      ]);
    }

    this.haircutRatchet = startMacro.repoHaircut;
    if (difficulty === 0 && identity === 'bank') initializeBank(account, prices, this.config);

    this.state = {
      ...(difficulty === 0 && identity === 'insurer' ? { insurer: createInsurer(this.config) } : {}),
      ...(difficulty === 0 && identity === 'bank' ? { bank: { defaulted: false } } : {}),
      ...(difficulty === 0 && identity === 'hedge_fund' ? { fund: createFund(this.config) } : {}),
      config: this.config,
      date: this.config.startDate,
      turnIndex: 0,
      bars,
      prices,
      macro: { ...startMacro },
      player: account,
      agents: this.config.difficulty === 0 || options.disableAgents ? [] : createAgents(this.streams.agents),
      regulator: createRegulatorState(),
      institutions: initInstitutionStates(dataset.institutions),
      firedEvents: [],
      activeEffects: [],
      news: [],
      score: [{ date: this.config.startDate, equity: account.equity, drawdown: 0 }],
      pendingOrders: [],
      haltTrading: false,
    };
    if (this.config.demoVersion === 1) {
      const past = this.scenario.cards.filter(card => card.date <= this.state.date &&
        (card.trigger.type !== 'scheduled' || !card.trigger.modeOnly || card.trigger.modeOnly === 'historical'));
      this.state.firedEvents = past.map(card => card.id);
      for (const card of past) {
        for (const id of card.terminalFailure ?? []) {
          if (this.state.institutions[id]) markFailed(this.state.institutions, id, card.date, card.id);
        }
      }
      // 当日收盘已包含过去事件的价格结果，不再叠加过去冲击。
      this.state.news = past.filter(card => card.newsVisibility === 0).slice(-3).map(card => ({
        id: `opening-${card.id}`, date: card.date, headline: card.headline,
        body: `开局已知背景。${card.narrative}`, source: 'historical', credibility: 1, isTrue: true, eventId: card.id,
      }));
    }
  }

  // ------------------------------------------------------------ 只读视图

  /**
   * 玩家可见的 K 线。**这是防止未来函数泄露的唯一入口**——UI 不允许直接读 state.bars。
   * 见 docs/02 §3.1 与 §8。
   */
  visibleBars(instrumentId: string): Bar[] {
    const all = this.state.bars.get(instrumentId) ?? [];
    let lo = 0;
    let hi = all.length;
    // 二分查找最后一条 <= state.date 的记录
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (all[mid].date <= this.state.date) lo = mid + 1;
      else hi = mid;
    }
    return all.slice(0, lo);
  }

  get isOver(): boolean {
    return this.state.date >= this.config.endDate || this.state.player.bankrupt || this.state.fund?.defaulted === true || this.state.bank?.defaulted === true || this.state.insurer?.defaulted === true;
  }

  /** 剩余交易日数 */
  get remainingTurns(): number {
    return tradingDaysBetween(nextTradingDay(this.state.date), this.config.endDate).length;
  }

  // ------------------------------------------------------------ 玩家操作

  submitOrder(order: Order): void {
    if (this.isOver) throw new Error('本局已结束，不能下单');
    if (!order || !INSTRUMENT_BY_ID.has(order.instrumentId) || !Number.isSafeInteger(order.quantity) || order.quantity <= 0 ||
        !['buy', 'sell'].includes(order.side) || order.kind !== 'market') throw new Error('订单无效：仅支持已知标的的正整数市价单');
    if (this.state.pendingOrders.length >= 1000) throw new Error('待处理订单过多');
    this.state.pendingOrders.push({ ...order, submittedAt: this.state.date });
  }

  requestBankRepayment(): void {
    if (!this.state.bank || this.isOver) throw new Error('当前不能提交银行偿债指令');
    if (this.state.bankRefinancePending) throw new Error('同一回合不能同时申请展期与提前偿债');
    this.state.bankRepaymentPending = true;
  }

  requestReinsurance(): void {
    if (!this.state.insurer || this.isOver || this.state.reinsurancePending) throw new Error('当前不能提交再保险指令');
    this.state.reinsurancePending = true;
  }

  requestBankRefinance(request: RefinanceRequest): void {
    if (!this.state.bank || this.isOver || this.state.bankRepaymentPending || this.state.bankRefinancePending) throw new Error('当前不能提交展期指令');
    if (!request || !['secured', 'term'].includes(request.plan) || !this.state.player.loans?.some(l => l.id === request.loanId && l.status === 'active')) throw new Error('展期借款或方案无效');
    this.state.bankRefinancePending = { ...request };
  }

  /** 便捷封装：按金额下单（正=买入，负=卖出）。 */
  submitByNotional(instrumentId: string, notional: number): Order | null {
    const price = this.state.prices.get(instrumentId);
    if (!price || price <= 0) return null;
    const qty = Math.floor(Math.abs(notional) / price);
    if (qty <= 0) return null;
    const order: Order = {
      instrumentId,
      side: notional > 0 ? 'buy' : 'sell',
      quantity: qty,
      kind: 'market',
      submittedAt: this.state.date,
    };
    this.submitOrder(order);
    return order;
  }

  // ------------------------------------------------------------ 回合推进

  advance(): TurnResult {
    if (this.isOver) {
      return {
        date: this.state.date,
        turnIndex: this.state.turnIndex,
        fills: [],
        firedEventIds: [],
        news: [],
        equity: this.state.player.equity,
        marginCall: this.state.player.marginCall,
        bankrupt: this.state.player.bankrupt,
      };
    }

    const diff = DIFFICULTY_PROFILE[this.config.difficulty];
    const nextDate = nextTradingDay(this.state.date);
    const equityBefore = this.state.player.equity;
    const idx = this.macroIndexByDate.get(nextDate);
    const base: MacroState =
      idx !== undefined ? this.baseMacro[idx] : { ...this.baseMacro[this.baseMacro.length - 1], date: nextDate };
    const prevBase = idx !== undefined && idx > 0 ? this.baseMacro[idx - 1] : base;

    const previousDate = this.state.date;
    // ---- 0) 时间推进 ----
    this.state.date = nextDate;
    this.state.turnIndex += 1;

    // ---- 1) 衰减既有状态修正，并清空本回合的收益冲击 ----
    for (const e of this.state.activeEffects) e.remaining -= 1;
    this.state.activeEffects = this.state.activeEffects.filter((e) => e.remaining > 0);
    this.returnShock = { index: 0, perInstrument: new Map() };

    // ---- 2) 事件注入 ----
    const ctx = this.buildContext(base);
    // D0 按日历播放已发生的历史，不让状态谓词、竞争风险或同日前置链推迟新闻。
    // 周末事件在下一交易日显示；中途开始不会把全部过去事件挤到第一天。
    const decisions: FireDecision[] = this.config.difficulty === 0
      ? this.scenario.cards.filter(card => {
          const modeOnly = card.trigger.type === 'scheduled' ? card.trigger.modeOnly : undefined;
          if (this.config.demoVersion === 1 && this.state.firedEvents.includes(card.id)) return false;
          return (!modeOnly || modeOnly === 'historical') && card.date <= nextDate &&
            (card.date > previousDate || (this.state.turnIndex === 1 && card.date === previousDate));
        }).map(card => ({ card, forced: false }))
      : this.scenario.tick(ctx, this.streams.scenario, this.state.institutions);
    const firedEventIds: string[] = [];
    const newNews: NewsItem[] = [];

    for (const d of decisions) {
      this.applyEvent(d, newNews);
      firedEventIds.push(d.card.id);
      this.state.firedEvents.push(d.card.id);
    }

    // 事件后机构信心与脆弱度刷新
    updateConfidence(this.state.institutions, { ...base, systemicStress: ctx.systemicStress });
    this.recomputeFragility(base);

    // ---- 3) 汇总修正量 ----
    const mods = this.aggregateModifiers();
    this.activeBorrowMult = mods.borrowMult;

    // ---- 4) 宏观状态（基础路径 + 事件修正） ----
    // TED 利差不由事件卡直接驱动，而是由信用利差的上行推导出来——
    // 否则 state 型判据（如 tedSpread > 2.6）永远无法在正确的时间满足。
    const derivedTed = base.tedSpread + Math.max(0, mods.creditBump) / 1000;
    const stress = systemicStress(
      base.creditSpread + mods.creditBump,
      derivedTed,
      base.vix * mods.volMult,
    );
    this.haircutRatchet = Math.max(
      haircutFromStress(stress),
      this.haircutRatchet + (haircutFromStress(stress) - this.haircutRatchet) * 0.006,
    );
    this.state.macro = {
      date: nextDate,
      spx: 0,
      // 上限用于防御：VIX 历史盘中最高的 89.53，信用利差峰值约 2100bp
      vix: Math.min(110, Math.max(9, base.vix * mods.volMult)),
      creditSpread: Math.min(3000, Math.max(180, base.creditSpread + mods.creditBump)),
      tedSpread: Math.min(6, derivedTed),
      systemicStress: stress,
      liquidity: clamp(base.liquidity * mods.liqMult, 0.05, 1),
      repoHaircut: clamp(this.haircutRatchet, 0.01, 1),
    };

    // ---- 5) NPC 决策 ----
    let agentFlow = new Map<string, number>();
    if (this.state.agents.length > 0) {
      const res = stepAgents(
        this.state.agents,
        this.state.prices,
        this.prevPrices,
        this.state.macro,
        this.streams.agents,
      );
      agentFlow = res.netFlow;
    }

    // ---- 6) 市场出价 ----
    const baseReturn = prevBase.spx > 0 ? base.spx / prevBase.spx - 1 : 0;
    const spxFlowImpact = flowToReturn(
      agentFlow.get('SPX') ?? 0,
      5e10,
      this.state.macro.liquidity,
      diff.impactEta,
      0.015,
    );
    const spxReturn = baseReturn + mods.indexReturn + spxFlowImpact;

    const newBars = new Map<string, Bar>();
    for (const inst of INSTRUMENTS) {
      const prevClose = this.state.prices.get(inst.id) ?? inst.startPrice;
      const prevAdv = this.adv20.get(inst.id) ?? inst.baseAdv;

      if (this.config.difficulty === 0 && this.realPrices?.has(inst.id)) {
        const historical = this.realPrices.barFor(inst.id, nextDate);
        const volume = historical?.volume ?? 0;
        const close = historical?.close ?? prevClose;
        const adv20 = volume > 0 ? prevAdv * 0.9 + volume * close * 0.1 : prevAdv;
        newBars.set(inst.id, {
          date: nextDate,
          open: historical?.open ?? prevClose,
          high: historical?.high ?? prevClose,
          low: historical?.low ?? prevClose,
          close, volume, adv20,
          provenance: !historical ? 'carried' : historical.filled || volume === 0 ? 'estimated' : 'historical',
        });
        this.adv20.set(inst.id, adv20);
        continue;
      }

      // ---- 真实历史路径 ----
      // 标普由下方的基础路径兜底（它已经用真实序列驱动），其余标的直接用
      // 真实 K 线乘以事件扰动乘数。
      const realBar = inst.id === 'SPX' ? undefined : this.realPrices?.barFor(inst.id, nextDate);
      if (realBar) {
        // 真实路径标的：事件冲击按 REAL_PATH_SHOCK_SCALE 衰减后**当日**施加。
        // 真实数据里已经包含该事件的历史影响，全额叠加就是双重计入；
        // 而不做永久累积，则让真实路径在后续交易日自然把它拉回去。
        const shock = (mods.perInstrument.get(inst.id) ?? 0) * REAL_PATH_SHOCK_SCALE;
        const mult = 1 + shock;
        const close = round2(Math.max(0.01, realBar.close * mult));
        // 回填的 K 线 volume 为 0，用 adv20 反推一个合理值
        const volume =
          realBar.volume > 0
            ? realBar.volume
            : Math.round(prevAdv / Math.max(0.5, realBar.close));
        const dollarVolume = volume * close;
        const adv20 = Math.round(prevAdv * 0.9 + dollarVolume * 0.1);

        const bar: Bar = {
          date: nextDate,
          provenance: isEstimatedMarketBar(realBar) ? 'estimated' : 'historical',
          open: round2(Math.max(0.01, realBar.open * mult)),
          high: round2(Math.max(0.01, realBar.high * mult)),
          low: round2(Math.max(0.01, realBar.low * mult)),
          close,
          volume,
          adv20,
        };

        // 已死亡机构仍要单向衰减（真实数据里收购后的走势不适合作为抵押品估值）
        const dead = this.state.institutions[inst.id]?.alive === false;
        if (dead) {
          bar.close = round2(Math.max(0.01, Math.min(bar.close, prevClose * 0.97)));
          bar.high = round2(Math.max(bar.open, bar.close));
          bar.low = round2(Math.max(0.01, Math.min(bar.open, bar.close, bar.low)));
        }

        newBars.set(inst.id, bar);
        this.adv20.set(inst.id, adv20);
        continue;
      }

      // ---- 合成路径（无真实数据：雷曼/贝尔斯登/美林/华盛顿互惠/两房） ----
      const extra =
        (mods.perInstrument.get(inst.id) ?? 0) +
        flowToReturn(
          agentFlow.get(inst.id) ?? 0,
          prevAdv,
          this.state.macro.liquidity,
          diff.impactEta,
          inst.idioVol,
        );
      const bar = generateBar(
        inst,
        nextDate,
        prevClose,
        spxReturn,
        this.streams.market,
        this.state.macro,
        prevAdv,
        extra,
      );
      if (this.config.difficulty === 0) bar.provenance = 'synthetic';

      // 已死亡机构（破产 / 被接管 / 被收购）的股票必须**单向衰减**。
      // 否则它会像活着的公司一样随机游走，甚至「恢复」——
      // 实测雷曼在破产一年后中位数回到 $4.50、上限 $34.87，这显然荒谬。
      // 现实中这些权益归零后在粉单市场以仙股价格阴跌。
      const failed = this.state.institutions[inst.id]?.alive === false;
      if (failed) {
        bar.close = round2(Math.max(0.01, Math.min(bar.close, prevClose * 0.97)));
        bar.high = round2(Math.max(bar.open, bar.close));
        bar.low = round2(Math.max(0.01, Math.min(bar.open, bar.close, bar.low)));
      }

      newBars.set(inst.id, bar);
      this.adv20.set(inst.id, bar.adv20);
    }

    // 标普价格 = 基础路径 × 累计事件冲击乘数
    const spxBars = this.state.bars.get('SPX')!;
    const prevSpxClose = spxBars[spxBars.length - 1].close;
    const spxBar = newBars.get('SPX')!;
    if (!(this.config.difficulty === 0 && this.realPrices?.has('SPX'))) {
      spxBar.close = round2(Math.max(1, base.spx * this.indexShockMultiplier));
      spxBar.open = round2(prevSpxClose * (1 + spxReturn * 0.4));
      spxBar.high = round2(Math.max(spxBar.open, spxBar.close) * 1.004);
      spxBar.low = round2(Math.min(spxBar.open, spxBar.close) * 0.996);
    }

    // 落盘
    for (const [id, bar] of newBars) {
      this.state.bars.get(id)!.push(bar);
      this.state.prices.set(id, bar.close);
    }
    this.state.macro.spx = spxBar.close;

    // 累计市场跌幅（用于 SRS 的市场压力贡献）
    if (spxReturn < 0) this.cumulativeMarketDecline += Math.abs(spxReturn) * 1e11;

    // ---- 7) 成交（t+1 开盘价） ----
    const fills = this.executePending(newBars, nextDate);

    // ---- 8) 证券借贷：借券费与强制回补 ----
    // 做空不是免费午餐。三重摩擦（见 securities-lending.ts）：
    //   ① 借券费随利用率二次上升，且危机中放大
    //   ② 可借券规模有上限，危机中收缩
    //   ③ 出借人可以召回 → 强制回补 → 在反弹中被逼空
    if (this.config.difficulty === 0) {
      for (const pos of this.state.player.positions.values()) {
        pos.borrowFeeRate = pos.quantity < 0 ? BEGINNER_RULES.borrowFeeRate : 0;
      }
    } else {
      this.settleSecuritiesLending(nextDate, fills, spxReturn);
    }
    const borrowFees = accrueBorrowFees(this.state.player, this.state.prices);
    const banking = this.state.bank ? settleBank(this.state.player, this.state.prices, nextDate, this.state.bankRepaymentPending === true,
      { bank: this.state.bank, stress: this.state.macro.systemicStress, endDate: this.config.endDate, request: this.state.bankRefinancePending }) : undefined;
    if (banking && this.state.bank) {
      this.state.bank.defaulted = banking.defaulted;
      newNews.push(...banking.news);
    }
    const insurance = this.state.insurer ? settleInsurance(this.state.insurer, this.state.player, this.state.prices,
      this.config, nextDate, this.state.macro.systemicStress, this.state.reinsurancePending === true) : undefined;
    if (insurance) newNews.push(...insurance.news);
    markToMarket(this.state.player, this.state.prices);

    // ---- 9) 回购融资与被迫卖出 ----
    if (this.config.difficulty > 0) this.settleRepo(newBars, nextDate, fills);

    // ---- 10) 保证金检查与强平 ----
    if (this.config.difficulty === 0) {
      const unavailable = new Set([...newBars].filter(([, b]) => b.provenance === 'carried').map(([id]) => id));
      const riskFills = settleBeginnerRisk(this.state.player, this.state.prices, nextDate, COMMISSION_RATE, unavailable);
      fills.push(...riskFills);
      if (riskFills.length > 0) newNews.push({
        id: `risk-close-${nextDate}`, date: nextDate, source: 'system', credibility: 1, isTrue: true,
        headline: '空头风险底线触发，已自动平仓',
        body: '收盘净资产低于空头市值的 30%，系统按本日收盘价买回有报价的空头，并收取正常手续费。缺失报价的持仓等待恢复报价后处理。没有额外惩罚滑点；跳空仍可能使损失超过本金。',
      });
    } else {
      this.settleMargin(newBars, nextDate, fills);
    }

    // 教学基金的赎回是外部资本流出，在当天交易、费用和风险处理后兑付。
    const redemption = this.state.fund ? settleFund(this.state.fund, this.state.player, this.state.prices, nextDate) : undefined;
    if (redemption) newNews.push(...redemption.news);

    // ---- 11) 监管 ----
    if (this.config.difficulty > 0) this.stepRegulator(base);

    // ---- 12) 新闻与传闻 ----
    if (this.config.difficulty > 0) this.stepRumors(newNews, ctx);

    // ---- 13) 记分快照 ----
    const snap: ScoreSnapshot = {
      date: nextDate,
      equity: this.state.player.equity,
      drawdown: this.state.player.maxDrawdown,
    };
    this.state.score.push(snap);

    // ---- 14) 记账与清理 ----
    if (this.state.pendingOrders.length > 0 || this.state.bankRepaymentPending || this.state.bankRefinancePending || this.state.reinsurancePending) {
      const action: PlayerAction = { turnIndex: this.state.turnIndex, date: nextDate, orders: this.state.pendingOrders,
        ...(this.state.bankRepaymentPending ? { repayLoans: true } : {}),
        ...(this.state.bankRefinancePending ? { refinance: { ...this.state.bankRefinancePending } } : {}),
        ...(this.state.reinsurancePending ? { buyReinsurance: true } : {}) };
      this.state.news.push(...newNews);
      this.state.pendingOrders = [];
      this.actions.push(structuredClone(action));
    } else {
      this.state.news.push(...newNews);
    }
    delete this.state.bankRepaymentPending;
    delete this.state.bankRefinancePending;
    delete this.state.reinsurancePending;

    this.prevPrices = new Map(this.state.prices);

    const commission = fills.reduce((sum, fill) => sum + fill.commission, 0);
    this.reports.push({
      date: nextDate, equityBefore, equityAfter: this.state.player.equity,
      marketPnl: this.state.player.equity - equityBefore + commission + borrowFees + (redemption?.capitalOutflow ?? 0) + (banking?.loanInterest ?? 0) + (banking?.financingFees ?? 0)
        - (insurance?.premiumIncome ?? 0) + (insurance?.claimExpense ?? 0) + (insurance?.reinsurancePremium ?? 0),
      ...(insurance ? { premiumIncome: insurance.premiumIncome, claimExpense: insurance.claimExpense,
        reinsurancePremium: insurance.reinsurancePremium, claimsPaid: insurance.claimsPaid, recoveriesReceived: insurance.recoveriesReceived } : {}),
      ...(banking?.financingFees ? { financingFees: banking.financingFees } : {}),
      ...(banking ? { loanInterest: banking.loanInterest, principalRepaid: banking.principalRepaid, interestPaid: banking.interestPaid } : {}),
      ...(redemption ? { capitalOutflow: redemption.capitalOutflow } : {}),
      commission, borrowFees, fills: structuredClone(fills), firedEventIds: [...firedEventIds],
    });

    return {
      date: nextDate,
      turnIndex: this.state.turnIndex,
      fills,
      firedEventIds,
      news: newNews,
      equity: this.state.player.equity,
      marginCall: this.state.player.marginCall,
      bankrupt: this.state.player.bankrupt,
    };
  }

  // ------------------------------------------------------------ 内部步骤

  private buildContext(base: MacroState) {
    const account = this.state.player;
    const shortConcentration: Record<string, number> = {};
    for (const pos of account.positions.values()) {
      if (pos.quantity >= 0) continue;
      const inst = INSTRUMENT_BY_ID.get(pos.instrumentId);
      if (!inst || inst.sharesOutstanding <= 0) continue;
      shortConcentration[pos.instrumentId] = Math.abs(pos.quantity) / inst.sharesOutstanding;
    }

    const lev = account.equity > 0 ? grossExposureOf(account, this.state.prices) / account.equity : 1;

    return makeContext({
      date: this.state.date,
      turnIndex: this.state.turnIndex,
      spx: base.spx,
      vix: base.vix,
      creditSpread: base.creditSpread,
      tedSpread: base.tedSpread,
      liquidity: base.liquidity,
      systemicStress: base.systemicStress,
      repoHaircut: this.haircutRatchet,
      srs: this.state.regulator.srs,
      leverage: lev,
      shortConcentration,
      fired: new Set(this.state.firedEvents),
    });
  }

  private applyEvent(d: FireDecision, newsOut: NewsItem[]): void {
    const card = d.card;
    const difficulty = this.config.difficulty;

    // 幅度抖动：impact × (1 + ε)，见 docs/02 §7.2
    const jittered = this.scenario.jitterImpact(card, this.streams.scenario) as ImpactVector;

    // ---- 收益冲击：一次性即期施加 ----
    //
    // `equityReturn` / `indexReturn` 在 docs/02 里的语义是「**即期**收益冲击」。
    // 早前版本把它们当作持续每日收益、按 decayDays 衰减地反复施加，
    // 结果是 new_century_collapse 的 −4.2% 行业传染连续 12 天天天生效，
    // 累计 −38%——金融股在 2007 年年中就全部穿零（实测 GS 跌到 $0.01）。
    //
    // 正确的做法：收益冲击当回合一次性吃掉；只有**状态**类修正
    // （信用利差 / 波动率 / 流动性 / 融资）才按 decayDays 衰减。
    //
    // 另外，`indexReturn` 会被 INDEX_SHOCK_SCALE 缩减后再施加：
    // 基础路径本身就是历史（已经包含崩盘），事件的市场冲击只应承担
    // 「再计时」（让价格在抖动后的日期上反应），不该再叠加一次完整跌幅。
    const rawIndex = jittered.indexReturn ?? 0;
    const scaledIndex = rawIndex * INDEX_SHOCK_SCALE;
    this.returnShock.index += scaledIndex;

    // SPX 的累计冲击乘数**只在没有真实数据时**累积。
    //
    // 有真实数据时，标普的基础路径本身就是历史（已经包含崩盘），
    // 再累积事件冲击会造成永久性水平位移——实测标普期末会低 7%
    // （1032 vs 实际的 1115）。此时事件只应做「再计时扰动」，
    // 即影响当日收益，由真实路径在后续交易日把它拉回去。
    if (!this.realPrices) {
      this.indexShockMultiplier *= 1 + scaledIndex;
    }

    const resolved = resolveImpact(jittered);
    for (const [id, v] of resolved.perInstrument) {
      this.returnShock.perInstrument.set(id, (this.returnShock.perInstrument.get(id) ?? 0) + v);
    }

    // ---- 状态类修正：按 decayDays 衰减 ----
    const stateImpact: ImpactVector = {
      decayDays: card.impact.decayDays,
      creditSpreadDelta: jittered.creditSpreadDelta,
      volMultiplier: jittered.volMultiplier,
      liquidityMultiplier: jittered.liquidityMultiplier,
      borrowFeeMultiplier: jittered.borrowFeeMultiplier,
      marginRequirementMultiplier: jittered.marginRequirementMultiplier,
      shortableRestriction: jittered.shortableRestriction,
    };

    this.state.activeEffects.push({
      eventId: card.id,
      appliedOn: this.state.date,
      impact: stateImpact,
      remaining: card.impact.decayDays,
      total: card.impact.decayDays,
    });

    // 机构脆弱度传染
    applyFragilityDelta(this.state.institutions, this.dataset.institutions, card.affectsFragility);

    // 机构死亡：只由显式声明的 terminalFailure 决定。
    // 早前版本对所有竞争风险卡都标记死亡，导致同一机构的后续卡永久失去资格。
    if (card.terminalFailure) {
      for (const instId of card.terminalFailure) {
        if (this.state.institutions[instId]) {
          markFailed(this.state.institutions, instId, this.state.date, card.id);
        }
      }
    }

    // 回购折扣率的永久棘轮
    if (card.impact.repoHaircutDelta) {
      this.haircutRatchet = clamp(this.haircutRatchet + card.impact.repoHaircutDelta, 0.01, 1);
    }

    // 监管规则注入
    if (this.config.difficulty > 0 && card.imposesRule) {
      addRule(this.state.regulator, {
        kind: card.imposesRule.kind,
        scope: card.imposesRule.scope,
        durationDays: card.imposesRule.durationDays,
        date: this.state.date,
        sourceEventId: card.id,
      });
    }

    // 新闻（仅难度允许时对玩家展示，但事件本身总会发生）
    if (this.scenario.visibilityOk(card)) {
      const news = newsFromEvent(card, this.state.date, difficulty, this.streams.news, DIFFICULTY_PROFILE[difficulty].newsNoise);
      if (difficulty === 0 && card.imposesRule) {
        news.body += '\n\n新手模式说明：这条新闻介绍历史政策，D0 不对你的账户执行禁空、额外追保或监管处罚。';
      }
      newsOut.push(news);
    }
  }

  private recomputeFragility(base: MacroState): void {
    const file = this.dataset.institutions;
    const instById = new Map(file.institutions.map((i) => [i.id, i]));
    for (const [id, s] of Object.entries(this.state.institutions)) {
      const inst = instById.get(id);
      if (!inst) continue;
      const recomputed = computeFragility(inst, s, file.weights, base.systemicStress);
      // 事件带来的额外脆弱度（applyFragilityDelta）叠加在模型值之上
      s.fragility = Math.max(recomputed, Math.min(1.3, s.fragility));
    }
  }

  private aggregateModifiers(): {
    indexReturn: number;
    creditBump: number;
    volMult: number;
    liqMult: number;
    borrowMult: number;
    marginMult: number;
    shortableRestricted: boolean;
    perInstrument: Map<string, number>;
  } {
    let indexReturn = 0;
    let creditBump = 0;
    let volMult = 1;
    let liqMult = 1;
    let borrowMult = 1;
    let marginMult = 1;
    let shortableRestricted = false;
    const perInstrument = new Map<string, number>();

    for (const e of this.state.activeEffects) {
      const w = e.total > 0 ? e.remaining / e.total : 0;
      const im = e.impact;
      creditBump += (im.creditSpreadDelta ?? 0) * w;

      // 乘数类字段用「最强事件主导」而不是连乘。
      // 连乘会让多个重叠事件把 VIX 推到 200 以上（实测），彻底破坏数值可信度。
      volMult = Math.max(volMult, 1 + ((im.volMultiplier ?? 1) - 1) * w);
      liqMult = Math.min(liqMult, 1 + ((im.liquidityMultiplier ?? 1) - 1) * w);
      borrowMult = Math.max(borrowMult, 1 + ((im.borrowFeeMultiplier ?? 1) - 1) * w);
      marginMult = Math.max(marginMult, 1 + ((im.marginRequirementMultiplier ?? 1) - 1) * w);
      if (im.shortableRestriction) shortableRestricted = true;
    }

    // 收益冲击是本回合一次性注入的（见 applyEvent），不随 decayDays 重复施加
    indexReturn = this.returnShock.index;
    for (const [id, v] of this.returnShock.perInstrument) {
      perInstrument.set(id, v);
    }

    // 流动性乘数的下限：允许严重收缩，但不允许归零
    liqMult = Math.max(0.3, liqMult);

    return { indexReturn, creditBump, volMult, liqMult, borrowMult, marginMult, shortableRestricted, perInstrument };
  }

  private executePending(newBars: Map<string, Bar>, date: string): Fill[] {
    const diff = DIFFICULTY_PROFILE[this.config.difficulty];
    const fills: Fill[] = [];
    const bannedSectors = this.config.difficulty === 0 ? new Set<string>() : bannedShortScope(this.state.regulator);
    const shortBanned = new Set<string>();
    for (const inst of INSTRUMENTS) {
      if (inst.sector === 'index') continue;
      if (bannedSectors.has(inst.sector) || bannedSectors.has(inst.id)) shortBanned.add(inst.id);
    }

    for (const order of this.state.pendingOrders) {
      const bar = newBars.get(order.instrumentId);
      const inst = INSTRUMENT_BY_ID.get(order.instrumentId);
      if (!bar || !inst) continue;
      if (this.config.difficulty === 0 && bar.provenance === 'carried') {
        fills.push({ order, filledAt: date, price: bar.open, quantity: 0, impact: 0, commission: 0, reason: 'missing_quote' });
        continue;
      }

      // 券源约束：只能借到有限的券（见 securities-lending.ts）。
      // 注意传的是**绝对容量** capacityShares，不是 headroomShares——
      // executeOrder 内部会自己减去当前空头。早前传 headroomShares 导致
      // 容量被减了两次，做空只能做到可用券源的一半。
      //
      // 但这条约束只适用于「借股票来卖」。指数没有流通股
      // （SPX 的 sharesOutstanding 是 0），现实中做空大盘走的是期货/ETF，
      // 不存在借券环节。早前无条件套用券源模型，结果 maxShortQty = 0，
      // 做空标普 500 永远返回 not_shortable——而「做空大盘」恰恰是
      // 这个游戏最核心的操作（最优策略就是先空后多）。
      const currentQty = positionQty(this.state.player, order.instrumentId);
      let maxShortQty: number | undefined;
      if (this.config.difficulty > 0 && order.side === 'sell' && inst.sharesOutstanding > 0) {
        const quote = borrowQuote({
          instrumentId: order.instrumentId,
          floatShares: inst.sharesOutstanding,
          price: bar.open,
          currentShortQty: Math.max(0, -currentQty),
          stress: this.state.macro.systemicStress,
        });
        maxShortQty = quote.capacityShares;
      }

      let fill = executeOrder({
        order,
        openPrice: bar.open,
        adv20: bar.adv20,
        liquidity: this.state.macro.liquidity,
        dailyVol: inst.idioVol + 0.01,
        currentQty,
        shortable: inst.shortable,
        rng: this.streams.market,
        maxShortQty,
        params: {
          eta: diff.impactEta,
          marginRate: 0.25,
          commissionRate: COMMISSION_RATE,
          shortBanned,
        },
      });

      if (this.config.difficulty === 0) {
        const openingPrices = new Map([...newBars].map(([id, bar]) => [id, bar.open]));
        fill = limitBeginnerFill(this.state.player, openingPrices, fill, this.state.bank ? BANK_RULES.exposureLimit : 1);
      }
      fill.filledAt = date;
      if (fill.quantity > 0) {
        fill.filledAt = date;
        applyFill(this.state.player, fill, date);
        this.cumulativePlayerImpact += fill.quantity * fill.price * fill.impact;
      }
      fills.push(fill);
    }
    return fills;
  }

  private settleRepo(newBars: Map<string, Bar>, date: string, fills: Fill[]): void {
    const lev = this.state.player.equity > 0 ? grossExposureOf(this.state.player, this.state.prices) / this.state.player.equity : 1;
    const marginMult = derivedMarginMultiplier(this.state.regulator);
    const repoState = computeRepoState(
      this.state.player,
      this.state.prices,
      this.state.macro,
      lev,
      this.state.regulator.srs,
      { identity: this.config.identity, difficulty: this.config.difficulty, marginMultiplier: marginMult },
    );

    this.state.player.repoCapacity = repoState.capacity;
    this.state.player.repoUsed = repoState.used;
    this.state.player.repoRolloverRate = repoState.rolloverRate;

    if (!repoState.forcedSale || repoState.shortfall <= 0) return;

    // 融资缺口 → 被迫卖出（火售）
    const need = forcedSaleNotional(repoState);
    const longs = [...this.state.player.positions.values()]
      .filter((p) => p.quantity > 0)
      .map((p) => ({ p, value: p.quantity * (this.state.prices.get(p.instrumentId) ?? p.avgPrice) }))
      .sort((a, b) => b.value - a.value);

    let covered = 0;
    for (const { p, value } of longs) {
      if (covered >= need) break;
      const price = this.state.prices.get(p.instrumentId) ?? p.avgPrice;
      const target = Math.min(value, need - covered);
      const qty = Math.floor(target / Math.max(0.01, price));
      if (qty <= 0) continue;
      const fill = executeOrder({
        order: {
          instrumentId: p.instrumentId,
          side: 'sell',
          quantity: qty,
          kind: 'market',
          submittedAt: date,
        },
        openPrice: price,
        adv20: newBars.get(p.instrumentId)?.adv20 ?? 1e9,
        liquidity: this.state.macro.liquidity,
        dailyVol: (INSTRUMENT_BY_ID.get(p.instrumentId)?.idioVol ?? 0.02) + 0.01,
        currentQty: p.quantity,
        shortable: true,
        rng: this.streams.market,
        params: {
          eta: DIFFICULTY_PROFILE[this.config.difficulty].impactEta,
          marginRate: 0.25,
          commissionRate: COMMISSION_RATE,
          shortBanned: new Set(),
        },
        // 被迫卖出永远发生在最差的价格上
        slippagePenalty: 2,
      });
      if (fill.quantity > 0) {
        fill.filledAt = date;
        applyFill(this.state.player, fill, date);
        fills.push(fill);
      }
      covered += target;
    }
    markToMarket(this.state.player, this.state.prices);
  }

  /**
   * 证券借贷结算：更新借券费，并在出借人召回时执行强制回补。
   *
   * 这是做空策略的**尾部风险来源**。没有它，高利用率空头的收益分布会过窄
   * （实测：全仓做空的分布只有 3.3 个百分点宽，结果几乎确定）。
   */
  private settleSecuritiesLending(date: string, fills: Fill[], spxReturn: number): void {
    const stress = this.state.macro.systemicStress;
    const diff = DIFFICULTY_PROFILE[this.config.difficulty];
    const mods = this.activeBorrowMult;

    for (const pos of [...this.state.player.positions.values()]) {
      if (pos.quantity >= 0) continue;
      const def = INSTRUMENT_BY_ID.get(pos.instrumentId);
      const price = this.state.prices.get(pos.instrumentId);
      if (!def || !price) continue;

      const quote = borrowQuote({
        instrumentId: pos.instrumentId,
        floatShares: def.sharesOutstanding,
        price,
        currentShortQty: Math.abs(pos.quantity),
        stress,
        borrowMult: mods,
        marketReturnToday: spxReturn,
      });

      // ① 借券费随利用率与压力上升
      pos.borrowFeeRate = quote.feeRate;

      // ② 出借人召回 → 强制回补
      if (quote.recallRisk > 0 && this.streams.market.chance(quote.recallRisk)) {
        const { quantity, penalty } = planRecall(Math.abs(pos.quantity), this.streams.market);
        if (quantity > 0) {
          const fill = executeOrder({
            order: {
              instrumentId: pos.instrumentId,
              side: 'buy',
              quantity,
              kind: 'market',
              submittedAt: date,
            },
            openPrice: price,
            adv20: this.state.bars.get(pos.instrumentId)?.slice(-1)[0]?.adv20 ?? 1e9,
            liquidity: this.state.macro.liquidity,
            dailyVol: def.idioVol + 0.01,
            currentQty: pos.quantity,
            shortable: true,
            rng: this.streams.market,
            params: {
              eta: diff.impactEta,
              marginRate: 0.25,
              commissionRate: COMMISSION_RATE,
              shortBanned: new Set(),
            },
            // 逼空：你必须在所有人都知道你在买的时候买
            slippagePenalty: penalty,
          });
          if (fill.quantity > 0) {
            fill.filledAt = date;
            applyFill(this.state.player, fill, date);
            fills.push(fill);
            this.state.news.push({
              id: `recall-${pos.instrumentId}-${date}`,
              date,
              headline: `${pos.instrumentId} 的借券被出借人召回，你的空头被强制回补 ${fill.quantity.toLocaleString('en-US')} 股`,
              body: `成交价 ${fill.price.toFixed(2)}，含 ${penalty.toFixed(1)} 倍惩罚性滑点。当出借人要求归还证券时，你无权协商——只能在市场上买入。`,
              source: 'system',
              credibility: 1,
              isTrue: true,
            });
          }
        }
      }
    }
  }

  /** 本回合事件带来的借券费倍数，由 aggregateModifiers 写入。 */
  private activeBorrowMult = 1;

  /**
   * 本回合一次性注入的收益冲击。
   * 每回合开始时清空，由 applyEvent 填充，aggregateModifiers 消费。
   */
  private returnShock: { index: number; perInstrument: Map<string, number> } = {
    index: 0,
    perInstrument: new Map(),
  };

  /** SPX 的累计事件冲击乘数（永久累积，与个股行为一致）。 */
  private indexShockMultiplier = 1;

  private settleMargin(newBars: Map<string, Bar>, date: string, fills: Fill[]): void {
    const marginMult = derivedMarginMultiplier(this.state.regulator);
    // 危机中交易所与券商会同时上调空头保证金率
    const shortMarginRate = dynamicShortMarginRate(this.state.macro.systemicStress);
    const mm = computeMaintenanceMargin(this.state.player, this.state.prices, {
      marginMultiplier: marginMult,
      shortMarginRate,
    });
    this.state.player.maintenanceMargin = mm;

    const { status, deficit } = checkMargin(this.state.player, this.state.prices, mm);

    if (status === 'ok') {
      this.state.player.marginCall = false;
      this.state.player.marginCallSince = undefined;
      return;
    }

    if (status === 'margin_call') {
      if (!this.state.player.marginCall) {
        this.state.player.marginCall = true;
        this.state.player.marginCallSince = date;
      }
      return;
    }

    // 强平：惩罚性滑点 2×
    const plan = planLiquidation(this.state.player, this.state.prices, deficit);
    for (const item of plan) {
      const side = item.quantity > 0 ? 'sell' : 'buy';
      const qty = Math.abs(item.quantity);
      const price = this.state.prices.get(item.instrumentId) ?? 1;
      const fill = executeOrder({
        order: { instrumentId: item.instrumentId, side, quantity: qty, kind: 'market', submittedAt: date },
        openPrice: price,
        adv20: newBars.get(item.instrumentId)?.adv20 ?? 1e9,
        liquidity: this.state.macro.liquidity,
        dailyVol: (INSTRUMENT_BY_ID.get(item.instrumentId)?.idioVol ?? 0.02) + 0.01,
        currentQty: positionQty(this.state.player, item.instrumentId),
        shortable: true,
        rng: this.streams.market,
        params: {
          eta: DIFFICULTY_PROFILE[this.config.difficulty].impactEta,
          marginRate: 0.25,
          commissionRate: COMMISSION_RATE,
          shortBanned: new Set(),
        },
        slippagePenalty: 2,
      });
      if (fill.quantity > 0) {
        fill.filledAt = date;
        applyFill(this.state.player, fill, date);
        fills.push(fill);
      }
    }
    markToMarket(this.state.player, this.state.prices);
    this.state.player.marginCall = this.state.player.equity < mm;
  }

  private stepRegulator(base: MacroState): void {
    expireRules(this.state.regulator, this.state.date);

    const spxBars = this.state.bars.get('SPX')!;
    const recent = spxBars.slice(-21);
    const marketDown = recent.length > 1 && recent[recent.length - 1].close < recent[0].close * 0.9;

    const srs = computeSrs({
      account: this.state.player,
      prices: this.state.prices,
      institutions: this.state.institutions,
      institutionToTicker: buildInstitutionTickerMap(),
      cumulativePlayerImpact: this.cumulativePlayerImpact,
      cumulativeMarketDecline: this.cumulativeMarketDecline,
    });

    this.state.regulator.srs = srs.srs;
    this.state.regulator.shortConcentration = srs.shortConcentration;
    this.state.regulator.level = levelFromSrs(
      srs.srs,
      srs.shortConcentration,
      this.state.player.bankrupt,
      marketDown,
    );
    this.state.regulator.priceImpactShare =
      this.cumulativeMarketDecline > 0
        ? clamp(this.cumulativePlayerImpact / this.cumulativeMarketDecline, 0, 1)
        : 0;

    void base;
  }

  private stepRumors(newNews: NewsItem[], ctx: ReturnType<typeof makeContext>): void {
    if (this.opts.disableRumors) return;
    const difficulty = this.config.difficulty;
    const stress = this.state.macro.systemicStress;

    // 生成频率：平静期每 3–5 日一条，危机期每日 1–3 条
    const count = stress > 0.6 ? (this.streams.news.chance(0.4) ? 3 : 2) : this.streams.news.chance(0.3) ? 1 : 0;
    if (count === 0) return;

    const cooldown = new Set<string>();
    for (const [id, until] of this.rumorCooldownUntil) {
      if (this.state.turnIndex < until) cooldown.add(id);
    }

    const institutionIds = Object.keys(this.state.institutions);
    const institutionNames: Record<string, string> = {};
    for (const inst of this.dataset.institutions.institutions) institutionNames[inst.id] = inst.name;

    const generated: GeneratedRumor[] = generateRumors(
      this.dataset.rumors,
      {
        date: this.state.date,
        condition: ctx,
        institutions: this.state.institutions,
        institutionIds,
        institutionNames,
        recentMarketReturn: this.recentMarketReturn(),
      },
      this.streams.news,
      { difficulty, count, onCooldown: cooldown },
    );

    for (const g of generated) {
      newNews.push(g.news);
      // 冷却
      const template = this.dataset.rumors.templates.find((t) => t.id === g.templateId);
      if (template) this.rumorCooldownUntil.set(template.id, this.state.turnIndex + template.cooldownDays);

      // 只有在「被相信」时才影响机构脆弱度（自我实现的链条）
      if (g.news.credibility > 0.5 && Math.abs(g.fragilityEffect) > 0) {
        for (const s of Object.values(this.state.institutions)) {
          if (!s.alive) continue;
          s.fragility = Math.max(0, s.fragility + g.fragilityEffect * 0.5);
        }
      }
    }
  }

  private recentMarketReturn(): number {
    const bars = this.state.bars.get('SPX')!;
    const n = Math.min(20, bars.length - 1);
    if (n <= 0) return 0;
    const last = bars[bars.length - 1].close;
    const then = bars[bars.length - 1 - n].close;
    return then > 0 ? last / then - 1 : 0;
  }

  // ------------------------------------------------------------ 序列化

  /** 存档 = { 种子, 配置, 操作日志 }，见 docs/02 §5。 */
  save(): GameSave {
    return {
      version: SAVE_VERSION,
      datasetHash: this.datasetHash,
      config: { ...this.config },
      seed: this.config.seed,
      date: this.state.date,
      turnIndex: this.state.turnIndex,
      equity: this.state.player.equity,
      actions: structuredClone(this.actions),
      pendingOrders: structuredClone(this.state.pendingOrders),
      ...(this.state.bankRepaymentPending ? { bankRepaymentPending: true } : {}),
      ...(this.state.bankRefinancePending ? { bankRefinancePending: { ...this.state.bankRefinancePending } } : {}),
      ...(this.state.reinsurancePending ? { reinsurancePending: true } : {}),
      stateHash: fingerprint(this.state),
    };
  }

  /** D0 通过操作日志重建完整引擎，连同内部随机流一起复现；不信任存档净值。 */
  static restore(dataset: Dataset, input: unknown): GameEngine {
    validateSave(input);
    const engine = new GameEngine(dataset, { config: input.config });
    if (input.datasetHash !== engine.datasetHash) throw new Error('行情或事件数据已变化，不能按新数据恢复旧存档');
    let cursor = 0;
    for (let turn = 1; turn <= input.turnIndex; turn++) {
      if (engine.isOver) throw new Error('存档包含结束后的操作');
      const action = input.actions[cursor];
      if (action?.turnIndex === turn) {
        if (action.repayLoans) engine.requestBankRepayment();
        if (action.refinance) engine.requestBankRefinance(action.refinance);
        if (action.buyReinsurance) engine.requestReinsurance();
        for (const order of action.orders) engine.submitOrder(order);
        cursor++;
      }
      const result = engine.advance();
      if (action?.turnIndex === turn && action.date !== result.date) throw new Error('操作日志日期不一致');
    }
    for (const order of input.pendingOrders) engine.submitOrder(order);
    if (input.bankRepaymentPending) engine.requestBankRepayment();
    if (input.bankRefinancePending) engine.requestBankRefinance(input.bankRefinancePending);
    if (input.reinsurancePending) engine.requestReinsurance();
    if (engine.state.date !== input.date || fingerprint(engine.state) !== input.stateHash) {
      throw new Error('存档回放校验失败，原存档已保留');
    }
    return engine;
  }

  /** 面向 UI 的摘要。 */
  summary(): {
    date: string;
    turnIndex: number;
    equity: number;
    cash: number;
    maxDrawdown: number;
    marginCall: boolean;
    bankrupt: boolean;
    positions: Array<{ id: string; qty: number; avgPrice: number; price: number; pnl: number }>;
    macro: MacroState;
    regulatorLevel: number;
    srs: number;
  } {
    const positions = [...this.state.player.positions.values()].map((p) => {
      const price = this.state.prices.get(p.instrumentId) ?? p.avgPrice;
      return {
        id: p.instrumentId,
        qty: p.quantity,
        avgPrice: p.avgPrice,
        price,
        pnl: (price - p.avgPrice) * p.quantity,
      };
    });
    return {
      date: this.state.date,
      turnIndex: this.state.turnIndex,
      equity: this.state.player.equity,
      cash: this.state.player.cash,
      maxDrawdown: this.state.player.maxDrawdown,
      marginCall: this.state.player.marginCall,
      bankrupt: this.state.player.bankrupt,
      positions,
      macro: this.state.macro,
      regulatorLevel: this.state.regulator.level,
      srs: this.state.regulator.srs,
    };
  }

  institutionList(): Institution[] {
    return this.dataset.institutions.institutions;
  }

  institutionState(id: string): InstitutionState | undefined {
    return this.state.institutions[id];
  }
}

// ---------------------------------------------------------------- 工具

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function grossExposureOf(account: Account, prices: Map<string, number>): number {
  let v = 0;
  for (const pos of account.positions.values()) {
    const p = prices.get(pos.instrumentId) ?? pos.avgPrice;
    v += Math.abs(pos.quantity) * p;
  }
  return v;
}

/** 由起始日生成全部交易日（供 UI 的时间轴使用）。 */
export function timelineOf(config: GameConfig): string[] {
  return tradingDaysBetween(config.startDate, config.endDate);
}

export { Rng, addDays, resolveImpact };
