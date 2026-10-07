/**
 * 全局类型定义。
 *
 * 约定：
 *  - 金额一律用浮点 number（美元）。合约乘数与期权定价会让「整数分」的换算变成负担。
 *  - 所有随机行为必须经过 Rng，禁止 Math.random()。
 *  - 本文件只放类型，运行时逻辑在各自模块中。
 */

export type DateStr = string; // 'YYYY-MM-DD'
export type Money = number;
export type Ratio = number;

// ---------------------------------------------------------------- 配置

export type Difficulty = 0 | 1 | 2 | 3;
export type Identity = 'retail' | 'hedge_fund' | 'bank' | 'insurer';
export type TimelineMode = 'historical' | 'jittered' | 'parallel';

export interface GameConfig {
  seed: number;
  difficulty: Difficulty;
  identity: Identity;
  initialCapital: Money;
  /** 铁人模式：单一存档、不可回退。关闭后成绩不计入。默认 true。 */
  ironman: boolean;
  timeline: TimelineMode;
  startDate: DateStr;
  endDate: DateStr;
}

export const DEFAULT_CONFIG: GameConfig = {
  seed: 42,
  difficulty: 1,
  identity: 'retail',
  initialCapital: 100_000,
  ironman: true,
  timeline: 'jittered',
  startDate: '2007-01-02',
  endDate: '2009-12-31',
};

/** 各身份的资金与约束，见 docs/01 §5 */
export const IDENTITY_PROFILE: Record<
  Identity,
  { capital: Money; minDifficulty: Difficulty; canSellProtection: boolean; hasRedemptions: boolean }
> = {
  retail: { capital: 100_000, minDifficulty: 0, canSellProtection: false, hasRedemptions: false },
  hedge_fund: { capital: 10_000_000, minDifficulty: 1, canSellProtection: false, hasRedemptions: true },
  bank: { capital: 1_000_000_000, minDifficulty: 2, canSellProtection: false, hasRedemptions: false },
  insurer: { capital: 10_000_000_000, minDifficulty: 3, canSellProtection: true, hasRedemptions: false },
};

// ---------------------------------------------------------------- 事件卡

export type EventTier =
  | 'macro'
  | 'policy'
  | 'funding'
  | 'investment_bank'
  | 'commercial_bank'
  | 'insurer'
  | 'gse'
  | 'overseas';

export type EventTrigger =
  | { type: 'scheduled'; probabilityPerDay: number; modeOnly?: TimelineMode }
  | {
      type: 'competing_risk';
      institution: string;
      baseHazard: number;
      canonicalFirstDomino?: boolean;
      jitterDays?: number;
      note?: string;
    }
  | { type: 'state'; predicate: string; probabilityPerDay?: number };

export interface ImpactVector {
  targets?: string[];
  equityReturn?: number;
  indexReturn?: number;
  volMultiplier?: number;
  creditSpreadDelta?: number;
  liquidityMultiplier?: number;
  decayDays: number;
  // 融资维度，见 docs/07
  repoHaircutDelta?: number;
  rolloverRateDelta?: number;
  borrowFeeMultiplier?: number;
  shortableRestriction?: boolean;
  marginRequirementMultiplier?: number;
}

export interface EventCard {
  id: string;
  phase: 0 | 1 | 2 | 3 | 4 | 5;
  date: DateStr;
  title: string;
  headline: string;
  narrative: string;
  window: [DateStr, DateStr];
  requires: string[];
  requireAnyOf: string[][];
  trigger: EventTrigger;
  tier: EventTier;
  reversible: boolean;
  isSystemicEvent: boolean;
  impact: ImpactVector;
  affectsFragility?: Record<string, number>;
  /**
   * 本卡导致这些机构「事实上死亡」（破产 / 被接管 / 股东权益归零）。
   * 不能从 impact.targets 推断——例如 indymac_failure 的 targets 含 WM/WB，
   * 但那两家是后来才倒的。
   */
  terminalFailure?: string[];
  imposesRule?: { kind: RuleKind; scope: string[]; durationDays: number };
  exclusiveWith?: string[];
  isTrap?: boolean;
  trapNote?: string;
  isBottom?: boolean;
  isReversal?: boolean;
  isScorecard?: boolean;
  structural?: boolean;
  newsVisibility: 0 | 1 | 2 | 3;
  unlocks?: string[];
  sources?: string[];
}

// ---------------------------------------------------------------- 机构

export interface Institution {
  id: string;
  name: string;
  fullName?: string;
  tier: EventTier;
  leverage: number;
  repoDependence: number;
  assetImpairment: number;
  confidence0: number;
  counterpartyExposure: number;
  capitalBuffer: number;
  fragility0: number;
  failureMode: string;
  historicalOutcome?: string;
  historicalDate?: DateStr | null;
  notes?: string;
}

export interface InstitutionState {
  id: string;
  fragility: number;
  confidence: number;
  alive: boolean;
  failedOn?: DateStr;
  failureMode?: string;
}

export interface FragilityWeights {
  leverage: number;
  repoDependence: number;
  assetImpairment: number;
  confidenceDeficit: number;
  counterpartyExposure: number;
  capitalBuffer: number;
}

export interface HazardModel {
  baseHazard: number;
  kappa: number;
}

export interface InstitutionsFile {
  version: number;
  weights: FragilityWeights;
  hazardModel: HazardModel;
  institutions: Institution[];
}

// ---------------------------------------------------------------- 市场

export interface Bar {
  /** D0 行情来源；estimated 表示数据集回填或无成交量的简化日线。 */
  provenance?: 'historical' | 'estimated' | 'carried' | 'synthetic';
  date: DateStr;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adv20: number;
}

