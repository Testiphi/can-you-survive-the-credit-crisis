#!/usr/bin/env python3
"""
从事件卡 JSON 生成 Markdown 时间线表。

用法:
  python tools/gen_timeline.py            # 输出到 stdout
  python tools/gen_timeline.py --write    # 写回 docs/06-事件卡目录.md 的标记区
  python tools/gen_timeline.py --check    # 检查文档中的表是否与数据一致（CI 用）

文档中需要存在这一对标记：
  <!-- BEGIN TIMELINE -->
  <!-- END TIMELINE -->
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EVENT_DIR = ROOT / "data" / "events"
CATALOG = ROOT / "docs" / "06-事件卡目录.md"

BEGIN = "<!-- BEGIN TIMELINE -->"
END = "<!-- END TIMELINE -->"

FLAGS = [
    ("isSystemicEvent", "★"),
    ("isTrap", "陷阱"),
    ("isReversal", "反转"),
    ("isBottom", "底部"),
    ("isScorecard", "记分"),
]

TIER_LABEL = {
    "macro": "宏观",
    "policy": "政策",
    "funding": "融资",
    "investment_bank": "投行",
    "commercial_bank": "银行",
    "insurer": "保险",
    "gse": "两房",
    "overseas": "海外",
}

# 跨层展示顺序（表格内先按日期排序，同日按此顺序）
TIER_ORDER = list(TIER_LABEL)


def load_events() -> list[dict]:
    events: list[dict] = []
    for path in sorted(EVENT_DIR.glob("events-*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        events.extend(data.get("events", []))
    events.sort(key=lambda e: (e["date"], TIER_ORDER.index(e["tier"]), e["id"]))
    return events


def render_table(events: list[dict]) -> str:
    lines = ["| 日期 | 事件 ID | 标题 | 分层 | 标志 |", "|---|---|---|---|---|"]
    for ev in events:
        flags = " ".join(label for key, label in FLAGS if ev.get(key))
        if ev.get("trigger", {}).get("modeOnly") == "parallel":
            flags = (flags + " 平行").strip()
        lines.append(
            f"| {ev['date']} | `{ev['id']}` | {ev['title']} | "
            f"{TIER_LABEL.get(ev['tier'], ev['tier'])} | {flags} |"
        )
    return "\n".join(lines)


def stats(events: list[dict]) -> str:
    by_year: dict[str, int] = {}
    by_tier: dict[str, int] = {}
    for ev in events:
        by_year[ev["date"][:4]] = by_year.get(ev["date"][:4], 0) + 1
        by_tier[ev["tier"]] = by_tier.get(ev["tier"], 0) + 1
    year_str = " · ".join(f"{y}: {n}" for y, n in sorted(by_year.items()))
    tier_str = " · ".join(f"{TIER_LABEL.get(t, t)} {n}" for t, n in sorted(by_tier.items()))
    return f"{len(events)} 张（{year_str}）\n\n分层分布：{tier_str}"


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    events = load_events()
    table = render_table(events)

    if mode == "--write":
        if not CATALOG.exists():
            print(f"ERROR: 未找到 {CATALOG}", file=sys.stderr)
            return 1
        text = CATALOG.read_text(encoding="utf-8")
        if BEGIN not in text or END not in text:
            print(f"ERROR: {CATALOG.name} 缺少标记 {BEGIN} / {END}", file=sys.stderr)
            return 1
        head, rest = text.split(BEGIN, 1)
        _, tail = rest.split(END, 1)
        new_text = f"{head}{BEGIN}\n\n{table}\n\n{END}{tail}"
        if new_text == text:
            print(f"无需更新，表已是最新（{len(events)} 张卡）")
            return 0
        CATALOG.write_text(new_text, encoding="utf-8")
        print(f"已写回 {CATALOG.relative_to(ROOT)}（{len(events)} 张卡）")
        return 0

    if mode == "--check":
        if not CATALOG.exists():
            print("ERROR: 未找到目录文档", file=sys.stderr)
            return 1
        text = CATALOG.read_text(encoding="utf-8")
        _, rest = text.split(BEGIN, 1)
        current, _ = rest.split(END, 1)
        if current.strip() != table.strip():
            print("ERROR: 文档中的时间线表与数据集不一致，请运行 --write", file=sys.stderr)
            return 1
        print(f"时间线表与数据集一致（{len(events)} 张卡）")
        return 0

    print(table)
    print()
    print(stats(events))
    return 0


if __name__ == "__main__":
    sys.exit(main())
