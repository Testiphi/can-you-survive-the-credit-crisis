/**
 * 事件引擎：DAG、触发、竞争风险、新闻生成。
 *
 * 触发顺序（每个交易回合）：
 *   1. 过滤：窗口 / 前置条件 / 互斥 / 时间线模式
 *   2. 分批：竞争风险卡 vs 普通卡
 *   3. 竞争风险：按机构风险率做一次指数竞速，每天最多一个机构倒下
 *   4. 普通卡：按 scheduled / state 判定
 *   5. 兜底：系统级事件窗口将尽时强制触发，保证故事线完整
 */

import type {
  ConditionContext,
} from './conditions.ts';
import { evaluateCondition, isPredicate } from './conditions.ts';
import type { EventCard, InstitutionState, Institution, InstitutionsFile, TimelineMode } from './types.ts';
import type { Rng } from './rng.ts';
import { failureHazard, fragilityStats, raceForFailure } from './institutions.ts';
import { tradingDayDiff, shiftTradingDays } from './time.ts';

export interface ScenarioOptions {
  timeline: TimelineMode;
  difficulty: number;
  /** 覆盖竞争风险模型的 κ */
  kappa?: number;
  /**
   * 事件日期的抖动幅度（交易日）。
   *
   * 这是三种时间线模式的**真正区别**（docs/05 §7）：
   *
   *   0   —— historical：事件在历史日期当天触发，价格与新闻完全一致
   *   10  —— jittered（默认）：小幅抖动，保持新闻与价格大体对齐
   *   30  —— parallel：大幅抖动，甚至可以出现「雷曼被救」这类平行分支
   *
   * 早前版本没有这个参数，实际抖动完全由 `window` 的宽度决定——
   * 而窗口常有一到三个月宽，导致新闻出现的日期与价格实际变动的日期
   * 可能错开好几周。这对游戏体验是致命的：玩家会看到「雷曼破产」
   * 的新闻，而价格早在两个月前就跌完了。
   */
  jitterDays?: number;
  /**
   * 系统级事件窗口将尽时的强制触发余量（交易日）。
   * 0 表示不强制。保证「雷曼一定会倒」这类叙事承诺。
   */
  forceFireMarginDays?: number;
  /**
   * 交易日距离函数。由引擎注入一个 O(1) 实现——
   * 默认的 tradingDayDiff 是逐日遍历，在每回合×每卡调用时会成为瓶颈。
   */
  dayDiff?: (a: string, b: string) => number;
  /** 交易日位移函数（默认用 time.ts 的 shiftTradingDays），便于测试注入。 */
  shiftDays?: (d: string, n: number) => string;
  /**
   * 单回合最多触发几个事件。默认 1。
   *
   * 为什么需要上限：早期一张卡一旦「合格且投掷命中」就会立刻触发，
   * 而同一回合可能有多张卡同时命中——实测有 13% 的事件回合会一次弹出
   * 2 个以上，最多 4 个。对玩家而言这是**信息倾泻**：
   * 点一次「快进到事件」，新闻流里突然多出四条头条，前因后果完全无法消化。
   *
   * 被挤掉的卡不会丢失——它们的窗口是几个月宽，下一个回合会重新投掷。
   * 强制触发（兜底）的事件优先级最高，永远保留：它们是因果链的安全网。
   */
  maxEventsPerTurn?: number;
  /** 调试探针：每个回合回调一次合格事件列表。生产环境不要设置。 */
  debugProbe?: (info: {
    date: string;
    eligible: string[];
    scheduledRolls: Array<{ id: string; p: number; hit: boolean }>;
  }) => void;
}

/** 各时间线模式的抖动幅度（交易日）。与 docs/05 §7 的表格一致。 */
export const JITTER_BY_TIMELINE: Record<TimelineMode, number> = {
  historical: 0,
  jittered: 10,
  parallel: 30,
};

export interface FireDecision {
  card: EventCard;
  /** 是否由兜底机制强制触发 */
  forced: boolean;
  /** 竞争风险模式下获胜的机构 */
  winnerInstitution?: string;
}

