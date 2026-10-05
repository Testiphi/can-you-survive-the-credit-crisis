/**
 * 浏览器端数据集装配。
 *
 * 引擎本身不读文件，数据集由调用方传入——这样 core 保持平台无关。
 * 这里用 Vite 的 JSON 导入把 data/events/*.json 打进来。
 */

import type { Dataset, EventCard, InstitutionsFile } from '@cyscc/core';
import type { RumorsFile } from '@cyscc/core';

import events2007 from '../../../data/events/events-2007.json';
import events2008 from '../../../data/events/events-2008.json';
import events2009 from '../../../data/events/events-2009.json';
import eventsRepo from '../../../data/events/events-repo.json';
import institutions from '../../../data/events/institutions.json';
import rumors from '../../../data/events/rumors.json';

export const dataset: Dataset = {
  events: [
    ...(events2007 as unknown as { events: EventCard[] }).events,
    ...(events2008 as unknown as { events: EventCard[] }).events,
    ...(events2009 as unknown as { events: EventCard[] }).events,
    ...(eventsRepo as unknown as { events: EventCard[] }).events,
  ],
  institutions: institutions as unknown as InstitutionsFile,
  rumors: rumors as unknown as RumorsFile,
};

export const eventCount = dataset.events.length;
