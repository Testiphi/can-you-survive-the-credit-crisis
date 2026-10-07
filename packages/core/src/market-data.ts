/**
 * 真实历史价格源。
 *
 * 引擎的默认行为是「锚点插值 + beta + 噪声」合成价格路径。
 * 一旦提供了 `data/processed/market.json`，有真实历史的标的就改走真实路径，
 * 事件只在其上做小幅扰动。
 *
 * ## 为什么要区分真实与合成
 *
 * 数据源的覆盖范围决定了这个划分（见 `data/pipeline/source_sina.py`）：
 *
 *   能取到真实历史的：标普指数、高盛、摩根士丹利、摩根大通、花旗、AIG
 *   取不到的：       雷曼、贝尔斯登、美林、华盛顿互惠、房利美、房地美
 *
 * 这个划分在设计上是合理的——**活下来的机构有价格历史，死掉的机构只有事件**。
 * 雷曼归零应当是 `lehman_collapse` 这张事件卡造成的，而不是一条预设的曲线。
 *
 * ## 事件如何作用于真实路径
 *
 * 真实路径本身就包含了历史事件的影响，所以事件卡的 `equityReturn` 不能再
 * 全额叠加一次（那会双重计入）。这里用一个衰减系数
 * （`REAL_PATH_SHOCK_SCALE`），把事件降级为「再计时扰动」——
 * 让价格在抖动后的日期上做出反应，但不改变历史的整体形状。
 */

import type { DateStr, MarketBar, MarketData } from './types.ts';

/**
 * 真实路径上事件冲击的施加系数。
 *
 * 与 `INDEX_SHOCK_SCALE` 同理：基础路径已是历史，事件只做小幅扰动。
 * 1.0 会让「雷曼破产」这一天在高盛的真实跌幅上再叠加一次 −10%，
 * 而那次下跌本来就在真实数据里了。
 */
export const REAL_PATH_SHOCK_SCALE = 0.25;

export class RealPriceSource {
  private byInstrument: Map<string, Map<DateStr, MarketBar>> = new Map();
  private spxByDate: Map<DateStr, number> = new Map();
  readonly source: string;
  readonly range: [DateStr, DateStr];
  readonly synthetic: Record<string, string>;
  readonly instruments: string[];

  constructor(data: MarketData) {
    this.source = data.source;
    this.range = data.range;
    this.synthetic = data.synthetic ?? {};
    this.instruments = Object.keys(data.series);

    for (const [id, bars] of Object.entries(data.series)) {
      const map = new Map<DateStr, MarketBar>();
      for (const b of bars) map.set(b.date, b);
      this.byInstrument.set(id, map);
      if (id === 'SPX') {
        for (const b of bars) this.spxByDate.set(b.date, b.close);
      }
    }
  }

  /** 该标的是否有真实历史数据。 */
  has(instrumentId: string): boolean {
    return this.byInstrument.has(instrumentId);
  }

  /** 取某个标的某个交易日的真实 K 线。 */
  barFor(instrumentId: string, date: DateStr): MarketBar | undefined {
    return this.byInstrument.get(instrumentId)?.get(date);
  }

  /** 某标的的第一个交易日（用于确定起始价）。 */
  firstBar(instrumentId: string): MarketBar | undefined {
    const bars = this.byInstrument.get(instrumentId);
    if (!bars || bars.size === 0) return undefined;
    let first: MarketBar | undefined;
    for (const b of bars.values()) {
      if (!first || b.date < first.date) first = b;
    }
    return first;
  }

  /** 不读取起始日期之后的数据作为期初估值。 */
  barOnOrBefore(instrumentId: string, date: DateStr): MarketBar | undefined {
    let latest: MarketBar | undefined;
    for (const bar of this.byInstrument.get(instrumentId)?.values() ?? []) {
      if (bar.date <= date && (!latest || bar.date > latest.date)) latest = bar;
    }
    return latest;
  }

  /** 标普的收盘价序列，交给宏观模块作为基础路径。 */
  spxSeries(): Map<DateStr, number> {
    return this.spxByDate;
  }

  /** 某标的有多少根 K 线（用于体检）。 */
  barCount(instrumentId: string): number {
    return this.byInstrument.get(instrumentId)?.size ?? 0;
  }
}
