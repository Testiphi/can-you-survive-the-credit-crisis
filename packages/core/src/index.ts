/**
 * @cyscc/core —— 零依赖的模拟引擎。
 *
 * 对外只暴露这个入口。UI 层（apps/web）通过它访问引擎，不允许绕过。
 */

export * from './types.ts';
export { Rng, createStreams, type Streams, type RngStream } from './rng.ts';
export {
  parseDate,
  formatDate,
  addDays,
  dayOfWeek,
  isTradingDay,
  nextTradingDay,
  prevTradingDay,
  tradingDaysBetween,
  shiftTradingDays,
  tradingDayDiff,
} from './time.ts';
export {
  evaluateCondition,
  isPredicate,
  makeContext,
  type ConditionContext,
} from './conditions.ts';
export {
  SPX_ANCHORS,
  CREDIT_SPREAD_ANCHORS,
  VIX_ANCHORS,
  TED_ANCHORS,
  systemicStress,
  haircutFromStress,
  marketRolloverRate,
  buildMacroSeries,
  DIFFICULTY_PROFILE,
} from './economy.ts';
export {
  INSTRUMENTS,
  INSTRUMENT_BY_ID,
  resolveImpact,
  blackScholes,
  impliedVol,
  buildOptionChain,
  normCdf,
  SPX_MULTIPLIER,
  OPTION_TENORS_MONTHS,
  OPTION_MONEYNESS,
  type InstrumentDef,
  type OptionQuote,
  type Sector,
} from './instruments.ts';
export {
  initInstitutionStates,
  computeFragility,
  fragilityStats,
  failureHazard,
  raceForFailure,
  applyFragilityDelta,
  updateConfidence,
  markFailed,
} from './institutions.ts';
export { ScenarioEngine, type ScenarioOptions, type FireDecision } from './scenario.ts';
export { generateBar, executeOrder, type ExecutionParams } from './market.ts';
export {
  createAccount,
  applyFill,
  markToMarket,
  computeMaintenanceMargin,
  checkMargin,
  planLiquidation,
  accrueBorrowFees,
  grossExposure,
  grossLongValue,
  netExposure,
  leverage,
  positionList,
  positionQty,
  floatShares,
  DEFAULT_MARGIN_RATE,
  SHORT_MARGIN_RATE,
  type MarginStatus,
  type LiquidationInstruction,
} from './portfolio.ts';
export {
  computeRepoState,
  playerRolloverRate,
  repoEnabled,
  forcedSaleNotional,
  type RepoState,
  type RepoParams,
} from './repo.ts';
export {
  createRegulatorState,
  computeSrs,
  levelFromSrs,
  addRule,
  expireRules,
  bannedShortScope,
  derivedMarginMultiplier,
  footprintPanel,
  LEVEL_LABEL,
  SRS_WEIGHTS,
  DISCLOSURE_THRESHOLD,
  type FootprintPanel,
  type SrsResult,
} from './regulator.ts';
export {
  generateRumors,
  newsFromEvent,
  type RumorsFile,
  type RumorTemplate,
  type GeneratedRumor,
  type RumorContext,
} from './news.ts';
export {
  createAgents,
  stepAgents,
  flowToReturn,
  totalAgentEquity,
  type AgentStepResult,
} from './agents.ts';
export {
  GameEngine,
  timelineOf,
  type Dataset,
  type EngineOptions,
} from './engine.ts';
