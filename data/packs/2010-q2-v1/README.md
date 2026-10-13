# 2010 年第二季度数据包 v1

独立 D0 章节，2010-04-01 至 2010-06-30，63 个纽约交易日、62 次推进。沿用原来的四角色和 EventCard 框架；2007—2009 主数据及旧存档指纹不变。并未补齐 2010 年 1—3 月，完整三年模式仍止于 2009 年末。

## 数据口径

- `market.json`：Yahoo chart API 的 SPX、GS、MS、JPM、C、AIG 共 378 根真实 OHLCV，不使用 adjclose。D0 界面仍只交易 SPX/C，包内不提供退市标的合成行情。
- C 价格 ×0.1、成交量 ×10，延续原游戏的拆股单位；其他标的均 ×1。以 2009-12-22 至 31 的 7 个重叠交易日核对收盘价单位，提供商差异小于 1%；成交量保留 Yahoo 统计口径，不能假定两家提供商一致。
- `macro-observations.csv` 是冻结输入；`macro.json` 是同内容的运行时表示。VIX 来自 [CBOE 日历史 CSV](https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv) 的 CLOSE；TED 来自 [FRED TEDRATE 表](https://fred.stlouisfed.org/data/TEDRATE)，单位为百分点。4 月 5 日沿用 4 月 1 日、5 月 3 日沿用 4 月 30 日的 TED，`tedAsOf` 保留真实观测日期，只向前携带，不使用未来插值。
- 无可稳定取得的本时期 HY OAS 冻结序列，因此 `creditSpread = 250 + 12 × max(0, VIX − 12)` **仅是教学估算（bp），不是历史信用利差**。
- 教学系统压力 `S = 0.6 × clamp((VIX−12)/38) + 0.4 × clamp((TED−0.1)/0.4)`，clamp 限于 0—1。流动性 `max(0.05, 1−0.95S)`，回购折扣沿用引擎函数。银行融资与保险赔付按既有合同读取这个教学压力；它不代表真实银行或保险公司的损失估计。
- 逐日行情和宏观观测已经反映市场变化，事件卡不再叠加价格或宏观冲击。闪崩只有日线，不模拟盘中成交/熔断。

抓取 URL、原响应 SHA-256、缩放与重叠检查记录见 `provenance.json`。外部市场数据不因本项目使用 MIT 代码许可证而改变其提供商条款。

## 事件链

`events.json` 共 12 张卡：3 月 31 日 QE1 购买阶段结束为开局背景；季度内 11 张卡覆盖 ECB 抵押品公告、希腊申请援助与评级下调、援助协议与批准、闪崩、美元互换重启、SMP、EFSF 成立、美国单股熔断规则、欧洲压力测试披露安排。每卡附原机构来源链接，复用 `requires`、`window`、`trigger`、`newsVisibility`，没有新建第二套事件执行器。

非交易日公告在下一个交易日显示，标题只陈述当时信息。6 月 17 日显示披露安排，不提前给出 7 月测试结果；4 月 8 日公告中的 2011 年折扣规则不作为当日已生效规则。回顾正文仅在结算后开放。

## 版本与校验

配置显式选择 `periodPack: "2010-q2-v1"`、`calendar: "nyse-2010"`、`demoVersion: 1`。缺少包、日期越界、行情或宏观缺口会拒绝开局/恢复，不沿用 2009 年末报价。存档指纹包含所选包的行情、事件和宏观数据；未选择包的旧局不把它计入指纹。未来修改冻结内容应发布新包版本并保留 v1。

```bash
node --test packages/core/test/period-pack.test.ts packages/core/test/calendar-version.test.ts
python tools/validate_period_packs.py
node tools/period-readiness.ts
# 可选重建：先按 provenance.json 的 URL 保存原响应为 SPX.json、C.json 等
python data/pipeline/build_2010_q2.py --raw-dir /path/to/cached-yahoo-responses
```

构建和 CI 只读仓库中的冻结数据，不访问行情网络。重建器严格检查符号、重叠价格单位、完整日期、正成交量与 OHLC 边界，不能用缺失值默默补行情。NYSE 日历包含 2010 年休市日；本章跳过 4 月 2 日、5 月 31 日。旧存档没有日历标记时保留原日期行为，包含跨入 2010 年的旧合同期限。
