/**
 * NPC 对手模拟。
 *
 * 设计立场（见 docs/01 §3.3）：**NPC 有自己的目标，不针对玩家。**
 * 痛苦应该是涌现的，不是被狙击的。
 *
 * 因此这里建模的是**约束驱动的被迫行为**，而不是「看空/看多」的观点：
 *   - 保守派基金被赎回驱动，必须卖
 *   - 投行有杠杆与融资约束，评级下调被迫抛售
 *   - 做市商在恐慌时撤单（流动性消失）
 *   - 对冲基金做空后会被迫回补（逼空的燃料）
 */

import type { AgentType, MacroState, Money, NPCAgent, Position } from './types.ts';
import type { Rng } from './rng.ts';
import { INSTRUMENTS } from './instruments.ts';

const AGENT_PROFILES: Record<
  AgentType,
  {
    count: number;
    equity: Money;
    leverage: number;
    riskAppetite: number;
    trendSensitivity: number;
    redemptionPressure: number;
    informationLead: number;
  }
> = {
  retail: { count: 120, equity: 2e5, leverage: 1, riskAppetite: 1.6, trendSensitivity: 2.2, redemptionPressure: 0.1, informationLead: 0 },
  conservative_fund: { count: 30, equity: 5e8, leverage: 1.3, riskAppetite: 0.4, trendSensitivity: 0.5, redemptionPressure: 1.0, informationLead: 0 },
  hedge_fund: { count: 25, equity: 2e8, leverage: 3.5, riskAppetite: 1.2, trendSensitivity: 1.4, redemptionPressure: 0.7, informationLead: 1 },
  bank: { count: 6, equity: 5e10, leverage: 14, riskAppetite: 0.8, trendSensitivity: 0.6, redemptionPressure: 0.3, informationLead: 2 },
  market_maker: { count: 5, equity: 1e9, leverage: 6, riskAppetite: 0.6, trendSensitivity: -0.8, redemptionPressure: 0.2, informationLead: 0 },
};

export function createAgents(rng: Rng, enabledTypes?: AgentType[]): NPCAgent[] {
  const types = enabledTypes ?? (Object.keys(AGENT_PROFILES) as AgentType[]);
  const agents: NPCAgent[] = [];
  for (const type of types) {
    const p = AGENT_PROFILES[type];
    for (let i = 0; i < p.count; i++) {
      agents.push({
        id: `${type}-${i}`,
        type,
        equity: p.equity * rng.range(0.6, 1.5),
        leverage: p.leverage,
        positions: new Map<string, Position>(),
        params: {
          riskAppetite: p.riskAppetite * rng.range(0.7, 1.3),
          trendSensitivity: p.trendSensitivity * rng.range(0.7, 1.3),
          redemptionPressure: p.redemptionPressure * rng.range(0.7, 1.3),
          informationLead: p.informationLead,
        },
      });
    }
  }
  return agents;
}

export interface AgentStepResult {
  /** 标的 id → 净买入金额（正=买入，负=卖出） */
  netFlow: Map<string, Money>;
  /** 各类型的总流出（用于 UI 与新闻） */
  forcedSellingByType: Record<string, Money>;
}

/**
 * 推进一轮 NPC 行为。
 *
 * 核心是 `forcedSelling`：2008 年大部分抛售不是因为看空，是因为必须卖。
 */
export function stepAgents(
  agents: NPCAgent[],
  prices: Map<string, number>,
  prevPrices: Map<string, number>,
  macro: MacroState,
  rng: Rng,
): AgentStepResult {
  const netFlow = new Map<string, Money>();
  const forcedSellingByType: Record<string, Money> = {};

  // 当日的市场收益，作为趋势信号
  const spx = prices.get('SPX') ?? 0;
  const spxPrev = prevPrices.get('SPX') ?? spx;
  const marketReturn = spxPrev > 0 ? spx / spxPrev - 1 : 0;

  const tradables = INSTRUMENTS.filter((i) => i.sector !== 'index');

  for (const agent of agents) {
    // ---- ① 赎回压力：保守派基金在危机中被赎回，必须卖出 ----
    const redemption = agent.params.redemptionPressure * macro.systemicStress;
    let forcedNotional = 0;
    if (redemption > 0.05 && rng.chance(Math.min(0.9, redemption))) {
      for (const pos of agent.positions.values()) {
        const p = prices.get(pos.instrumentId) ?? pos.avgPrice;
        const value = Math.abs(pos.quantity) * p;
        const sellRatio = Math.min(0.5, redemption * rng.range(0.3, 1.0));
        const notional = value * sellRatio;
        forcedNotional += notional;
        addFlow(netFlow, pos.instrumentId, -notional);
      }
      if (forcedNotional > 0) {
        forcedSellingByType[agent.type] = (forcedSellingByType[agent.type] ?? 0) + forcedNotional;
      }
    }

    // ---- ② 趋势跟随：散户追涨杀跌 ----
    const trendSignal = agent.params.trendSensitivity * marketReturn;
    if (Math.abs(trendSignal) > 0.002 && rng.chance(0.3)) {
      const target = tradables[rng.int(tradables.length)];
      const budget = agent.equity * 0.05 * Math.min(1, Math.abs(trendSignal) * 20);
      addFlow(netFlow, target.id, Math.sign(trendSignal) * budget);
    }

    // ---- ③ 做市商撤单：恐慌时流动性消失（体现为不提供反向流动性） ----
    if (agent.type === 'market_maker') {
      if (macro.systemicStress > 0.6 && rng.chance(macro.systemicStress)) {
        // 撤单 → 消耗一部分净流量，制造「想跑跑不掉」
        // 这里只记录不产生流量，真正的流动性收缩由 macro.liquidity 承担
        continue;
      }
    }

    // ---- ④ 空头回补：逼空的燃料 ----
    if (macro.systemicStress < 0.5 && rng.chance(0.05)) {
      for (const pos of agent.positions.values()) {
        if (pos.quantity >= 0) continue;
        const p = prices.get(pos.instrumentId) ?? pos.avgPrice;
        const cover = Math.abs(pos.quantity) * p * rng.range(0.1, 0.4);
        addFlow(netFlow, pos.instrumentId, cover);
      }
    }
  }

  return { netFlow, forcedSellingByType };
}

function addFlow(map: Map<string, Money>, id: string, delta: Money): void {
  map.set(id, (map.get(id) ?? 0) + delta);
}

/**
 * 把 NPC 净流量转换成价格冲击（比例）。
 * 使用与玩家相同的平方根律，保证「规模有重量」的一致性。
 */
export function flowToReturn(
  flow: Money,
  adv20: number,
  liquidity: number,
  eta: number,
  dailyVol: number,
): number {
  if (flow === 0) return 0;
  const capacity = Math.max(1, adv20 * liquidity);
  const ratio = Math.min(2, Math.abs(flow) / capacity);
  const impact = eta * dailyVol * Math.sqrt(ratio);
  return Math.sign(flow) * impact;
}

/** NPC 总权益，用于系统性风险的宏观分量（暂未使用，保留）。 */
export function totalAgentEquity(agents: NPCAgent[]): Money {
  return agents.reduce((a, b) => a + b.equity, 0);
}