export class ScenarioEngine {
  readonly cards: EventCard[];
  readonly byId: Map<string, EventCard>;
  readonly institutionsFile: InstitutionsFile;
  private opts: ScenarioOptions;
  /**
   * 被其他卡片依赖的事件 id 集合。
   *
   * 这些卡在因果链上处于**必经之路**：一旦它们被静默丢弃，
   * 所有下游卡片都会永久失去资格，整条叙事线崩塌。
   * 因此它们和「不可逆 / 系统性」事件一样，必须能够迟到触发。
   *
   * 这是窗口收窄后暴露出来的问题：早前实际抖动由宽达数月的 `window` 决定，
   * 卡片总有充足机会在窗口内命中；窗口收到 ±10 交易日后，
   * 前置条件稍有延迟就会把整条链拖死。
   */
  private dependedUpon: Set<string>;

  constructor(cards: EventCard[], institutionsFile: InstitutionsFile, opts: ScenarioOptions) {
    this.cards = cards.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    this.byId = new Map(cards.map((c) => [c.id, c]));
    this.institutionsFile = institutionsFile;
    this.opts = opts;

    this.dependedUpon = new Set();
    for (const c of cards) {
      for (const r of c.requires ?? []) this.dependedUpon.add(r);
      for (const g of c.requireAnyOf ?? []) for (const r of g) this.dependedUpon.add(r);
    }
  }

  /** 该事件是否有下游依赖者。 */
  hasDependents(id: string): boolean {
    return this.dependedUpon.has(id);
  }

  /** 前置条件是否满足。 */
  prereqsMet(card: EventCard, ctx: ConditionContext): boolean {
    for (const token of card.requires ?? []) {
      if (!this.tokenSatisfied(token, ctx)) return false;
    }
    const groups = card.requireAnyOf ?? [];
    if (groups.length === 0) return true;
    return groups.some((group) => group.every((token) => this.tokenSatisfied(token, ctx)));
  }

  private tokenSatisfied(token: string, ctx: ConditionContext): boolean {
    // 事件 id：必须已触发
    if (this.byId.has(token)) return ctx.fired.has(token);
    // 状态谓词或表达式
    if (isPredicate(token) || /[<>=]/.test(token)) return evaluateCondition(token, ctx);
    // 未注册的 id：视为未满足（数据校验器应已挡住这种引用）
    return false;
  }

  /**
   * 卡片的**有效触发窗口**。
   *
   * 原始 `window` 常常宽达一到三个月（它是 DAG 的合法区间，不是抖动幅度）。
   * 真正的抖动由时间线模式决定，即以历史日期 `card.date` 为中心的 ±jitterDays，
   * 并与原始窗口取交集——原始窗口仍然是硬边界。
   *
   * 这样就把「事件最早/最晚可能发生在哪」与「它历史上发生在何时」这两件事
   * 分开了：前者是 `window`（因果约束），后者是 `date`（史实锚点）。
   */
  private effectiveWindow(card: EventCard): [string, string] {
    const jitter = this.opts.jitterDays ?? 0;
    if (jitter <= 0) return [card.date, card.date];

    const shift = this.opts.shiftDays ?? shiftTradingDays;
    const lo = shift(card.date, -jitter);
    const hi = shift(card.date, jitter);
    // 与原始窗口取交集
    return [lo > card.window[0] ? lo : card.window[0], hi < card.window[1] ? hi : card.window[1]];
  }

  /**
   * 窗口过滤。
   *
   * 窗口是「首选区间」，不是硬边界：
   * 如果一张不可逆的卡因为前置事件迟到而错过了窗口，它**仍然可以迟到触发**，
   * 只是概率大幅衰减（见 `latePenalty`）。
   *
   * 这是必要的——否则一次时序错位会让整条后续因果链永久失效。
   * （实测：`credit_market_freeze` 的 state 判据在 2007 年 8 月无法满足，
   *   导致依赖它的 `northern_rock_run` 错过窗口，其后 38 张卡全部不触发。）
   */
  private windowOk(card: EventCard, ctx: ConditionContext): boolean {
    // 最早可触发时间由抖动决定（史实日期 − jitterDays）
    const [lo] = this.effectiveWindow(card);
    if (ctx.date < lo) return false;
    const t = card.trigger as { modeOnly?: TimelineMode };
    if (t.modeOnly && t.modeOnly !== this.opts.timeline) return false;
    // 但**硬截止仍然是原始窗口的末端**，不能用窄窗口。
    //
    // 这一点是有代价的：如果硬截止改用窄窗口（史实日期 + jitterDays），
    // 那么 `reversible: true` 且非系统性的事件在错过窄窗口后就**永远无法触发**，
    // 因果链从第一环断裂。实测 seed 1 因此一个事件都没触发，贝尔斯登活到了
    // 2009 年底（$122.73）。原始窗口是 DAG 的合法区间，必须保留为兜底。
    if (ctx.date <= card.window[1]) return true;
    // 迟到触发的许可：
    //   · 不可逆事件（历史无法撤销）
    //   · 系统性事件（整条叙事线的锚点）
    //   · 有下游依赖者的事件（因果链上的必经之路，静默丢弃会拖死全局）
    return card.reversible === false || card.isSystemicEvent === true || this.dependedUpon.has(card.id);
  }

