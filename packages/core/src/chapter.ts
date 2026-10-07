import type { GameConfig, TurnReport } from './types.ts';

export const BEGINNER_CHAPTER = {
  title: '危机高峰：守住本金',
  startDate: '2008-09-02',
  endDate: '2008-10-31',
  capitalFloor: 0.7,
  drawdownLimit: 0.3,
} as const;

export function isBeginnerChapter(config: GameConfig): boolean {
  return config.difficulty === 0 && config.startDate === BEGINNER_CHAPTER.startDate && config.endDate === BEGINNER_CHAPTER.endDate;
}

/** 用本局实际记录复盘，不用未来信息评判此前决策。 */
export function reviewRun(config: GameConfig, equity: number, drawdown: number, bankrupt: boolean, reports: readonly TurnReport[]) {
  const commissions = reports.reduce((sum, r) => sum + r.commission, 0);
  const borrowFees = reports.reduce((sum, r) => sum + r.borrowFees, 0);
  const riskCloses = reports.filter(r => r.fills.some(f => f.reason === 'risk_close')).length;
  const worstDay = reports.reduce<TurnReport | undefined>((worst, r) =>
    !worst || r.equityAfter - r.equityBefore < worst.equityAfter - worst.equityBefore ? r : worst, undefined);
  return {
    survived: !bankrupt,
    capitalPreserved: equity + 1e-6 >= config.initialCapital * BEGINNER_CHAPTER.capitalFloor,
    drawdownControlled: drawdown <= BEGINNER_CHAPTER.drawdownLimit + 1e-10,
    noForcedClose: riskCloses === 0,
    commissions, borrowFees, riskCloses, worstDay,
  };
}
