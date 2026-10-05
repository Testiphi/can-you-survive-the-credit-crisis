/**
 * 标的定义与定价。
 *
 * P0 阶段：个股由「对标普的 beta + 特质波动」生成，起点价格为设计校准值。
 * 个股的崩塌不来自硬编码日期，而来自事件卡的 equityReturn 冲击——
 * 这在设计上是正确的：**价格响应事件，而不是响应日历。**
 * 见 docs/06 §6「随机的是何时与多深，不是是否与方向」。
 */

import type { DateStr, ImpactVector } from './types.ts';

export type Sector = 'index' | 'financials' | 'housing' | 'autos' | 'muni' | 'energy';

export interface InstrumentDef {
  id: string;
  name: string;
  sector: Sector;
  /** 对标普 500 的敏感度 */
  beta: number;
  /** 特质日波动率（年化约 idioVol * sqrt(252)） */
  idioVol: number;
  /** 2007-01-03 的起始价格（设计校准值） */
  startPrice: number;
  /** 流通股数（用于玩家空头集中度 → SRS 计算） */
  sharesOutstanding: number;
  /** 20 日平均成交额基数（美元），随流动性状态缩放 */
  baseAdv: number;
  /** 是否可做空（会被做空禁令动态覆盖） */
  shortable: boolean;
}

export const INSTRUMENTS: InstrumentDef[] = [
  {
    id: 'SPX',
    name: '标普 500 指数',
    sector: 'index',
    beta: 1,
    idioVol: 0,
    startPrice: 1416.6,
    sharesOutstanding: 0,
    baseAdv: 5e10,
    shortable: true,
  },
  {
    id: 'LEH',
    name: '雷曼兄弟',
    sector: 'financials',
    beta: 2.2,
    idioVol: 0.028,
    startPrice: 78.0,
    sharesOutstanding: 6.8e8,
    baseAdv: 2.0e9,
    shortable: true,
  },
  {
    id: 'BSC',
    name: '贝尔斯登',
    sector: 'financials',
    beta: 2.0,
    idioVol: 0.026,
    startPrice: 160.0,
    sharesOutstanding: 1.3e8,
    baseAdv: 1.2e9,
    shortable: true,
  },
  {
    id: 'MER',
    name: '美林证券',
    sector: 'financials',
    beta: 1.8,
    idioVol: 0.022,
    startPrice: 93.0,
    sharesOutstanding: 1.5e9,
    baseAdv: 2.2e9,
    shortable: true,
  },
  {
    id: 'GS',
    name: '高盛',
    sector: 'financials',
    beta: 1.3,
    idioVol: 0.019,
    startPrice: 200.0,
    sharesOutstanding: 4.3e8,
    baseAdv: 3.0e9,
    shortable: true,
  },
  {
    id: 'MS',
    name: '摩根士丹利',
    sector: 'financials',
    beta: 1.9,
    idioVol: 0.024,
    startPrice: 80.0,
    sharesOutstanding: 1.1e9,
    baseAdv: 1.8e9,
    shortable: true,
  },
  {
    id: 'AIG',
    name: '美国国际集团',
    sector: 'financials',
    beta: 1.6,
    idioVol: 0.025,
    startPrice: 70.0,
    sharesOutstanding: 2.6e9,
    baseAdv: 2.5e9,
    shortable: true,
  },
  {
    id: 'C',
    name: '花旗集团',
    sector: 'financials',
    beta: 1.7,
    idioVol: 0.021,
    startPrice: 55.0,
    sharesOutstanding: 5.0e9,
    baseAdv: 3.5e9,
    shortable: true,
  },
  {
    id: 'JPM',
    name: '摩根大通',
    sector: 'financials',
    beta: 1.2,
    idioVol: 0.016,
    startPrice: 48.0,
    sharesOutstanding: 3.5e9,
    baseAdv: 2.8e9,
    shortable: true,
  },
  {
    id: 'WM',
    name: '华盛顿互惠银行',
    sector: 'financials',
    beta: 1.8,
    idioVol: 0.026,
    startPrice: 45.0,
    sharesOutstanding: 1.0e9,
    baseAdv: 1.0e9,
    shortable: true,
  },
  {
    id: 'FNM',
    name: '房利美',
    sector: 'housing',
    beta: 1.6,
    idioVol: 0.024,
    startPrice: 58.0,
    sharesOutstanding: 1.0e9,
    baseAdv: 1.4e9,
    shortable: true,
  },
  {
    id: 'FRE',
    name: '房地美',
    sector: 'housing',
    beta: 1.7,
    idioVol: 0.025,
    startPrice: 65.0,
    sharesOutstanding: 6.5e8,
    baseAdv: 1.1e9,
    shortable: true,
  },
];

