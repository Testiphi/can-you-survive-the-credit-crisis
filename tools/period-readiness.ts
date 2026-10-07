/** Read-only audit of candidate chapter data, not a verification of source prices/history. */
import { demoEvents } from '../packages/core/src/demo.ts';
import { loadDataset } from '../packages/core/src/load-node.ts';
import { tradingDaysBetween } from '../packages/core/src/time.ts';
const raw=loadDataset();
const data={...raw,events:demoEvents(raw.events,1)};
const candidates=[['2008-02-01','2008-03-31'],['2009-05-01','2009-06-30'],['2010-04-01','2010-06-30']];
for(const [start,end] of candidates){
  const calendarSupported=start>='2007-01-01' && end<='2009-12-31';
  const expected=calendarSupported?tradingDaysBetween(start,end):[];
  const events=data.events.filter(e=>e.date>=start && e.date<=end);
  const ids=new Set(events.map(e=>e.id));
  const historical=events.filter(e=>e.trigger.type!=='scheduled' || !e.trigger.modeOnly || e.trigger.modeOnly==='historical');
  const byId=new Map(data.events.map(e=>[e.id,e]));
  const outsidePrerequisites=[...new Set(events.flatMap(e=>[...e.requires,...e.requireAnyOf.flat()]).filter(id=>byId.has(id)&&!ids.has(id)))];
  console.log(JSON.stringify({start,end,calendarSupported,expectedTradingDays:calendarSupported?expected.length:null,
    historyEvents:historical.length,beginnerNews:historical.filter(e=>e.newsVisibility===0).length,
    eventsOnStartDate:historical.filter(e=>e.date===start).map(e=>e.id),outsidePrerequisites,
    prices:['SPX','C'].map(id=>{const rows=(data.market?.series[id]??[]).filter(b=>b.date>=start && b.date<=end);const dates=new Set(rows.map(b=>b.date));return {id,rows:rows.length,filled:rows.filter(b=>b.filled).length,zeroVolume:rows.filter(b=>b.volume===0).length,missingDates:calendarSupported?expected.filter(d=>!dates.has(d)):null};})
  },null,2));
}
