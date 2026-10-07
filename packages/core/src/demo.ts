import type { EventCard } from './types.ts';

/** 原事件 ID 和依赖保持不变。旧存档不带 demoVersion，继续使用原始数据。 */
export function demoEvents(events: EventCard[], version?: 1): EventCard[] {
  if (version === undefined) return events;
  if (version !== 1) throw new Error('不支持的演示版规则版本');
  return events.map(card => card.id === 'goldman_tarp_repayment' ? {
    ...card, date: '2009-06-17',
    headline: '高盛回购财政部持有的 TARP 优先股，连同应计股息支付约 100.4 亿美元',
    narrative: '高盛于 2009 年 6 月 17 日宣布回购财政部通过 TARP 持有的优先股。退出救助说明资本和融资条件有所改善，但不能据此推断所有机构已恢复，也不能保证股价继续上涨。',
    sources: ['https://www.goldmansachs.com/pressroom/press-releases/2009/tarp-repurchase'],
  } : card);
}