export const INSTRUMENT_BY_ID = new Map(INSTRUMENTS.map((i) => [i.id, i]));

/** 行业分组别名，事件卡的 targets 里会用到。 */
const SECTOR_TARGETS: Record<string, Sector> = {
  financials: 'financials',
  housing: 'housing',
  autos: 'autos',
  muni: 'muni',
  energy: 'energy',
};

export interface ImpactResolution {
  /** 标普的即期收益冲击 */
  index: number;
  /** 逐标的的即期收益冲击 */
  perInstrument: Map<string, number>;
}

/**
 * 行业传染的衰减系数。
 *
 * 这是本作数值模型里最重要的一个修正。
 *
 * `equityReturn` 语义上表示「**被点名的那家机构**的即期冲击」。
 * 事件卡的 targets 经常形如 `["LEH", "SPX", "financials"]`——
 * 如果行业名也吃满 `equityReturn`，`lehman_collapse` 的 −94% 就会把
 * 高盛、摩根大通、花旗在同一天全部打掉 94%，几十个事件叠加之后
 * 整个金融板块会在 2007 年年中就归零（实测：GS 跌到 $0.01），
 * 而历史上高盛从峰值到谷底只跌了约 70%，且活了下来。
 *
 * 行业整体的下跌应该主要由市场因子（beta）承担，事件卡只贡献一个
 * 很小的传染分量。
 *
 * 实测归因：关闭全部事件时高盛期末中位数 $149（实际约 $168），
 * 说明 beta 单独已经把板块跌幅交付得差不多；事件只需要负责
 * **被点名机构的特质崩塌**（雷曼归零、花旗被稀释、AIG 被接管）。
 * 系数调到 0.05 时幸存者会被系统性多杀一倍。
 */
export const SECTOR_CONTAGION_DAMPING = 0.01;

/**
 * 把一个 ImpactVector 解析成逐标的的价格冲击。
 *
 * 规则：
 *  - targets 含 'SPX'            → 应用 indexReturn
 *  - targets 含具体代码           → 该标的应用 **全额** equityReturn
 *  - targets 含行业名（financials 等）→ 该行业全部标的应用 equityReturn × 衰减系数
 *  - targets 为空                 → 只影响 SPX（indexReturn）
 */
export function resolveImpact(impact: ImpactVector): ImpactResolution {
  const perInstrument = new Map<string, number>();
  const index = impact.indexReturn ?? 0;
  const equity = impact.equityReturn ?? 0;
  const targets = impact.targets ?? [];

  if (targets.length === 0) {
    return { index, perInstrument };
  }

  const named = new Set(targets.filter((t) => INSTRUMENT_BY_ID.has(t) && t !== 'SPX'));

  for (const target of targets) {
    if (target === 'SPX') continue; // 由 index 处理

    const sector = SECTOR_TARGETS[target];
    if (sector) {
      const contagion = equity * SECTOR_CONTAGION_DAMPING;
      for (const inst of INSTRUMENTS) {
        if (inst.sector !== sector) continue;
        // 已被点名的标的吃全额，不重复叠加传染分量
        if (named.has(inst.id)) continue;
        perInstrument.set(inst.id, (perInstrument.get(inst.id) ?? 0) + contagion);
      }
      continue;
    }
    if (INSTRUMENT_BY_ID.has(target)) {
      perInstrument.set(target, (perInstrument.get(target) ?? 0) + equity);
    }
  }

  return { index, perInstrument };
}

