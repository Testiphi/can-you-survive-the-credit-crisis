import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../src/engine.ts';
import { loadDataset } from '../src/load-node.ts';
import { applyMarketRevision } from '../src/market-revision.ts';
import { prepareKlineData } from '../../../apps/web/src/chart-data.ts';
const data=loadDataset();const ids=['GS','MS','AIG','C','JPM'];
test('bounded market revision replaces all 255 flat placeholders and preserves later prices',()=>{
 const before=JSON.stringify(data.market);const patched=applyMarketRevision(data.market,data.marketPatch);
 for(const id of ids){
  const early=patched.series[id].filter(b=>b.date<'2007-03-19');assert.equal(early.length,51);
  assert.ok(early.every(b=>b.high>b.low && b.volume>0));
  assert.deepEqual(patched.series[id].filter(b=>b.date>='2007-03-19'),data.market!.series[id].filter(b=>b.date>='2007-03-19'));
 }
 assert.equal(patched.series.C[0].close,55.25);assert.equal(patched.series.AIG[0].close,1443);
 assert.equal(JSON.stringify(data.market),before);
});
test('D3 uses corrected initial and subsequent candles while legacy gaps are explicitly estimated',()=>{
 const e=new GameEngine(data,{config:{difficulty:3,marketRevision:1,startDate:'2007-01-03',endDate:'2007-03-20'}});
 for(const id of ids)assert.ok(e.visibleBars(id)[0].high>e.visibleBars(id)[0].low);
 while(!e.isOver)e.advance();
 for(const id of ids)assert.ok(e.visibleBars(id).filter(b=>b.date<'2007-03-19').every(b=>b.high>b.low));
 const old=new GameEngine(data,{config:{difficulty:3,startDate:'2007-01-03',endDate:'2007-03-20'}});old.advance();
 const chart=prepareKlineData(old.visibleBars('GS'));
 assert.ok(chart.estimatedCount>0);assert.ok(chart.candles.every(b=>!('open' in b)));
 assert.ok(chart.volumes.every(b=>!('value' in b)));
});
test('market revision and demo version replay independently; legacy saves still restore',()=>{
 for(const marketRevision of [undefined,1] as const){
  const e=new GameEngine(data,{config:{difficulty:0,marketRevision,startDate:'2007-01-03',endDate:'2007-03-20'}});
  e.submitByNotional('C',20000);e.advance();
  const restored=GameEngine.restore(data,JSON.parse(JSON.stringify(e.save())));
  assert.deepEqual(restored.advance(),e.advance());
 }
 const invalid=structuredClone(data.marketPatch!);invalid.series.GS[0].high=0;
 assert.throws(()=>applyMarketRevision(data.market,invalid),/OHLC/);
});
