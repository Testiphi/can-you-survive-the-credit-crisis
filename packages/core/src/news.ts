/**
 * 新闻与传闻生成。
 *
 * 传闻是「信息即难度」的主要载体（见 docs/06 §7）。
 * 关键设计：**预警型传闻对价格几乎无影响，但会提前告知融资机制即将恶化。**
 * 只有高难度玩家能看到它们——不是你给的信息更少，而是高难度玩家有能力读懂同样的信息。
 */

import type { ConditionContext } from './conditions.ts';
import type { InstitutionState, NewsItem } from './types.ts';
import type { Rng } from './rng.ts';

export interface TrueProbability {
  base: number;
  multiplierIfFragilityAbove?: { threshold: number; value: number };
  multiplierIfCreditSpreadAbove?: { threshold: number; value: number };
  multiplierIfSystemicStressAbove?: { threshold: number; value: number };
  multiplierIfConfidenceBelow?: { threshold: number; value: number };
  multiplierIfVixAbove?: { threshold: number; value: number };
  multiplierIfPlayerSRSAbove?: { threshold: number; value: number };
  multiplierIfMarketDown?: { threshold: number; windowDays: number; value: number };
  multiplierIfLiquidityBelow?: { threshold: number; value: number };
  multiplierIfTedAbove?: { threshold: number; value: number };
}

export interface RumorTemplate {
  id: string;
  category: string;
  headlineTemplate: string;
  bodyTemplate: string;
  targetInstitutionRequired: boolean;
  trueProbability: TrueProbability;
  priceEffectIfBelieved: Record<string, number>;
  fragilityEffect: number;
  cooldownDays: number;
  newsVisibility: number;
  playerSrsEffect?: number;
  designNote?: string;
}

export interface DifficultyNewsScaling {
  trueRatio: number;
  noiseSigma: number;
  visibleCategories: string[];
  extraNoise?: string;
}

export interface RumorsFile {
  version: number;
  purpose?: string;
  designNote?: string;
  categoryCount?: Record<string, number>;
  templates: RumorTemplate[];
  credibilityModel?: {
    observedCredibility?: string;
    difficultyScaling?: Record<string, DifficultyNewsScaling>;
    [k: string]: unknown;
  };
  implementationNotes?: string[];
}

export interface RumorContext {
  date: string;
  condition: ConditionContext;
  institutions: Record<string, InstitutionState>;
  /** 可被点名的机构（按脆弱度加权抽取） */
  institutionIds: string[];
  /** 机构 id → 显示名 */
  institutionNames: Record<string, string>;
  /** 最近的累计市场跌幅（负数） */
  recentMarketReturn: number;
}