/** 全局宏观状态。每一回合更新一次。 */
export interface MacroState {
  date: DateStr;
  spx: number;
  vix: number;
  /** 信用利差，bp。锚定 FRED BAMLH0A0HYM2 */
  creditSpread: number;
  /** TED 利差，百分点 */
  tedSpread: number;
  /** 市场容量乘数 L(t) ∈ [0.05, 1] */
  liquidity: number;
  /** 加权回购折扣率 */
  repoHaircut: number;
  /** 系统性压力 0..1 */
  systemicStress: number;
}

/** 正在衰减中的事件冲击 */
export interface ActiveEffect {
  eventId: string;
  appliedOn: DateStr;
  impact: ImpactVector;
  remaining: number;
  total: number;
}

// ---------------------------------------------------------------- 账户

export interface Position {
  instrumentId: string;
  /** 正=多，负=空 */
  quantity: number;
  avgPrice: number;
  openedAt: DateStr;
  /** 做空的借券费（年化） */
  borrowFeeRate: number;
}

export interface Account {
  cash: Money;
  positions: Map<string, Position>;
  equity: Money;
  /** 融资容量（D2+） */
  repoCapacity: Money;
  repoUsed: Money;
  repoRolloverRate: number;
  marginRequirement: Money;
  maintenanceMargin: Money;
  marginCall: boolean;
  marginCallSince?: DateStr;
  peakEquity: Money;
  maxDrawdown: Ratio;
  bankrupt: boolean;
}

// ---------------------------------------------------------------- 订单与成交

export type OrderSide = 'buy' | 'sell';
export type OrderKind = 'market' | 'limit';
export type FillReason =
  | 'missing_quote'
  | 'risk_close'
  | 'insufficient_funds'
  | 'ok'
  | 'partial'
  | 'insufficient_liquidity'
  | 'not_shortable'
  | 'margin_rejected'
  | 'no_position'
  | 'halted';

export interface Order {
  instrumentId: string;
  side: OrderSide;
  quantity: number;
  kind: OrderKind;
  limitPrice?: number;
  submittedAt: DateStr;
}

export interface Fill {
  order: Order;
  filledAt: DateStr;
  price: number;
  quantity: number;
  /** 本次成交造成的价格冲击（比例） */
  impact: number;
  commission: number;
  reason: FillReason;
}

// ---------------------------------------------------------------- 监管

export type RuleKind = 'short_ban' | 'margin_hike' | 'disclosure' | 'circuit_breaker' | 'bailout';

export interface ActiveRule {
  id: string;
  kind: RuleKind;
  scope: string[];
  effectiveFrom: DateStr;
  effectiveTo: DateStr;
  sourceEventId?: string;
}

/** 监管阶梯 L0–L5，见 docs/03 §8 */
export type RegulatorLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface RegulatorState {
  /** 系统性风险分 0..1+ */
  srs: number;
  level: RegulatorLevel;
  rules: ActiveRule[];
  /** 玩家空头占流通股的最高比例 */
  shortConcentration: number;
  /** 玩家交易贡献的市场跌幅占比 */
  priceImpactShare: number;
}

// ---------------------------------------------------------------- 新闻

export interface NewsItem {
  id: string;
  date: DateStr;
  headline: string;
  body: string;
  source: 'historical' | 'generated' | 'system';
  credibility: number;
  isTrue: boolean;
  eventId?: string;
}

// ---------------------------------------------------------------- NPC

export type AgentType = 'retail' | 'conservative_fund' | 'hedge_fund' | 'bank' | 'market_maker';

export interface NPCAgent {
  id: string;
  type: AgentType;
  equity: Money;
  leverage: number;
  positions: Map<string, Position>;
  params: {
    riskAppetite: number;
    trendSensitivity: number;
    redemptionPressure: number;
    informationLead: number;
  };
}

// ---------------------------------------------------------------- 状态与结果

export interface PlayerAction {
  turnIndex: number;
  date: DateStr;
  orders: Order[];
}

export interface ScoreSnapshot {
  date: DateStr;
  equity: Money;
  drawdown: Ratio;
}

export interface GameState {
  config: GameConfig;
  date: DateStr;
  turnIndex: number;
  /** 已生成的全部历史 K 线，含「未来」。UI 必须经 visibleBars() 裁剪。 */
  bars: Map<string, Bar[]>;
  /** 当前（最新）收盘价 */
  prices: Map<string, number>;
  macro: MacroState;
  player: Account;
  agents: NPCAgent[];
  regulator: RegulatorState;
  institutions: Record<string, InstitutionState>;
  firedEvents: string[];
  activeEffects: ActiveEffect[];
  news: NewsItem[];
  score: ScoreSnapshot[];
  pendingOrders: Order[];
  haltTrading: boolean;
}

export interface TurnResult {
  date: DateStr;
  turnIndex: number;
  fills: Fill[];
  firedEventIds: string[];
  news: NewsItem[];
  equity: Money;
  marginCall: boolean;
  bankrupt: boolean;
}

// ---------------------------------------------------------------- 真实历史数据

/** 数据管道产出的一根日线。 */
export interface MarketBar {
  date: DateStr;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 该根由管道回填（数据源存在缺口），不是原始数据 */
  filled?: boolean;
}

/**
 * `data/processed/market.json` 的结构。
 *
 * 由 `data/pipeline/build_market.py` 生成。覆盖范围取决于数据源：
 * 能取到真实历史的（存续机构与指数）走真实路径，
 * 取不到的（退市机构）留在 synthetic 里走事件驱动的合成路径。
 */
export interface MarketData {
  version: number;
  source: string;
  sourceNote?: string;
  range: [DateStr, DateStr];
  fetchedAt?: string;
  gapFillNote?: string;
  series: Record<string, MarketBar[]>;
  synthetic: Record<string, string>;
}
