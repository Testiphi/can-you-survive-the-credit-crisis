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
import { tradingDayDiff } from './time.ts';

export interface ScenarioOptions {
  timeline: TimelineMode;
  difficulty: number;
  /** 覆盖竞争风险模型的 κ */
  kappa?: number;
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
  /** 调试探针：每个回合回调一次合格事件列表。生产环境不要设置。 */
  debugProbe?: (info: {
    date: string;
    eligible: string[];
    scheduledRolls: Array<{ id: string; p: number; hit: boolean }>;
  }) => void;
}

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

  constructor(cards: EventCard[], institutionsFile: InstitutionsFile, opts: ScenarioOptions) {
    this.cards = cards.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    this.byId = new Map(cards.map((c) => [c.id, c]));
    this.institutionsFile = institutionsFile;
    this.opts = opts;
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
    const [lo, hi] = card.window;
    if (ctx.date < lo) return false;
    const t = card.trigger as { modeOnly?: TimelineMode };
    if (t.modeOnly && t.modeOnly !== this.opts.timeline) return false;
    if (ctx.date <= hi) return true;
    return card.reversible === false || card.isSystemicEvent;
  }

  /** 窗口已过时触发概率的衰减系数。 */
  private latePenalty(card: EventCard, ctx: ConditionContext): number {
    return ctx.date <= card.window[1] ? 1 : 0.25;
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
    const [lo, hi] = card.window;
    const a = Date.parse(lo + 'T00:00:00Z');
    const b = Date.parse(hi + 'T00:00:00Z');
    const t = Date.parse(ctx.date + 'T00:00:00Z');
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 4;
    const progress = Math.min(1, Math.max(0, (t - a) / (b - a)));
    return 1 + 3 * progress * progress;
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
    const competing = eligible.filter((c) => c.trigger.type === 'competing_risk');
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
      if (card.trigger.type === 'competing_risk') continue;

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
    const margin = this.opts.forceFireMarginDays ?? 5;
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