// ---------------------------------------------------------------- 期权定价

/** 标准正态累积分布（Abramowitz–Stegun 7.1.26 近似，精度约 1e-7）。 */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/**
 * Black-Scholes 欧式期权定价。**绝不用蒙特卡洛**，见 docs/03 §3.1。
 * T 以年为单位。T <= 0 时返回内在价值。
 */
export function blackScholes(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  type: 'call' | 'put',
): number {
  if (T <= 0 || sigma <= 1e-6) {
    return type === 'call' ? Math.max(S - K, 0) : Math.max(K - S, 0);
  }
  const s = Math.max(sigma, 1e-4);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (s * s) / 2) * T) / (s * sqrtT);
  const d2 = d1 - s * sqrtT;
  if (type === 'call') {
    return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  }
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

/**
 * 参数化隐含波动率曲面。必须与 VIX 严格联动，否则玩家会套利套到游戏结束。
 * 见 docs/03 §3.2。
 */
export function impliedVol(
  S: number,
  K: number,
  T: number,
  vix: number,
  stress: number,
): number {
  const atm = Math.max(0.08, (vix / 100) * 0.95);
  // 对数货币度
  const k = T > 0 ? Math.log(K / S) / (atm * Math.sqrt(T)) : 0;
  // 危机时偏斜更陡、尾部更肥
  const a = 0.15 + 0.3 * stress;
  const b = 0.05 + 0.2 * stress;
  const skew = Math.max(0.25, 1 + a * k + b * k * k);
  // 期限结构：危机时倒挂（近月 > 远月）
  const term = stress > 0.5 ? 1 + 0.35 * stress * Math.max(0, 0.5 - T) : 1;
  return atm * skew * term;
}

/** 期权的到期年限。P0 只保留 3 个到期日（1/3/6 个月），见 docs/03 §3.3。 */
export const OPTION_TENORS_MONTHS = [1, 3, 6] as const;

/** 相对平值的行权价档位，5 档。 */
export const OPTION_MONEYNESS = [0.8, 0.9, 1.0, 1.1, 1.2] as const;

export interface OptionQuote {
  id: string;
  underlying: string;
  type: 'call' | 'put';
  strike: number;
  expiryMonths: number;
  /** 年化隐含波动率 */
  iv: number;
  price: number;
}

/** 生成一个标的的期权链（15 个合约），见 docs/03 §3.3。 */
export function buildOptionChain(
  def: InstrumentDef,
  spot: number,
  vix: number,
  stress: number,
  r = 0.02,
): OptionQuote[] {
  const out: OptionQuote[] = [];
  for (const months of OPTION_TENORS_MONTHS) {
    const T = months / 12;
    for (const m of OPTION_MONEYNESS) {
      const strike = Math.round(spot * m * 2) / 2;
      for (const type of ['call', 'put'] as const) {
        const iv = impliedVol(spot, strike, T, vix, stress);
        // 避免出现低于最小报价单位的价格
        const raw = blackScholes(spot, strike, T, r, iv, type);
        const price = Math.max(0.01, Math.round(raw * 100) / 100);
        out.push({
          id: `${def.id}-${months}M-${type === 'call' ? 'C' : 'P'}-${strike}`,
          underlying: def.id,
          type,
          strike,
          expiryMonths: months,
          iv,
          price,
        });
      }
    }
  }
  return out;
}

/** 标普的合约乘数（用于指数期货）。 */
export const SPX_MULTIPLIER = 250;

/** 交割日期的近似计算（保留给期货移仓）。 */
export function approxExpiry(date: DateStr, months: number): DateStr {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) + months;
  const yy = y + Math.floor((m - 1) / 12);
  const mm = ((m - 1) % 12) + 1;
  return `${yy}-${String(mm).padStart(2, '0')}-01`;
}