  /**
   * 有效窗口已过时触发概率的衰减系数。
   *
   * 早期实现给迟到触发打 0.25 折，本意是「优先在窗口内触发」。但有效窗口
   * 现在只是史实日期附近的 ±jitterDays，而原始窗口往往还要再宽一两个月——
   * 于是「迟到区」极大，卡片在那里以 baseP × 4 × 0.25 = baseP 的速度慢慢抽，
   * 实测美林减记因此比史实晚了 36 个交易日，新闻和价格彻底错位。
   *
   * 正确的语义是：既然已经迟到了，就该尽快补上（爬升系数 4× 已足够）。
   */
  private latePenalty(_card: EventCard, _ctx: ConditionContext): number {
    return 1;
  }

  /**
   * 触发概率的窗口内爬升系数。
   *
   * **这是一个关键的正确性保障，不只是手感调优。**
   *
   * 事件卡构成一条串行因果链：如果早期某张卡在窗口内一次都没抽中，
   * 它后面依赖它的所有卡都会永久失去资格——整条叙事线崩塌。
   * （实测：`bear_stearns_fund_margin_call` 曾出现 78 次 5% 投掷零命中，
   *   代价是其后 86 张卡全部不再触发。）
   *
   * 语义上也更合理：前置条件满足得越久、窗口越接近尾声，
   * 「这件事即将发生」的紧迫性越高。用平方爬升，窗口末期概率提升至 4 倍。
   */
  private rampFactor(card: EventCard, ctx: ConditionContext): number {
    // 概率从「最早可触发」爬到**史实日期**达到峰值（4×），之后保持峰值。
    //
    // 峰值对齐史实日期——而不是原始窗口末端——是这里的关键。
    // 早前峰值落在窗口末端，于是卡片倾向于在窗口后段才触发，
    // 实测 `subprime_delinquency_rise` 偏了 22 个交易日。
    // 对齐史实日期之后，卡片集中在「它真正发生的那一天」附近触发；
    // 而已经迟到的卡片保持 4× 概率，能尽快补上，不至于无限拖尾。
    const lo = Date.parse(this.effectiveWindow(card)[0] + 'T00:00:00Z');
    const peak = Date.parse(card.date + 'T00:00:00Z');
    const t = Date.parse(ctx.date + 'T00:00:00Z');
    if (!Number.isFinite(lo) || !Number.isFinite(peak) || t >= peak) return 4;
    if (peak <= lo) return 4;
    const progress = Math.min(1, Math.max(0, (t - lo) / (peak - lo)));
    return 1 + 3 * progress * progress;
  }

  /** 是否为严格历史回放模式：没有抖动。 */
  private get isHistorical(): boolean {
    return (this.opts.jitterDays ?? 0) <= 0;
  }

  /** 难度可见性（仅影响新闻，不影响触发）。 */
  visibilityOk(card: EventCard): boolean {
    return card.newsVisibility <= this.opts.difficulty;
  }

  private exclusivityOk(card: EventCard, ctx: ConditionContext): boolean {
    for (const other of card.exclusiveWith ?? []) {
      if (ctx.fired.has(other)) return false;
    }
    return true;
  }

