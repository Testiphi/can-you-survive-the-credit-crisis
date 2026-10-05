/**
 * Node 环境的数据集加载器。
 *
 * 这个文件依赖 node:fs，因此**没有**被 index.ts 导出——
 * 浏览器端（apps/web）自行 import JSON，保持 core 的平台无关性。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EventCard, InstitutionsFile, MarketData } from './types.ts';
import type { RumorsFile } from './news.ts';
import type { Dataset } from './engine.ts';

/** 仓库根目录（packages/core/src → 上溯三级）。 */
export function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..');
}

export function eventsDir(): string {
  return join(repoRoot(), 'data', 'events');
}

export function processedDir(): string {
  return join(repoRoot(), 'data', 'processed');
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** 读入全部 events-*.json（自动发现，不写死文件名）。 */
export function loadEvents(dir = eventsDir()): EventCard[] {
  const files = readdirSync(dir).filter((f) => f.startsWith('events-') && f.endsWith('.json'));
  const out: EventCard[] = [];
  for (const f of files.sort()) {
    const data = readJson<{ events: EventCard[] }>(join(dir, f));
    out.push(...data.events);
  }
  return out;
}

export function loadInstitutions(dir = eventsDir()): InstitutionsFile {
  return readJson<InstitutionsFile>(join(dir, 'institutions.json'));
}

export function loadRumors(dir = eventsDir()): RumorsFile {
  return readJson<RumorsFile>(join(dir, 'rumors.json'));
}

/**
 * 载入数据管道产出的真实历史市场数据。
 *
 * 可选：文件不存在时返回 undefined，引擎会退回「锚点插值 + beta + 噪声」
 * 的合成路径。这样 CI 与没跑过管道的环境依然能正常工作。
 */
export function loadMarketData(dir = processedDir()): MarketData | undefined {
  const path = join(dir, 'market.json');
  if (!existsSync(path)) return undefined;
  return readJson<MarketData>(path);
}

/** 一次性载入完整数据集。 */
export function loadDataset(dir = eventsDir()): Dataset {
  if (!existsSync(dir)) {
    throw new Error(`事件目录不存在: ${dir}`);
  }
  return {
    events: loadEvents(dir),
    institutions: loadInstitutions(dir),
    rumors: loadRumors(dir),
    market: loadMarketData(),
  };
}
