import type { FundState, GameConfig, TurnReport } from './types.ts';

export const BEGINNER_CHAPTER = {
  title: '危机高峰：守住本金',
  startDate: '2008-09-02',
  endDate: '2008-10-31',
  capitalFloor: 0.7,
  drawdownLimit: 0.3,
} as const;

export const BEGINNER_PERIODS = [
  { id: 'warning', title: '危机初现：留出余地', startDate: '2007-07-02', endDate: '2007-08-31',
    capitalFloor: 0.85, drawdownLimit: 0.2,
    briefing: '房贷风险开始进入新闻。练习分批建仓，观察个股与大盘的差别。' },
  { id: 'crisis', ...BEGINNER_CHAPTER,
    briefing: '金融机构接连承压。练习控制仓位，并留出应对下一次变化的现金。' },
  { id: 'policy', title: '政策转折：重新评估方向', startDate: '2009-03-02', endDate: '2009-04-30',
    capitalFloor: 0.8, drawdownLimit: 0.25,
    briefing: '政策与机构经营消息不断变化。练习重新审视多空方向，避免把过去走势当作承诺。' },
] as const;

export function beginnerPeriod(config: GameConfig) {
  return config.difficulty === 0 ? BEGINNER_PERIODS.find(p => p.startDate === config.startDate && p.endDate === config.endDate) : undefined;
}

export function isBeginnerChapter(config: GameConfig): boolean {
  return beginnerPeriod(config) !== undefined;
}

/** 用本局实际记录复盘，不用未来信息评判此前决策。 */
export function reviewRun(config: GameConfig, equity: number, drawdown: number, bankrupt: boolean, reports: readonly TurnReport[], obligations?: Pick<FundState, 'defaulted'>) {
  const period = beginnerPeriod(config) ?? BEGINNER_CHAPTER;
  const distributedCapital = reports.reduce((sum, r) => sum + (r.capitalOutflow ?? 0), 0);
  const commissions = reports.reduce((sum, r) => sum + r.commission, 0);
  const borrowFees = reports.reduce((sum, r) => sum + r.borrowFees, 0);
  const loanInterest = reports.reduce((sum, r) => sum + (r.loanInterest ?? 0), 0);
  const riskCloses = reports.filter(r => r.fills.some(f => f.reason === 'risk_close')).length;
  const worstDay = reports.reduce<TurnReport | undefined>((worst, r) =>
    !worst || r.equityAfter - r.equityBefore + (r.capitalOutflow ?? 0) < worst.equityAfter - worst.equityBefore + (worst.capitalOutflow ?? 0) ? r : worst, undefined);
  return {
    survived: !bankrupt && !obligations?.defaulted,
    capitalPreserved: equity + distributedCapital + 1e-6 >= config.initialCapital * period.capitalFloor,
    drawdownControlled: drawdown <= period.drawdownLimit + 1e-10,
    noForcedClose: riskCloses === 0,
    commissions, borrowFees, loanInterest, riskCloses, worstDay, distributedCapital,
  };
}
