/**
 * 浏览器端数据集装配。
 *
 * 引擎本身不读文件，数据集由调用方传入——这样 core 保持平台无关。
 * 这里用 Vite 的 JSON 导入把 data/ 打进来。
 *
 * `market.json` 是 `data/pipeline/build_market.py` 的产物，已入库，
 * 因此构建不需要网络。文件缺失时引擎会自动退回合成路径。
 */

import type { Dataset, EventCard, InstitutionsFile, MarketData, MarketPatch } from '@cyscc/core';
import type { RumorsFile } from '@cyscc/core';

import events2007 from '../../../data/events/events-2007.json';
import events2008 from '../../../data/events/events-2008.json';
import events2009 from '../../../data/events/events-2009.json';
import eventsRepo from '../../../data/events/events-repo.json';
import institutions from '../../../data/events/institutions.json';
import rumors from '../../../data/events/rumors.json';
import market from '../../../data/processed/market.json';
import marketPatch from '../../../data/processed/early-ohlc.json';

export const dataset: Dataset = {
  marketPatch: marketPatch as unknown as MarketPatch,
  events: [
    ...(events2007 as unknown as { events: EventCard[] }).events,
    ...(events2008 as unknown as { events: EventCard[] }).events,
    ...(events2009 as unknown as { events: EventCard[] }).events,
    ...(eventsRepo as unknown as { events: EventCard[] }).events,
  ],
  institutions: institutions as unknown as InstitutionsFile,
  rumors: rumors as unknown as RumorsFile,
  market: market as unknown as MarketData,
};

export const eventCount = dataset.events.length;

/** 真实历史数据的覆盖摘要，用于界面展示。 */
export const marketCoverage = {
  source: (market as unknown as MarketData).source,
  range: (market as unknown as MarketData).range,
  real: Object.keys((market as unknown as MarketData).series),
  synthetic: Object.keys((market as unknown as MarketData).synthetic ?? {}),
};
