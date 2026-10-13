import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GameEngine } from '../src/engine.ts';
import { loadDataset } from '../src/load-node.ts';
import { nextTradingDay, tradingDaysBetween, shiftTradingDays } from '../src/time.ts';

test('versioned 2010 calendar skips NYSE holidays without altering legacy dates', () => {
  assert.equal(nextTradingDay('2010-04-01', 'nyse-2010'), '2010-04-05');
  assert.equal(nextTradingDay('2010-05-28', 'nyse-2010'), '2010-06-01');
  assert.equal(shiftTradingDays('2010-06-01', -1, 'nyse-2010'), '2010-05-28');
  assert.equal(tradingDaysBetween('2010-04-01', '2010-06-30', 'nyse-2010').length, 63);
  assert.equal(nextTradingDay('2009-12-31'), '2010-01-01');
  assert.equal(nextTradingDay('2009-12-31', 'nyse-2010'), '2010-01-04');
});

test('pre-extension saves from commit 9005c6d retain exact state and dataset fingerprints', () => {
  const saves = JSON.parse(readFileSync(new URL('./legacy-2009-saves.json', import.meta.url), 'utf8'));
  const data = loadDataset();
  for (const save of saves) {
    const restored = GameEngine.restore(data, save);
    assert.equal(restored.save().stateHash, save.stateHash);
    assert.equal(restored.save().datasetHash, save.datasetHash);
  }
});
