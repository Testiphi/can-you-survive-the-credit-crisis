import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../src/engine.ts';
import { loadDataset } from '../src/load-node.ts';
import { nextTradingDay, isTradingDay } from '../src/time.ts';
import { RealPriceSource } from '../src/market-data.ts';

const data = loadDataset();
test('D0 replays supplied OHLC without repeated event shocks, for every day and seed', () => {
  for (const seed of [1, 999]) {
    const e = new GameEngine(data, { config: { difficulty: 0, timeline: 'parallel', seed }, jitterDays: 30 });
    assert.equal(e.config.timeline, 'historical');
    while (!e.isOver) {
      e.advance();
      for (const id of ['SPX', 'C']) {
        const expected = data.market!.series[id].find(b => b.date === e.state.date);
        if (!expected) continue;
        const actual = e.visibleBars(id).at(-1)!;
        for (const field of ['open', 'high', 'low', 'close', 'volume'] as const) assert.equal(actual[field], expected[field], `${seed}/${id}/${e.state.date}/${field}`);
      }
    }
    for (const n of e.state.news.filter(n => n.eventId)) {
      const card = data.events.find(c => c.id === n.eventId)!;
      assert.equal(n.date, isTradingDay(card.date) ? card.date : nextTradingDay(card.date));
    }
    assert.ok(!e.state.firedEvents.includes('lehman_rescue_variant'));
  }
});
test('D0 executes SPX at dataset next-day open, not a fraction of future daily return', () => {
  const e = new GameEngine(data, { config: { difficulty: 0, startDate: '2008-09-12' } });
  e.submitOrder({ instrumentId: 'SPX', side: 'buy', quantity: 1, kind: 'market', submittedAt: e.state.date });
  assert.equal(e.advance().fills[0].price, data.market!.series.SPX.find(b => b.date === '2008-09-15')!.open);
});
test('D0 start valuation uses last known date, never first future bar', () => {
  const source = new RealPriceSource(data.market!);
  assert.equal(source.barOnOrBefore('SPX', '2007-01-02'), undefined);
  const e = new GameEngine(data, { config: { difficulty: 0, startDate: '2008-09-12' } });
  assert.equal(e.state.prices.get('SPX'), source.barFor('SPX', '2008-09-12')!.close);
});
test('D0 missing history carries valuation with provenance but rejects stale-price trades', () => {
  const modified = structuredClone(data);
  modified.market!.series.SPX = modified.market!.series.SPX.filter(b => b.date !== '2008-09-15');
  const e = new GameEngine(modified, { config: { difficulty: 0, startDate: '2008-09-12' } });
  const previous = e.state.prices.get('SPX');
  e.submitOrder({ instrumentId: 'SPX', side: 'buy', quantity: 1, kind: 'market', submittedAt: e.state.date });
  const r = e.advance();
  assert.equal(r.fills[0].reason, 'missing_quote');
  assert.equal(e.state.prices.get('SPX'), previous);
  assert.equal(e.visibleBars('SPX').at(-1)!.provenance, 'carried');
});
