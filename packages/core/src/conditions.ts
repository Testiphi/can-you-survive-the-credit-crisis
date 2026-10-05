/**
 * 条件求值器。
 *
 * 事件卡里有两套条件语法（见 docs/06 §8）：
 *  ① 状态谓词 —— 用于 requires / requireAnyOf，如 `credit_spread_above_800`
 *  ② 表达式   —— 用于 trigger.predicate，如 `systemicStress > 0.7`
 *
 * 两者都由此模块处理。刻意不使用 eval()：一是安全，二是错误信息可读。
 */

export interface ConditionContext {
  date: string;
  turnIndex: number;
  spx: number;
  vix: number;
  /** bp */
  creditSpread: number;
  /** 百分点 */
  tedSpread: number;
  /** 市场容量乘数 0..1 */
  liquidity: number;
  systemicStress: number;
  /** 加权回购折扣率 */
  repoHaircut: number;
  /** 玩家系统性风险分 */
  srs: number;
  /** 玩家杠杆（总敞口 / 权益） */
  leverage: number;
  /** 标的多空比例：-1 全空，+1 全多 */
  netExposure: number;
  /** 玩家对某标的的空头占流通股比例，如 { LEH: 0.048 } */
  shortConcentration: Record<string, number>;
  /** 已触发事件 id 集合 */
  fired: Set<string>;
}

/** 供谓词与表达式共用的字段名别名表。 */
const FIELD_ALIASES: Record<string, keyof ConditionContext | 'shortConcentration'> = {
  spx: 'spx',
  vix: 'vix',
  creditSpread: 'creditSpread',
  credit_spread: 'creditSpread',
  tedSpread: 'tedSpread',
  ted_spread: 'tedSpread',
  liquidity: 'liquidity',
  liquidityMultiplier: 'liquidity',
  systemicStress: 'systemicStress',
  repoHaircut: 'repoHaircut',
  srs: 'srs',
  leverage: 'leverage',
  netExposure: 'netExposure',
};

function readField(ctx: ConditionContext, name: string): number | undefined {
  const key = FIELD_ALIASES[name];
  if (!key) return undefined;
  if (key === 'shortConcentration') return undefined;
  const v = ctx[key];
  return typeof v === 'number' ? v : undefined;
}

// ------------------------------------------------------------ ① 状态谓词

const PREDICATE_RULES: Array<{
  re: RegExp;
  fn: (m: RegExpMatchArray, ctx: ConditionContext) => boolean;
}> = [
  {
    re: /^credit_spread_above_([\d.]+)$/,
    fn: (m, ctx) => ctx.creditSpread > Number(m[1]),
  },
  {
    re: /^vix_above_([\d.]+)$/,
    fn: (m, ctx) => ctx.vix > Number(m[1]),
  },
  {
    re: /^ted_spread_above_([\d.]+)$/,
    fn: (m, ctx) => ctx.tedSpread > Number(m[1]),
  },
  {
    re: /^liquidity_below_([\d.]+)$/,
    fn: (m, ctx) => ctx.liquidity < Number(m[1]),
  },
  {
    re: /^srs_above_([\d.]+)$/,
    fn: (m, ctx) => ctx.srs > Number(m[1]),
  },
  {
    re: /^leverage_above_([\d.]+)$/,
    fn: (m, ctx) => ctx.leverage > Number(m[1]),
  },
  {
    // 本作独有：玩家可以成为事件的触发者
    re: /^player_short_concentration_([A-Z0-9.]+)_above_([\d.]+)pct$/,
    fn: (m, ctx) => (ctx.shortConcentration[m[1]] ?? 0) > Number(m[2]) / 100,
  },
  {
    re: /^repo_haircut_above_([\d.]+)$/,
    fn: (m, ctx) => ctx.repoHaircut > Number(m[1]),
  },
];

/** 该 token 是否形如状态谓词（而非事件 id）。 */
export function isPredicate(token: string): boolean {
  return PREDICATE_RULES.some((r) => r.re.test(token));
}

function evalPredicate(token: string, ctx: ConditionContext): boolean | undefined {
  for (const rule of PREDICATE_RULES) {
    const m = token.match(rule.re);
    if (m) return rule.fn(m, ctx);
  }
  return undefined;
}

// ------------------------------------------------------------ ② 表达式

const COMPARISON_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(>=|<=|==|!=|>|<)\s*(-?[\d.]+)\s*$/;

function evalComparison(expr: string, ctx: ConditionContext): boolean {
  const m = expr.match(COMPARISON_RE);
  if (!m) {
    throw new Error(`无法解析的条件表达式: ${JSON.stringify(expr)}`);
  }
  const [, name, op, raw] = m;
  const lhs = readField(ctx, name);
  if (lhs === undefined) {
    throw new Error(`条件表达式引用了未知字段: ${name}`);
  }
  const rhs = Number(raw);
  switch (op) {
    case '>':
      return lhs > rhs;
    case '>=':
      return lhs >= rhs;
    case '<':
      return lhs < rhs;
    case '<=':
      return lhs <= rhs;
    case '==':
      return lhs === rhs;
    case '!=':
      return lhs !== rhs;
    default:
      throw new Error(`未知运算符: ${op}`);
  }
}

/**
 * 求值一个条件 token。
 *  - 若 token 是已注册的状态谓词，按谓词规则求值。
 *  - 否则视为表达式。
 *
 * `fired` 的检查由调用方（scenario）处理，因为「事件 id」与「谓词」的
 * 区分需要事件注册表。这里只处理状态条件。
 */
export function evaluateCondition(token: string, ctx: ConditionContext): boolean {
  const pred = evalPredicate(token, ctx);
  if (pred !== undefined) return pred;

  // 支持 `a && b` 与 `a || b`（不支持括号，事件卡里也用不到）
  if (token.includes('&&')) {
    return token.split('&&').every((part) => evaluateCondition(part, ctx));
  }
  if (token.includes('||')) {
    return token.split('||').some((part) => evaluateCondition(part, ctx));
  }

  return evalComparison(token, ctx);
}

/** 建立求值上下文。由引擎在每回合调用。 */
export function makeContext(partial: Partial<ConditionContext> & { date: string }): ConditionContext {
  return {
    turnIndex: 0,
    spx: 0,
    vix: 20,
    creditSpread: 300,
    tedSpread: 0.5,
    liquidity: 1,
    systemicStress: 0,
    repoHaircut: 0.05,
    srs: 0,
    leverage: 1,
    netExposure: 0,
    shortConcentration: {},
    fired: new Set<string>(),
    ...partial,
  };
}
