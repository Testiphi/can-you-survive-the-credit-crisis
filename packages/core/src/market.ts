/**
 * 市场模拟：价格生成与订单执行。
 *
 * 价格 = 基础路径（宏观锚点）× 事件冲击 × (1 + 路径噪声) × (1 + 交易冲击)
 * 见 docs/03 §1。
 */

import type { Bar, DateStr, Fill, MacroState, Order } from './types.ts';
import type { InstrumentDef } from './instruments.ts';
import type { Rng } from './rng.ts';

/**
 * 随机成分的单日上限（防止 GBM 噪声数值爆炸）。
 *
 * 注意：这个上限**只作用于随机成分**（beta + 特质 + 跳跃）。
 * 事件卡刻意设定的大冲击不受它约束——`lehman_collapse` 的 −94%、
 * `bear_stearns_collapse` 的 −90% 都是真实的历史单日跌幅，被削平成
 * −35% 会让「破产」这个事件完全失去重量。
 *
 * 早前的实现把整个收益一起 clamp，导致所有事件冲击静默截断在 ±35%，
 * 而单元测试完全没发现——因为测试断言的是机制，不是量级。
 */
const MAX_STOCHASTIC_RETURN = 0.35;

/** 含事件冲击在内的单日总收益上限（保住物理性：股票一天不能跌超过 100%）。 */
const MAX_TOTAL_RETURN = 0.97;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 生成一个标的在某交易日的 K 线。
 *
 * @param spxReturn 当日标普的收益（来自基础路径 + 事件冲击 + NPC 流量）
 * @param extraReturn 该标的专属的额外收益（来自事件卡的 equityReturn）
 */
