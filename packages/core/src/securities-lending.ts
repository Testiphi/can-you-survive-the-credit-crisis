/**
 * 证券借贷 —— 做空的容量约束、费用与强制回补。
 *
 * 见 docs/07 §5.4：证券借贷部门与回购出借方是同一批机构。
 * 当它们撤退时，做空也做不成了——借券费飙升、券源枯竭、已建立的空头被召回。
 *
 * 这个模块存在的平衡意义：
 *   如果做空没有摩擦，「2007 年初全仓做空雷曼并持有两年」就是一个几乎确定的高收益策略，
 *   游戏会坍缩成单一解。真实世界里，做空的三重成本是：
 *     ① 借券费随利用率二次上升
 *     ② 可借券规模有上限（危机中收缩）
 *     ③ 出借人可以随时召回 → 强制回补 → 在反弹中被逼空
 */

/** 可借券占流通股的比例（平静期）。危机中会大幅收缩。 */
export const DEFAULT_BORROW_SUPPLY_RATIO = 0.08;

/** 基础借券费（年化） */
export const BASE_BORROW_FEE = 0.005;

/** 借券费上限（年化）。历史上金融股在 2008 年达到过 50% 以上。 */
export const MAX_BORROW_FEE = 1.5;

export interface BorrowQuoteInput {
  instrumentId: string;
  /** 流通股数 */
  floatShares: number;
  price: number;
  /** 当前空头数量（正数） */
  currentShortQty: number;
  /** 拟追加做空的股数（正数）。用于计算加了这一单之后的利用率。 */
  additionalQty?: number;
  /** 系统性压力 0..1 */
  stress: number;
  /** 事件带来的借券费倍数（如 rumor 或 repo_borrow_squeeze） */
  borrowMult?: number;
  /** 当日市场收益，用于判断逼空环境 */
  marketReturnToday?: number;
}

export interface BorrowQuote {
  /** 可借券的总股数 */
  capacityShares: number;
  /** 可借券的总美元规模 */
  capacityNotional: number;
  /** 已用（当前空头）美元规模 */
  usedNotional: number;
  /** 利用率 > 1 表示已超出可借规模 */
  utilization: number;
  /** 年化借券费 */
  feeRate: number;
  /** 在不突破容量的前提下还能做空的股数 */
  headroomShares: number;
  /** 当日被强制回补（lender recall）的概率 */
  recallRisk: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 出一份借券报价。
 *
 * 费用模型：`base × 利用率倍数 × 压力倍数 × 事件倍数`
 * 其中利用率倍数是二次的——这正是真实证券借贷市场的形态：
 * 利用率从 50% 涨到 80% 时，费率不是涨 60%，而是涨好几倍。
 */
export function borrowQuote(input: BorrowQuoteInput): BorrowQuote {
  const stress = clamp(input.stress, 0, 1);

  // ① 可借券规模随危机收缩（出借方撤退）
  const supplyRatio = DEFAULT_BORROW_SUPPLY_RATIO * (1 - 0.6 * stress);
  // 没有流通股 = 不存在借券市场。指数属于这一类：
  // 现实中做空大盘走的是期货/ETF，成本是融资成本（个位数年化）。
  const borrowable = input.floatShares > 0;
  const capacityShares = borrowable ? Math.max(0, input.floatShares * supplyRatio) : 0;
  const capacityNotional = capacityShares * input.price;

  const currentShort = Math.max(0, input.currentShortQty);
  const projectedShort = currentShort + Math.max(0, input.additionalQty ?? 0);
  // 利用率只对「真的要去借券」的标的成立。
  //
  // 早前这里写成 `capacityShares > 0 ? ... : 1`，于是不可借券的标的
  // 被记为「满负荷」，utilMult 直接吃满 4 倍：做空标普 500 在平静期
  // 就要付 23%/年、危机期顶到 150%/年上限。实测在 2007-10-09 的历史
  // 最高点做空并持有到 2009-12-31，指数跌了 28.7%，账户却净亏 5.96 万
  // ——借券费 8.4 万，是毛收益的 3.3 倍。
  const utilization = !borrowable ? 0 : capacityShares > 0 ? projectedShort / capacityShares : 1;
  const usedNotional = currentShort * input.price;

  // ② 借券费
  const utilMult = 1 + 3 * utilization * utilization;
  // 压力敏感度：难借券的个股在危机中费率会飙升，但流动性好的名字不会。
  //
  // 早前对所有人用 1 + 120·stress，结果高盛这种从不难借的大票在 2008 年
  // 也要付 33%/年（真实水平是个位数）。利用率才是区分「难借」与「好借」的
  // 正确维度——它本来就是标的特有的——所以压力倍数应当温和，
  // 让 utilMult 去做区分。
  const stressMult = borrowable ? 1 + 20 * stress : 1 + 4 * stress;
  const feeRate = Math.min(
    MAX_BORROW_FEE,
    BASE_BORROW_FEE * utilMult * stressMult * (input.borrowMult ?? 1),
  );

  // ③ 强制回补风险：高利用率 + 危机 + 反弹。
  // 指数不会被「召回」——没有出借人。
  const base = borrowable ? 0.0003 + 0.015 * utilization * utilization * stress : 0;
  const move = input.marketReturnToday ?? 0;
  const rallyMult = move > 0 ? 1 + 10 * move : 1;
  const recallRisk = Math.min(0.4, base * rallyMult);

  const headroomShares = Math.max(0, capacityShares - currentShort);

  return {
    capacityShares,
    capacityNotional,
    usedNotional,
    utilization,
    feeRate,
    headroomShares,
    recallRisk,
  };
}

/**
 * 强制回补的规模与价格惩罚。
 *
 * 出借人召回时，你必须在市场上买回——而市场上所有人都知道你在买。
 * 所以成交价带惩罚性滑点，回补比例也由出借人决定，你无权协商。
 */
export function planRecall(
  shortQty: number,
  rng: { range: (a: number, b: number) => number },
): { quantity: number; penalty: number } {
  const fraction = rng.range(0.15, 0.45);
  const quantity = Math.max(1, Math.floor(shortQty * fraction));
  // 逼空中的买入冲击：2–5 倍正常滑点
  const penalty = rng.range(2, 5);
  return { quantity, penalty };
}

/**
 * 空头维持保证金率。危机中交易所与券商都会上调。
 * 这是「你在反弹中被追保、然后被强平」的机制来源。
 */
export function dynamicShortMarginRate(stress: number): number {
  return 0.3 + 0.45 * clamp(stress, 0, 1);
}
