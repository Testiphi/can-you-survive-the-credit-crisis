#!/usr/bin/env python3
"""
数据质量校验：把抓到的真实价格与已知的历史事实对照。

这个脚本存在的理由和 price-check.ts 一样：**能取到数据 ≠ 数据是对的**。
新浪返回的是原始序列，可能有复权、拆股、代码撞车、缺失日等问题。
在把它接进引擎之前，先拿几个"我确切知道答案"的日期做对拍。
"""

from __future__ import annotations

from source_sina import fetch_daily

# 已知的历史事实（收盘价，来自公开行情记录）
# 容差放宽到 ±15%，因为不同数据源的复权处理不同
CHECKS: list[tuple[str, str, float, str]] = [
    (".INX", "2007-10-09", 1565.15, "标普 500 历史最高点"),
    (".INX", "2009-03-09", 676.53, "标普 500 见底"),
    (".INX", "2008-09-15", 1192.70, "雷曼破产当日"),
    ("GS", "2007-10-31", 235.0, "高盛 2007 年高点附近"),
    ("GS", "2008-11-20", 52.0, "高盛 2008 年低点附近"),
    ("GS", "2009-12-31", 168.0, "高盛 2009 年末"),
    ("JPM", "2009-03-09", 17.0, "摩根大通危机低点附近"),
    ("AIG", "2008-09-12", 12.1, "AIG 救助前最后交易日（拆股前）"),
    ("C", "2009-03-05", 1.02, "花旗跌破 1 美元"),
]

TOLERANCE = 0.15


def main() -> int:
    cache: dict[str, list[dict]] = {}
    failures: list[str] = []

    print(f"{'标的':<7} {'日期':<12} {'抓取值':>10} {'历史值':>10} {'偏差':>9}  说明")
    print("-" * 82)

    for sym, date, expected, note in CHECKS:
        if sym not in cache:
            cache[sym] = fetch_daily(sym)
        row = next((r for r in cache[sym] if r["date"] == date), None)
        if row is None:
            print(f"{sym:<7} {date:<12} {'缺失':>10} {expected:>10.2f} {'—':>9}  {note}")
            failures.append(f"{sym} {date} 无数据")
            continue

        actual = row["close"]
        dev = actual / expected - 1
        flag = "✓" if abs(dev) <= TOLERANCE else "✗"
        print(f"{sym:<7} {date:<12} {actual:>10.2f} {expected:>10.2f} {dev:>8.1%}{flag} {note}")
        if abs(dev) > TOLERANCE:
            failures.append(f"{sym} {date}: 抓取 {actual} vs 历史 {expected}（偏差 {dev:.1%}）")

    print()
    if failures:
        print(f"✗ {len(failures)} 项未通过：")
        for f in failures:
            print(f"   - {f}")
        return 1
    print("✓ 全部对拍通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
