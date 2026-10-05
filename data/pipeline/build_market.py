#!/usr/bin/env python3
"""
构建引擎消费的市场数据集。

    python data/pipeline/build_market.py

产出 `data/processed/market.json`，结构：

    {
      "version": 1,
      "source": "sina",
      "range": ["2007-01-02", "2009-12-31"],
      "series": { "SPX": [{date, open, high, low, close, volume}, ...], ... },
      "synthetic": { "LEH": "雷曼兄弟（2008 破产退市）", ... }
    }

## 设计取舍：真实路径 + 合成路径并存

能取到真实数据的，是**活下来的**机构（GS/MS/JPM/C/AIG + 标普指数）。
取不到真实数据的，恰恰是**死掉的那些**（LEH/BSC/MER/WM/FNM/FRE）。

这个划分正好落在设计上合理的位置（docs/03 §1.1）：

    最终价格 = 基础历史路径 × 事件冲击 × 路径噪声 × 交易冲击

存活机构的路径就是历史，事件只做小幅扰动；
而失败机构的终局本来就应该是**事件驱动**的（雷曼归零是 `lehman_collapse`
这张卡造成的，不是一条预设的价格曲线）。

因此不做"给退市股伪造历史路径"这种自欺的事——合成路径明确标注在
`synthetic` 字段里，引擎按合成模式处理它们。
"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from source_sina import COVERED, fetch_daily  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "processed" / "market.json"

# 引擎里的标的 id → 新浪代码
SYMBOL_MAP: dict[str, str] = {
    "SPX": ".INX",
    "GS": "GS",
    "MS": "MS",
    "JPM": "JPM",
    "C": "C",
    "AIG": "AIG",
}

# 取不到真实数据、由事件驱动的标的（与引擎的 instruments.ts 对应）
SYNTHETIC: dict[str, str] = {
    "LEH": "雷曼兄弟（2008 破产退市）",
    "BSC": "贝尔斯登（2008 被收购）",
    "MER": "美林证券（2009 被收购）",
    "WM": "华盛顿互惠（2008 被接管）",
    "FNM": "房利美（2010 退市）",
    "FRE": "房地美（2010 退市）",
}

START = "2007-01-02"
END = "2009-12-31"
# 多取一点前置数据，方便计算期初均线
PREFETCH_START = "2006-11-01"

# 与 packages/core/src/instruments.ts 保持一致。
# 用于回填数据缺口：缺失日的收益 = beta × 标普收益。
BETAS: dict[str, float] = {
    "SPX": 1.0,
    "GS": 1.3,
    "MS": 1.9,
    "JPM": 1.2,
    "C": 1.7,
    "AIG": 1.6,
}


# 已知的公司行为。新浪返回的是**未复权**价格，必须自己处理，
# 否则持有该标的穿过拆股日会凭空获得（或损失）一个数量级。
#
# 实测：AIG 在 2009-07-01 的原始序列是 1.16 → 18.08（+1458%），
# 那就是它的 1:20 反向拆股。未处理时价格模型的 AIG 期末值会变成
# $19.65（拆股前口径应为 $1.4），直接跑挂 price-check。
#
# adjustment 语义：把该日期**之前**的所有价格乘以 ratio，
# 表达成拆股后的每股口径。这样一个空头从拆股前持有到拆股后，
# 收益率与真实操作一致。
CORPORATE_ACTIONS: dict[str, list[dict]] = {
    "AIG": [{"date": "2009-07-01", "ratio": 20.0, "note": "1:20 反向拆股"}],
}

# 未被显式登记、但单日跳变超过这个倍数的，会在构建时报警
SUSPICIOUS_JUMP = 3.0


def apply_corporate_actions(rows: list[dict], actions: list[dict]) -> tuple[list[dict], int]:
    """把拆股等公司行为复权掉，让序列连续。"""
    if not actions:
        return rows, 0
    out = [dict(r) for r in rows]
    applied = 0
    for act in actions:
        cut = act["date"]
        ratio = act["ratio"]
        for r in out:
            if r["date"] < cut:
                for k in ("open", "high", "low", "close"):
                    r[k] = round(r[k] * ratio, 4)
        applied += 1
    return out, applied


def find_suspicious_jumps(rows: list[dict]) -> list[str]:
    """找出可能是未登记公司行为的巨幅跳变。"""
    hits: list[str] = []
    for i in range(1, len(rows)):
        prev, cur = rows[i - 1]["close"], rows[i]["close"]
        if prev <= 0:
            continue
        ratio = cur / prev
        if ratio > SUSPICIOUS_JUMP or ratio < 1 / SUSPICIOUS_JUMP:
            hits.append(f"{rows[i-1]['date']} {prev:.2f} → {rows[i]['date']} {cur:.2f}（{ratio:.2f}×）")
    return hits


def in_range(d: str) -> bool:
    return START <= d <= END


def align_to_calendar(
    rows: list[dict],
    calendar: list[str],
    spx_close: dict[str, float],
    beta: float,
) -> tuple[list[dict], int]:
    """
    把个股序列对齐到标普的交易日历，并回填缺口。

    为什么必须回填：新浪的个股历史**有真实缺口**。实测高盛的
    2007-01-03 → 2007-03-16 整段缺失（50 个交易日），而标普同期完整。
    直接接进引擎会导致这些日子没有 K 线。

    回填方法：缺失日的收益 = beta × 当日标普收益，逐日推进。
    - 序列中间/尾部的缺口：从上一个已知收盘向前推
    - 序列开头的缺口：从第一个已知收盘向后倒推（用倒数）
    - open/high/low 按同比例缩放，volume 记 0（引擎不会用到）
    """
    by_date = {r["date"]: r for r in rows}
    known_dates = sorted(by_date)
    if not known_dates or not calendar:
        return [], 0

    out: dict[str, dict] = {}
    filled = 0

    # ---- 1) 从第一个已知日起，正向推进 ----
    first_idx = calendar.index(known_dates[0]) if known_dates[0] in calendar else 0
    prev_date = known_dates[0]
    prev_close = by_date[known_dates[0]]["close"]
    out[prev_date] = by_date[prev_date]

    for d in calendar[first_idx + 1 :]:
        if d in by_date:
            prev_date, prev_close = d, by_date[d]["close"]
            out[d] = by_date[d]
            continue
        ret = spx_close.get(d, 0) / spx_close.get(prev_date, 1) - 1 if spx_close.get(prev_date) else 0
        close = prev_close * (1 + beta * ret)
        out[d] = {
            "date": d,
            "open": round(close, 2),
            "high": round(close, 2),
            "low": round(close, 2),
            "close": round(close, 2),
            "volume": 0,
            "filled": True,
        }
        prev_date, prev_close = d, close
        filled += 1

    # ---- 2) 倒推开头的缺口 ----
    for d in reversed(calendar[:first_idx]):
        nxt = None
        # 找到这个日期之后第一个已填的日期
        for later in calendar[calendar.index(d) + 1 :]:
            if later in out:
                nxt = later
                break
        if nxt is None:
            continue
        ret = spx_close.get(d, 0) / spx_close.get(nxt, 1) - 1 if spx_close.get(nxt) else 0
        close = out[nxt]["close"] / (1 + beta * ret) if (1 + beta * ret) > 0.01 else out[nxt]["close"]
        out[d] = {
            "date": d,
            "open": round(close, 2),
            "high": round(close, 2),
            "low": round(close, 2),
            "close": round(close, 2),
            "volume": 0,
            "filled": True,
        }
        filled += 1

    ordered = [out[d] for d in calendar if d in out]
    return ordered, filled


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)

    raw: dict[str, list[dict]] = {}
    warnings: list[str] = []
    for inst_id, symbol in SYMBOL_MAP.items():
        try:
            rows = fetch_daily(symbol)
        except Exception as exc:  # noqa: BLE001
            print(f"  ✗ {inst_id:<5} ({symbol}) 抓取失败: {exc}")
            continue
        if not rows:
            print(f"  ✗ {inst_id:<5} ({symbol}) 返回空数据")
            continue

        # 先复权，再裁时间窗——否则拆股跳变会被裁掉一半
        rows, applied = apply_corporate_actions(rows, CORPORATE_ACTIONS.get(inst_id, []))

        trimmed = [r for r in rows if in_range(r["date"])]
        if len(trimmed) < 600:
            print(f"  ✗ {inst_id:<5} ({symbol}) 覆盖不足：仅 {len(trimmed)} 个交易日")
            continue

        for hit in find_suspicious_jumps(trimmed):
            warnings.append(f"{inst_id}: 未登记的巨幅跳变 {hit}")

        if applied:
            notes = "、".join(a["note"] for a in CORPORATE_ACTIONS[inst_id])
            print(f"  · {inst_id:<5} 已复权：{notes}")

        raw[inst_id] = trimmed

    if "SPX" not in raw:
        print("致命：标普 500 未能抓取，管道中止")
        return 1

    # 以标普的交易日历为基准
    calendar = [r["date"] for r in raw["SPX"]]
    spx_close = {r["date"]: r["close"] for r in raw["SPX"]}

    series: dict[str, list[dict]] = {}
    report: list[str] = []

    for inst_id, rows in raw.items():
        aligned, filled = align_to_calendar(rows, calendar, spx_close, BETAS.get(inst_id, 1.0))
        compact = [
            {
                "date": r["date"],
                "open": round(r["open"], 2),
                "high": round(r["high"], 2),
                "low": round(r["low"], 2),
                "close": round(r["close"], 2),
                "volume": r["volume"],
            }
            for r in aligned
        ]
        series[inst_id] = compact
        gap_note = f"（回填 {filled} 天）" if filled else ""
        report.append(
            f"  ✓ {inst_id:<5} {len(compact):>4} 个交易日  "
            f"{compact[0]['date']} → {compact[-1]['date']}  {COVERED.get(SYMBOL_MAP[inst_id], '')}{gap_note}"
        )

    payload = {
        "version": 1,
        "source": "sina",
        "sourceNote": "新浪财经美股日 K。当前开发机在中国大陆，Yahoo/Stooq/FRED 均不可用。",
        "range": [START, END],
        "fetchedAt": date.today().isoformat(),
        "gapFillNote": "新浪个股历史存在缺口（如高盛缺 2007-01-03~2007-03-16）。"
        "缺失日按 beta × 标普收益回填，标记为 filled 的 K 线 volume 为 0。",
        "corporateActionsNote": "新浪返回未复权价格，拆股已按 CORPORATE_ACTIONS 处理，"
        "使序列连续且跨拆股的收益率与真实操作一致。",
        "series": series,
        "synthetic": SYNTHETIC,
    }

    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    size_kb = OUT.stat().st_size / 1024

    print("真实历史路径：")
    print("\n".join(report))
    if warnings:
        print()
        print("⚠ 未登记的巨幅跳变（可能是漏掉的公司行为）：")
        for w in warnings:
            print(f"  · {w}")
    print()
    print("合成路径（事件驱动，无真实数据）：")
    for k, v in SYNTHETIC.items():
        print(f"  · {k:<5} {v}")
    print()
    print(f"已写出 {OUT.relative_to(ROOT)}  （{size_kb:.0f} KB，{len(series)} 条序列，{len(calendar)} 个交易日）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
