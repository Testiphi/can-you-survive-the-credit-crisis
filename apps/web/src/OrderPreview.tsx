import type { TradePreview } from '@cyscc/core';
import { FILL_REASON } from './glossary.ts';

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const position = (n: number) => n === 0 ? '空仓' : `${n > 0 ? '多头' : '空头'} ${Math.abs(n).toLocaleString('en-US')} 股`;

export function OrderPreview({ buy, sell }: { buy: TradePreview; sell: TradePreview }) {
  return <div className="b-panel" aria-label="下单预览">
    <h3>下单预览 · 按当前报价估计</h3>
    {[buy, sell].map((p, i) => <div key={i} style={{ margin: '8px 0' }}>
      <b>{i === 0 ? '买入方向' : '卖出方向'}：{p.label}</b>
      {p.order && p.fill && <>
        <div>计划 {p.order.quantity.toLocaleString('en-US')} 股，估计成交 {p.fill.quantity.toLocaleString('en-US')} 股 · {FILL_REASON[p.fill.reason]}</div>
        <div>{position(p.beforeQty)} → {position(p.afterQty)}；平掉旧仓 {p.closing.toLocaleString('en-US')} 股，新增{i === 0 ? '多头' : '空头'} {p.opening.toLocaleString('en-US')} 股。</div>
        <div>手续费约 {money(p.fill.commission)}；成交后现金约 {money(p.cashAfter)}，可用于付款约 {money(p.availableCashAfter)}。</div>
        {p.paymentGapAfter !== undefined && <div className={p.paymentGapAfter > 0 ? 'neg' : 'dim'}>最近必付款项的预计现金缺口：{money(p.paymentGapAfter)}</div>}
        {(p.collateralGapAfter ?? 0) > 0 && <div className="neg">抵押池预计缺口：{money(p.collateralGapAfter!)}，结算时可能需要补还本金。</div>}
      </>}
      {p.note && <div>{p.note}</div>}
    </div>)}
    <div className="dim">预览不会下单或推进时间。实际按下一交易日开盘价成交，可能部分成交或被拒绝；以上未计入次日其他收支。</div>
  </div>;
}
