import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../src/engine.ts';
import { loadDataset } from '../src/load-node.ts';
import { beginnerPeriodConfig, BEGINNER_PERIODS } from '../src/chapter.ts';
import { nextTradingDay, isTradingDay, shiftTradingDays } from '../src/time.ts';
import { nextFundingDecision } from '../src/deadlines.ts';
import { refinanceQuote } from '../src/refinance.ts';
const data = loadDataset();
const pack = data.periodPacks!['2010-q2-v1'];
const config = { difficulty: 0 as const, ...beginnerPeriodConfig(BEGINNER_PERIODS.find(p => p.id === 'europe')!) };

test('Q2 replays all six daily OHLC series and observed macro; news never leaks or duplicates', () => {
  const engine = new GameEngine(data, { config });
  const fired: string[] = [];
  assert.ok(engine.state.firedEvents.includes('qe1_purchase_completed'));
  assert.deepEqual(engine.state.news.map(n => n.eventId), ['qe1_purchase_completed']);
  for (let i = 0; i < 63; i++) {
    const date = pack.macro[i].date;
    assert.equal(engine.state.date, date);
    assert.equal(engine.state.macro.vix, pack.macro[i].vix);
    assert.equal(engine.state.macro.tedSpread, pack.macro[i].tedSpread);
    for (const id of Object.keys(pack.market.series)) {
      const expected = pack.market.series[id][i];
      const bar = engine.state.bars.get(id)!.at(-1)!;
      for (const key of ['open', 'high', 'low', 'close', 'volume'] as const) assert.equal(bar[key], expected[key], `${id}/${date}/${key}`);
      assert.equal(bar.provenance, 'historical');
    }
    assert.ok(engine.state.news.every(n => n.date <= date));
    for (const event of pack.events.filter(e => e.date > config.startDate!)) {
      assert.equal(engine.state.firedEvents.includes(event.id), event.date <= date, `${date}/${event.id}`);
    }
    if (!engine.isOver) fired.push(...engine.advance().firedEventIds);
  }
  assert.equal(engine.state.turnIndex, 62);
  assert.equal(fired.length, 11);
  assert.equal(new Set(fired).size, 11);
  assert.ok(!engine.state.prices.has('LEH'));
});

test('Q2 rejects missing quotes/macros, future macro observations, unknown packs and unsupported dates', () => {
  for (const mutate of [
    d => d.periodPacks!['2010-q2-v1'].market.series.C.splice(5, 1),
    d => d.periodPacks!['2010-q2-v1'].macro.splice(5, 1),
    d => d.periodPacks!['2010-q2-v1'].macro[1].tedAsOf = '2010-04-06',
    d => d.periodPacks!['2010-q2-v1'].market.series.GS[3].high = 0,
    d => delete d.periodPacks,
  ] as Array<(d: typeof data) => unknown>) {
    const bad = structuredClone(data); mutate(bad);
    assert.throws(() => new GameEngine(bad, { config }), /时期/);
  }
  assert.throws(() => new GameEngine(data, { config: { ...config, periodPack: undefined } }), /数据包/);
  assert.throws(() => new GameEngine(data, { config: { ...config, endDate: '2010-07-01' } }), /范围/);
  assert.throws(() => new GameEngine(data, { config: { ...config, difficulty: 1 } }), /D0/);
  assert.throws(() => new GameEngine(data, { config: { ...config, calendar: undefined } }), /日历/);
  const e = new GameEngine(data, { config });
  assert.throws(() => e.submitOrder({ instrumentId: 'LEH', quantity: 1, side: 'buy', kind: 'market', submittedAt: e.state.date }), /行情/);
  assert.throws(() => GameEngine.restore(data, { ...e.save(), config: { ...e.config, periodPack: 'unknown' } }), /版本/);
});

test('versioned pack does not change old fingerprints; pack edits invalidate only its own saves', () => {
  const legacy = new GameEngine(data, { config: { difficulty: 0, demoVersion: 1, marketRevision: 1 } }).save();
  const current = new GameEngine(data, { config }).save();
  const edited = structuredClone(data);
  edited.periodPacks!['2010-q2-v1'].macro[20].vix += 1;
  assert.equal(GameEngine.restore(edited, legacy).save().stateHash, legacy.stateHash);
  assert.throws(() => GameEngine.restore(edited, current), /数据已变化/);
  delete edited.periodPacks;
  assert.equal(GameEngine.restore(edited, legacy).save().stateHash, legacy.stateHash);
});

test('holiday pending orders replay at next real open; changing future bars does not alter earlier state', () => {
  const a = new GameEngine(data, { config });
  a.submitByNotional('C', 20000);
  const b = GameEngine.restore(data, JSON.parse(JSON.stringify(a.save())));
  const result = a.advance();
  assert.deepEqual(b.advance(), result);
  assert.equal(result.date, '2010-04-05');
  assert.equal(result.fills[0].price, pack.market.series.C[1].open);
  const edited = structuredClone(data);
  const bar = edited.periodPacks!['2010-q2-v1'].market.series.C.at(-1)!;
  bar.high *= 2; bar.close *= 2;
  const future = new GameEngine(edited, { config });
  future.submitByNotional('C', 20000); future.advance();
  assert.deepEqual(future.state, a.state);
});

test('role deadlines, previews and refinancing count 2010 trading days consistently', () => {
  for (const identity of ['bank', 'hedge_fund', 'insurer'] as const) {
    const e = new GameEngine(data, { config: { ...config, identity } });
    const decision = nextFundingDecision(e.state)!;
    assert.equal(decision.date, shiftTradingDays(e.state.date, decision.days, 'nyse-2010'));
    assert.ok(isTradingDay(decision.date, 'nyse-2010'));
    if (identity === 'insurer') assert.equal(e.state.insurer!.purchaseDeadline, '2010-04-09');
  }
  const bank = new GameEngine(data, { config: { ...config, identity: 'bank', startDate: '2010-05-03' } });
  for (const pos of bank.state.player.positions.values()) bank.submitByNotional(pos.instrumentId, -pos.quantity * bank.state.prices.get(pos.instrumentId)!);
  while (bank.state.date < '2010-05-17') bank.advance();
  const loan = bank.state.player.loans![0];
  const execution = nextTradingDay(bank.state.date, 'nyse-2010');
  const quote = refinanceQuote(bank.state.player, bank.state.prices, bank.state.macro.systemicStress, execution, bank.config.endDate, loan, 'term', 'nyse-2010');
  assert.equal(quote.dueDate, '2010-06-16');
  bank.requestBankRefinance({ loanId: loan.id, plan: 'term' });
  const restored = GameEngine.restore(data, JSON.parse(JSON.stringify(bank.save())));
  assert.deepEqual(restored.advance(), bank.advance());
  assert.equal(loan.dueDate, quote.dueDate);
});
