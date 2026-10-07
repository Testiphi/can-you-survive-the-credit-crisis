import { DEMO_CHAPTERS, beginnerPeriod, reviewRun, type GameEngine } from '@cyscc/core';

export type DemoProgress = Record<string, { passed: boolean; date: string }>;
const KEY = 'cyscc-demo-progress';
export function readDemoProgress(): DemoProgress {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const out: DemoProgress = {};
    for (const p of DEMO_CHAPTERS) for (const role of ['retail', 'hedge_fund', 'bank', 'insurer']) {
      const key = `${p.id}:${role}`, value = raw?.[key];
      if (typeof value?.passed === 'boolean' && typeof value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.date)) out[key] = value;
    }
    return out;
  } catch { return {}; }
}

export function recordDemoProgress(engine: GameEngine): DemoProgress {
  const progress = readDemoProgress(), period = beginnerPeriod(engine.config);
  if (!period || !engine.isOver || engine.config.demoVersion !== 1) return progress;
  const p = engine.state.player;
  const review = reviewRun(engine.config, p.equity, p.maxDrawdown, p.bankrupt, engine.turnReports,
    engine.state.fund ?? engine.state.bank ?? engine.state.insurer);
  const key = `${period.id}:${engine.config.identity}`;
  if (!progress[key]?.passed) progress[key] = {
    passed: engine.state.date >= engine.config.endDate && review.survived && review.capitalPreserved,
    date: engine.state.date,
  };
  localStorage.setItem(KEY, JSON.stringify(progress));
  return progress;
}