  /**
   * 推进一个交易日，返回本回合触发的事件。
   * 调用方负责应用冲击、写入宏/机构状态。
   */
  tick(
    ctx: ConditionContext,
    rng: Rng,
    states: Record<string, InstitutionState>,
  ): FireDecision[] {
    const fired: FireDecision[] = [];
    const nowFired = new Set(ctx.fired);

    const eligible = this.cards.filter(
      (c) =>
        !nowFired.has(c.id) &&
        this.windowOk(c, ctx) &&
        this.exclusivityOk(c, ctx) &&
        this.prereqsMet(c, ctx),
    );

    // ---- 1) 竞争风险：每天最多一个机构失败 ----
    //
    // historical 模式下**不走竞争风险竞速**：按每张卡的历史日期确定性触发。
    // 竞速的意义在于「谁先倒下可以变化」，而严格历史回放恰恰不要这个变化。
    const competing = this.isHistorical
      ? []
      : eligible.filter((c) => c.trigger.type === 'competing_risk');
    if (competing.length > 0) {
      const stats = fragilityStats(states);

      // 同一机构可能有多张卡（如「回购挤兑」与「公司面危机」），取 baseHazard 最大的那张
      const byInstitution = new Map<string, EventCard>();
      for (const card of competing) {
        const trg = card.trigger as { institution: string; baseHazard: number };
        const prev = byInstitution.get(trg.institution);
        const prevHazard = prev ? (prev.trigger as { baseHazard: number }).baseHazard : -1;
        if (!prev || trg.baseHazard > prevHazard) byInstitution.set(trg.institution, card);
      }

      const candidates: Array<{ id: string; hazard: number; card: EventCard }> = [];
      for (const [instId, card] of byInstitution) {
        // 「MARKET」等伪机构：使用平均脆弱度，风险率只随系统性压力变化。
        // 这用于见底、火售螺旋一类不针对特定机构的竞争风险事件。
        const state = states[instId] ?? { id: instId, fragility: stats.mean, confidence: 0.5, alive: true };
        // 注意：**不**用 state.alive 过滤。
        // 同一机构可能有多张竞争风险卡（如「回购挤兑」与「公司面崩溃」），
        // 早期那张触发后不应让后续那张永久失去资格——它由 nowFired 负责去重。
        const hazard = failureHazard(
          state,
          stats,
          ctx.systemicStress,
          this.institutionsFile.hazardModel,
          this.opts.kappa,
        );
        candidates.push({ id: instId, hazard, card });
      }

      if (candidates.length > 0) {
        const winnerId = raceForFailure(candidates, (r) => rng.exponential(r));
        if (winnerId) {
          const winner = candidates.find((c) => c.id === winnerId)!;
          fired.push({ card: winner.card, forced: false, winnerInstitution: winnerId });
          nowFired.add(winner.card.id);
        }
      }
    }

    // ---- 2) 普通事件 ----
    const scheduledRolls: Array<{ id: string; p: number; hit: boolean }> = [];
    for (const card of eligible) {
      if (nowFired.has(card.id)) continue;
      if (fired.some((f) => f.card.id === card.id)) continue;
      if (card.trigger.type === 'competing_risk' && !this.isHistorical) continue;

      // ---- 严格历史回放 ----
      // 到达史实日期（或前置条件首次满足）即触发：不看概率、也不看状态谓词。
      //
      // 不看谓词是刻意的：`state` 型卡片（如「对手方风险全面浮现」）的判据是
      // 由宏观模型推导的，而宏观模型只是对历史的近似——实测它的
      // `tedSpread > 2.6` 在史实日当天并不满足，于是做空禁令被迫推迟 9 个交易日，
      // 新闻与价格因此错位。历史回放模式下应当以**史实记录**为准。
      if (this.isHistorical) {
        if (this.opts.debugProbe) scheduledRolls.push({ id: card.id, p: 1, hit: true });
        fired.push({ card, forced: false });
        nowFired.add(card.id);
        continue;
      }

      if (card.trigger.type === 'scheduled') {
        const baseP = card.trigger.probabilityPerDay;
        const p = baseP * this.rampFactor(card, ctx) * this.latePenalty(card, ctx);
        const hit = rng.chance(p);
        if (this.opts.debugProbe) scheduledRolls.push({ id: card.id, p, hit });
        if (hit) {
          fired.push({ card, forced: false });
          nowFired.add(card.id);
        }
        continue;
      }

      // state
      if (evaluateCondition(card.trigger.predicate, ctx)) {
        const baseP = card.trigger.probabilityPerDay;
        const p = baseP === undefined ? 1 : baseP * this.latePenalty(card, ctx);
        if (p >= 1 || rng.chance(p)) {
          fired.push({ card, forced: false });
          nowFired.add(card.id);
        }
      }
    }

    if (this.opts.debugProbe) {
      this.opts.debugProbe({
        date: ctx.date,
        eligible: eligible.map((c) => c.id),
        scheduledRolls,
      });
    }

    // ---- 3) 兜底：窗口将尽的不可逆事件强制触发 ----
    // 覆盖所有「历史上必然发生」的卡（isSystemicEvent 或 reversible === false），
    // 而不只是系统性事件——因为因果链上任何一环断裂都会让后续全部失效。
    //
    // historical 模式关闭兜底：那里一切按史实日期确定性触发，不需要安全网。
    // 而且兜底用的是**原始窗口**的末端，会比史实日期更早触发——
    // 实测做空禁令因此提前了一天（原始窗口 09-17~09-25，史实日期 09-19）。
    const margin = this.isHistorical ? 0 : (this.opts.forceFireMarginDays ?? 5);
    if (margin > 0) {
      const diff = this.opts.dayDiff ?? tradingDayDiff;
      for (const card of this.cards) {
        if (nowFired.has(card.id)) continue;
        if (!card.isSystemicEvent && card.reversible !== false) continue;
        if (card.trigger.type === 'competing_risk') continue;
        // 窗口尚未开始 → 直接跳过（廉价判断，避免无谓的日期计算）
        if (ctx.date < card.window[0]) continue;
        const t = card.trigger as { modeOnly?: TimelineMode };
        if (t.modeOnly && t.modeOnly !== this.opts.timeline) continue;

        const daysLeft = diff(ctx.date, card.window[1]);
        if (daysLeft < 0 || daysLeft > margin) continue;
        if (!this.exclusivityOk(card, ctx)) continue;
        if (!this.prereqsMet(card, ctx)) continue;

        fired.push({ card, forced: true });
        nowFired.add(card.id);
      }
    }

    // ---- 4) 单回合事件数上限 ----
    // 强制触发的事件优先保留；其余按原顺序补足剩余名额。
    const cap = this.opts.maxEventsPerTurn ?? 1;
    if (cap > 0 && fired.length > cap) {
      const keep = new Set<FireDecision>();
      let slots = cap;
      for (const f of fired) {
        if (f.forced && slots > 0) {
          keep.add(f);
          slots--;
        }
      }
      for (const f of fired) {
        if (slots > 0 && !keep.has(f)) {
          keep.add(f);
          slots--;
        }
      }
      for (let i = fired.length - 1; i >= 0; i--) {
        if (!keep.has(fired[i])) fired.splice(i, 1);
      }
    }

    return fired;
  }

