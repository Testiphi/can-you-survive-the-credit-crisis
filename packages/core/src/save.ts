import type { GameConfig, Order, PlayerAction } from './types.ts';

export const SAVE_VERSION = 1;
export interface GameSave {
  version: number;
  datasetHash: string;
  config: GameConfig;
  seed: number;
  date: string;
  turnIndex: number;
  equity: number;
  actions: PlayerAction[];
  pendingOrders: Order[];
  stateHash: string;
}

/** Deterministic integrity check, not a security signature or anti-cheat mechanism. */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value, (_key, v) => v instanceof Map ? [...v] : v);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

export function validateSave(value: unknown): asserts value is GameSave {
  if (!value || typeof value !== 'object') throw new Error('存档格式无效');
  const s = value as GameSave;
  if (s.version !== SAVE_VERSION) throw new Error('存档版本不兼容，请保留原存档');
  if (!s.config || s.config.difficulty !== 0 || !['retail', 'hedge_fund'].includes(s.config.identity) || s.config.timeline !== 'historical') {
    throw new Error('目前只支持恢复 D0 历史模式存档');
  }
  if (!Number.isFinite(s.config.initialCapital) || s.config.initialCapital <= 0 ||
      !Number.isSafeInteger(s.seed) || s.seed !== s.config.seed ||
      !Number.isInteger(s.turnIndex) || s.turnIndex < 0 || s.turnIndex > 2000 ||
      !Number.isFinite(s.equity) || !Array.isArray(s.actions) || s.actions.length > 2000 ||
      !Array.isArray(s.pendingOrders) || s.pendingOrders.length > 1000) throw new Error('存档数据无效');
  for (const date of [s.config.startDate, s.config.endDate, s.date]) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
        date < '2007-01-01' || date > '2009-12-31') throw new Error('存档日期不受支持');
  }
  if (s.config.endDate < s.config.startDate) throw new Error('存档日期顺序无效');
  let previous = 0;
  for (const action of s.actions) {
    if (!action || !Number.isInteger(action.turnIndex) || action.turnIndex <= previous || action.turnIndex > s.turnIndex ||
        !Array.isArray(action.orders) || action.orders.length > 1000) throw new Error('操作日志无效');
    previous = action.turnIndex;
  }
}