export function generateBar(
  def: InstrumentDef,
  date: DateStr,
  prevClose: number,
  spxReturn: number,
  rng: Rng,
  macro: MacroState,
  prevAdv20: number,
  extraReturn = 0,
): Bar {
  // 系统性成分
  const betaPart = def.beta * spxReturn;
  // 特质成分
  const idio = def.idioVol * rng.normal();
  // 跳跃成分：**对称的尾部跳空**，不做系统性漂移。
  //
  // 早期版本给跳跃加了 −6%·stress 的负漂移，结果与 beta 双重计入了危机：
  // 系统性下跌本来就应该由 beta × SPX 承担，个股跳跃只负责「肥尾」。
  // 两者叠加会让金融股在 2009 年底跌到真实水平的 5%（实测 GS $8）。
  const lambdaPerYear = 2 + 28 * macro.systemicStress;
  const jump = rng.jump(lambdaPerYear / 252) ? rng.gaussian(0, def.idioVol * 2.5) : 0;

  // 随机部分先各自限幅，再叠加事件冲击
  const stochastic = clamp(betaPart + idio + jump, -MAX_STOCHASTIC_RETURN, MAX_STOCHASTIC_RETURN);
  const ret = clamp(stochastic + extraReturn, -MAX_TOTAL_RETURN, MAX_TOTAL_RETURN);
  const close = Math.max(0.01, prevClose * (1 + ret));

  // 日内路径：开盘跳空 + 高低点
  const openGap = ret * rng.range(0.05, 0.55) + (rng.normal() * def.idioVol) / 3;
  const open = Math.max(0.01, prevClose * (1 + clamp(openGap, -MAX_TOTAL_RETURN, MAX_TOTAL_RETURN)));
  const wickUp = Math.abs(rng.normal()) * def.idioVol * 0.9;
  const wickDn = Math.abs(rng.normal()) * def.idioVol * 0.9;
  const high = Math.max(open, close) * (1 + wickUp);
  const low = Math.min(open, close) * (1 - wickDn);

  // 成交量：恐慌时放大
  const volNoise = Math.exp(rng.gaussian(0, 0.35));
  const turnover = def.baseAdv * (0.7 + 1.6 * macro.systemicStress) * macro.liquidity * volNoise;
  const volume = Math.max(1, turnover / Math.max(0.5, close));

  // 成交额与 20 日平均（指数加权）
  const dollarVolume = volume * close;
  const adv20 = prevAdv20 > 0 ? prevAdv20 * 0.9 + dollarVolume * 0.1 : def.baseAdv;

  return {
    date,
    open: round2(open),
    high: round2(Math.max(high, open, close)),
    low: round2(Math.max(0.01, Math.min(low, open, close))),
    close: round2(close),
    volume: Math.round(volume),
    adv20: Math.round(adv20),
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------- 订单执行

export interface ExecutionParams {
  /** 冲击系数 η，见 docs/03 §6.2 */
  eta: number;
  /** 清算所的初始保证金率 */
  marginRate: number;
  /** 佣金率 */
  commissionRate: number;
  /** 因做空禁令等规则而不可做空的标的 */
  shortBanned: Set<string>;
}

export interface ExecutionInput {
  order: Order;
  /** t+1 日的开盘价 */
  openPrice: number;
  /** 20 日平均成交额 */
  adv20: number;
  /** 市场容量乘数 */
  liquidity: number;
  /** 该标的的日波动率（用于平方根冲击律） */
  dailyVol: number;
  /** 当前持仓数量（正=多，负=空） */
  currentQty: number;
  /** 是否允许做空（会被 shortBanned 覆盖） */
  shortable: boolean;
  rng: Rng;
  params: ExecutionParams;
  /** 惩罚性滑点倍数（强平用 2×） */
  slippagePenalty?: number;
  /**
   * 该标的允许的**最大空头总股数**（绝对量，不是剩余额度）。
   * undefined 表示不做券源约束。见 securities-lending.ts。
   */
  maxShortQty?: number;
}

/**
 * 执行一笔订单。
 *
 * 定价基准永远是 **t+1 开盘价**，滑点方向永远对玩家不利。见 docs/02 §4.1。
 */
export function executeOrder(input: ExecutionInput): Fill {
  const { order, openPrice, adv20, liquidity, dailyVol, currentQty, shortable, rng, params } = input;
  const penalty = input.slippagePenalty ?? 1;

  const base: Fill = {
    order,
    filledAt: '',
    price: openPrice,
    quantity: 0,
    impact: 0,
    commission: 0,
    reason: 'ok',
  };

  let requestedQty = Math.max(0, order.quantity);
  let clampedByBorrow = false;

  // ---- 可交易性检查 ----
  const isShorting = order.side === 'sell' && currentQty - requestedQty < 0;
  if (isShorting) {
    if (params.shortBanned.has(order.instrumentId)) {
      return { ...base, reason: 'not_shortable' };
    }
    if (!shortable) {
      return { ...base, reason: 'not_shortable' };
    }
    // 券源约束：只能借到有限的券
    if (input.maxShortQty !== undefined) {
      const currentShort = Math.max(0, -currentQty);
      const headroom = Math.max(0, input.maxShortQty - currentShort);
      if (headroom <= 0) {
        return { ...base, reason: 'not_shortable' };
      }
      if (requestedQty > headroom) {
        requestedQty = Math.floor(headroom);
        clampedByBorrow = true;
      }
    }
  }
  if (order.side === 'buy' && currentQty >= 0 && requestedQty <= 0) {
    return { ...base, reason: 'no_position' };
  }
  if (requestedQty <= 0) {
    return { ...base, reason: 'insufficient_liquidity' };
  }

  // ---- 市场容量与部分成交 ----
  const notional = requestedQty * openPrice;
  const capacity = Math.max(1, adv20 * liquidity);
  const ratio = notional / capacity;

  let fillFraction: number;
  if (ratio < 0.05) fillFraction = 1;
  else if (ratio < 0.25) fillFraction = 1;
  else if (ratio < 1) fillFraction = 0.3 + 0.4 * (1 - ratio);
  else fillFraction = 0.05;

  // 危机中的额外容量约束：流动性越低越难成交
  fillFraction *= Math.min(1, 0.35 + 0.65 * liquidity);

  const filledQty = Math.max(0, Math.floor(requestedQty * fillFraction));
  if (filledQty === 0) {
    return { ...base, reason: 'insufficient_liquidity' };
  }

  // ---- 平方根冲击律 ----
  const effectiveRatio = Math.min(2, (filledQty * openPrice) / capacity);
  const impact = params.eta * dailyVol * Math.sqrt(effectiveRatio) * penalty;
  const sign = order.side === 'buy' ? 1 : -1;
  const price = round2(Math.max(0.01, openPrice * (1 + sign * impact)));

  const commission = Math.abs(filledQty * price) * params.commissionRate;

  return {
    order,
    filledAt: '',
    price,
    quantity: filledQty,
    impact,
    commission,
    reason: clampedByBorrow || fillFraction < 1 ? 'partial' : 'ok',
  };
}

/** 当日标普的收益率中，「由玩家交易造成」的部分——用于 SRS 的市场压力贡献分量。 */
export function playerImpactShare(playerImpactNotional: number, totalMarketCap: number): number {
  if (totalMarketCap <= 0) return 0;
  return clamp(playerImpactNotional / totalMarketCap, 0, 1);
}