const DEFAULT_SCALING: Record<number, DifficultyNewsScaling> = {
  0: { trueRatio: 0.7, noiseSigma: 0.14, visibleCategories: ['institution_distress', 'market_flow', 'policy'] },
  1: {
    trueRatio: 0.55,
    noiseSigma: 0.16,
    visibleCategories: ['institution_distress', 'market_flow', 'policy', 'credit', 'earnings'],
  },
  2: { trueRatio: 0.45, noiseSigma: 0.18, visibleCategories: ['*'] },
  3: { trueRatio: 0.35, noiseSigma: 0.2, visibleCategories: ['*'], extraNoise: '对手方可主动投放假消息' },
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 逐个应用 trueProbability 上的状态倍率。 */
function effectiveTrueProbability(t: TrueProbability, ctx: RumorContext, maxFragility: number): number {
  let p = t.base;
  if (t.multiplierIfFragilityAbove && maxFragility > t.multiplierIfFragilityAbove.threshold) {
    p *= t.multiplierIfFragilityAbove.value;
  }
  if (t.multiplierIfCreditSpreadAbove && ctx.condition.creditSpread > t.multiplierIfCreditSpreadAbove.threshold) {
    p *= t.multiplierIfCreditSpreadAbove.value;
  }
  if (t.multiplierIfSystemicStressAbove && ctx.condition.systemicStress > t.multiplierIfSystemicStressAbove.threshold) {
    p *= t.multiplierIfSystemicStressAbove.value;
  }
  if (t.multiplierIfVixAbove && ctx.condition.vix > t.multiplierIfVixAbove.threshold) {
    p *= t.multiplierIfVixAbove.value;
  }
  if (t.multiplierIfPlayerSRSAbove && ctx.condition.srs > t.multiplierIfPlayerSRSAbove.threshold) {
    p *= t.multiplierIfPlayerSRSAbove.value;
  }
  if (t.multiplierIfLiquidityBelow && ctx.condition.liquidity < t.multiplierIfLiquidityBelow.threshold) {
    p *= t.multiplierIfLiquidityBelow.value;
  }
  if (t.multiplierIfTedAbove && ctx.condition.tedSpread > t.multiplierIfTedAbove.threshold) {
    p *= t.multiplierIfTedAbove.value;
  }
  if (t.multiplierIfMarketDown && ctx.recentMarketReturn < t.multiplierIfMarketDown.threshold) {
    p *= t.multiplierIfMarketDown.value;
  }
  return clamp(p, 0, 0.95);
}

function fillTemplate(text: string, institutionName: string, amount: number): string {
  return text.replaceAll('{institution}', institutionName).replaceAll('{amount}', String(amount));
}

export interface GeneratedRumor {
  news: NewsItem;
  templateId: string;
  fragilityEffect: number;
  priceEffect: Record<string, number>;
  playerSrsEffect: number;
}

export interface RumorGenOptions {
  difficulty: number;
  /** 本回合生成多少条 */
  count: number;
  /** 每条进入冷却的回合数由模板决定，这里传入已冷却的模板 id 集合 */
  onCooldown: Set<string>;
}

/**
 * 生成一批传闻。
 *
 * 真消息概率 = 模板基础概率 × 状态倍率 × (难度真实比例 / 0.55)
 * 观察到的可信度 = clamp((真 ? 0.78 : 0.32) + N(0, σ), 0.05, 0.95)
 */
export function generateRumors(
  file: RumorsFile,
  ctx: RumorContext,
  rng: Rng,
  options: RumorGenOptions,
): GeneratedRumor[] {
  const scaling =
    file.credibilityModel?.difficultyScaling?.[String(options.difficulty)] ??
    DEFAULT_SCALING[options.difficulty] ??
    DEFAULT_SCALING[1];

  const visible = file.templates.filter((t) => {
    if (t.newsVisibility > options.difficulty) return false;
    if (options.onCooldown.has(t.id)) return false;
    if (scaling.visibleCategories.includes('*')) return true;
    return scaling.visibleCategories.includes(t.category);
  });
  if (visible.length === 0) return [];

  const out: GeneratedRumor[] = [];
  for (let i = 0; i < options.count; i++) {
    const template = rng.pick(visible);

    // 按脆弱度加权抽取被点名的机构
    const targetId = pickInstitution(ctx, rng);
    const targetName = targetId ? (ctx.institutionNames[targetId] ?? targetId) : '某大型机构';
    const maxFragility = targetId ? (ctx.institutions[targetId]?.fragility ?? 0) : maxFragilityOf(ctx);

    const trueP = effectiveTrueProbability(template.trueProbability, ctx, maxFragility);
    const ratioScale = scaling.trueRatio / 0.55;
    const isTrue = rng.chance(clamp(trueP * ratioScale, 0, 0.95));

    const baseCred = isTrue ? 0.78 : 0.32;
    const credibility = clamp(baseCred + rng.gaussian(0, scaling.noiseSigma), 0.05, 0.95);

    const amount = rng.pick([5, 8, 10, 15, 20, 30, 50, 75, 100]);

    out.push({
      news: {
        id: `${template.id}-${ctx.date}-${i}`,
        date: ctx.date,
        headline: fillTemplate(template.headlineTemplate, targetName, amount),
        body: fillTemplate(template.bodyTemplate, targetName, amount),
        source: 'generated',
        credibility,
        isTrue,
      },
      templateId: template.id,
      fragilityEffect: template.fragilityEffect,
      priceEffect: template.priceEffectIfBelieved,
      playerSrsEffect: template.playerSrsEffect ?? 0,
    });
  }
  return out;
}

function maxFragilityOf(ctx: RumorContext): number {
  let m = 0;
  for (const s of Object.values(ctx.institutions)) {
    if (s.alive && s.fragility > m) m = s.fragility;
  }
  return m;
}

function pickInstitution(ctx: RumorContext, rng: Rng): string | null {
  const ids = ctx.institutionIds.filter((id) => ctx.institutions[id]?.alive !== false);
  if (ids.length === 0) return null;
  // 脆弱度越高越可能被点名
  const weights = ids.map((id) => Math.pow(ctx.institutions[id]?.fragility ?? 0.3, 2) + 0.05);
  return ids[rng.weightedIndex(weights)];
}

/** 由事件卡生成历史新闻。 */
export function newsFromEvent(
  card: { id: string; headline: string; narrative: string },
  date: string,
  difficulty: number,
  rng: Rng,
  noiseSigma: number,
): NewsItem {
  // 历史事件视为真实，可信度高且噪声小
  return {
    id: `evt-${card.id}`,
    date,
    headline: card.headline,
    body: card.narrative,
    source: 'historical',
    credibility: clamp(0.92 + rng.gaussian(0, noiseSigma / 2), 0.05, 0.99),
    isTrue: true,
    eventId: card.id,
  };
}
