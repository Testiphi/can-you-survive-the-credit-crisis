/**
 * 种子化伪随机数生成器。
 *
 * 设计要点（见 docs/02 §6）：
 *  - 绝对不用 Math.random()。种子 + 操作日志 = 可完整复现。
 *  - **多流分离**：market / scenario / agents / news 各自独立。
 *    这样玩家在某一天多下一单（消耗一个随机数）不会改变后续事件的触发时间。
 */

/** 把 (seed, stream) 哈希成一个 32 位整数，作为流的初始状态。 */
function hashSeed(seed: number, stream: string): number {
  let h = (seed | 0) ^ 0x9e3779b9;
  for (let i = 0; i < stream.length; i++) {
    h = Math.imul(h ^ stream.charCodeAt(i), 0x01000193);
    h = (h << 13) | (h >>> 19);
  }
  // 避免 0 状态
  return (h >>> 0) || 0x1a2b3c4d;
}

export type RngStream = 'market' | 'scenario' | 'agents' | 'news' | 'player';

export class Rng {
  private state: number;
  private spare: number | null;

  constructor(seed: number, stream: RngStream | string = 'default') {
    this.state = hashSeed(seed, String(stream));
    this.spare = null;
  }

  /** 派生一个独立的子流（用于按机构/按标的分离随机性）。 */
  fork(tag: string): Rng {
    return new Rng(this.state, tag);
  }

  /** 均匀分布 [0, 1)。splitmix32。 */
  next(): number {
    this.state = (this.state + 0x9e3779b9) | 0;
    let t = this.state ^ (this.state >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return (t >>> 0) / 4294967296;
  }

  /** 整数 [0, n)。 */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** 实数 [lo, hi)。 */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** 以概率 p 返回 true。 */
  chance(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.next() < p;
  }

  /** 标准正态。Box-Muller，缓存第二个值。 */
  normal(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * mul;
    return u * mul;
  }

  /** 正态，指定均值与标准差。 */
  gaussian(mean = 0, sd = 1): number {
    return mean + sd * this.normal();
  }

  /** 泊松过程：本步是否发生跳跃（lambda 为每单位时间的期望次数）。 */
  jump(lambda: number, dt = 1): boolean {
    return this.chance(1 - Math.exp(-lambda * dt));
  }

  /** 等概率取一个元素。 */
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  /** 按权重取索引。 */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    if (total <= 0) return 0;
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }

  /** Fisher-Yates，返回新数组。 */
  shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  /** 指数分布采样，用于竞争风险模型的「谁先发生」。 */
  exponential(rate: number): number {
    if (rate <= 0) return Infinity;
    return -Math.log(1 - this.next()) / rate;
  }

  /** 导出当前状态，便于存档与回放校验。 */
  snapshot(): number {
    return this.state >>> 0;
  }
}

/** 引擎使用的一组相互独立的随机流。 */
export function createStreams(seed: number) {
  return {
    market: new Rng(seed, 'market'),
    scenario: new Rng(seed, 'scenario'),
    agents: new Rng(seed, 'agents'),
    news: new Rng(seed, 'news'),
  };
}

export type Streams = ReturnType<typeof createStreams>;