  /** 计算某事件的冲击幅度抖动：impact × (1 + ε)，ε ~ N(0, σ²)。见 docs/02 §7.2。 */
  jitterImpact(card: EventCard, rng: Rng, sigma = 0.3) {
    const eps = 1 + rng.gaussian(0, sigma);
    const src = card.impact;
    const scale = (v: number | undefined) => (v === undefined ? undefined : v * eps);
    return {
      ...src,
      equityReturn: scale(src.equityReturn),
      indexReturn: scale(src.indexReturn),
      creditSpreadDelta: scale(src.creditSpreadDelta),
      // 乘数类字段朝 1 靠拢抖动，不整体放大
      volMultiplier: src.volMultiplier === undefined ? undefined : 1 + (src.volMultiplier - 1) * eps,
    };
  }

  /** 该事件是否为陷阱卡（用于复盘与统计）。 */
  isTrap(id: string): boolean {
    return this.byId.get(id)?.isTrap === true;
  }

  /** 统计某机构对应的失败事件卡。 */
  cardsForInstitution(instId: string): EventCard[] {
    return this.cards.filter(
      (c) => c.trigger.type === 'competing_risk' && (c.trigger as { institution: string }).institution === instId,
    );
  }

  institutionList(): Institution[] {
    return this.institutionsFile.institutions;
  }
}
