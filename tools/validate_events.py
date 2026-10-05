#!/usr/bin/env python3
"""
事件卡数据集校验器。

实现 docs/05-事件系统与危机排序机制.md §8 中定义的校验规则：
  1. JSON 可解析
  2. ID 全局唯一
  3. requires / requireAnyOf / unlocks 引用全部可解析
  4. 因果 DAG 无环
  5. window 合法，且 date 落在 window 内
  6. 必备字段齐全
  7. impact 数值在边界内
  8. 分层约束：gse / insurer 层不得早于投行/银行层的首个失败事件

用法: python tools/validate_events.py
退出码: 0 = 全部通过, 1 = 存在错误
"""

from __future__ import annotations

import json
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EVENT_DIR = ROOT / "data" / "events"

# 允许出现在 requireAnyOf / requires 里的状态谓词（非事件 id）
PREDICATE_PATTERNS = [
    re.compile(r"^credit_spread_above_\d+$"),
    re.compile(r"^player_short_concentration_[A-Z]+_above_\d+pct$"),
    re.compile(r"^vix_above_\d+$"),
    re.compile(r"^ted_spread_above_[\d.]+$"),
    re.compile(r"^liquidity_below_[\d.]+$"),
    re.compile(r"^srs_above_[\d.]+$"),
]

REQUIRED_FIELDS = ["id", "phase", "date", "title", "headline", "narrative", "window", "trigger", "tier", "impact"]

VALID_TRIGGER_TYPES = {"scheduled", "competing_risk", "state"}
VALID_TIERS = {
    "macro",
    "policy",
    "funding",          # 回购 / 融资机制，见 docs/07
    "investment_bank",
    "commercial_bank",
    "insurer",
    "gse",
    "overseas",
}

# impact 边界
MAX_ABS_INDEX_RETURN = 0.25


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)


def is_predicate(token: str) -> bool:
    return any(p.match(token) for p in PREDICATE_PATTERNS)


def load_events(report: Report) -> list[dict]:
    events: list[dict] = []
    files = sorted(EVENT_DIR.glob("events-*.json"))
    if not files:
        report.error(f"未找到任何事件文件于 {EVENT_DIR}")
        return events

    for path in files:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            report.error(f"{path.name}: JSON 解析失败 — {exc}")
            continue
        for ev in data.get("events", []):
            ev["__source__"] = path.name
            events.append(ev)
    return events


def check_fields_and_enums(events: list[dict], report: Report) -> None:
    for ev in events:
        eid = ev.get("id", "<无 id>")
        for field in REQUIRED_FIELDS:
            if field not in ev:
                report.error(f"[{eid}] 缺少必备字段: {field}")

        trig = ev.get("trigger", {})
        ttype = trig.get("type")
        if ttype not in VALID_TRIGGER_TYPES:
            report.error(f"[{eid}] 非法 trigger.type: {ttype!r}")

        tier = ev.get("tier")
        if tier not in VALID_TIERS:
            report.error(f"[{eid}] 非法 tier: {tier!r}")

        impact = ev.get("impact", {})
        idx = impact.get("indexReturn", 0)
        if abs(idx) > MAX_ABS_INDEX_RETURN:
            report.error(f"[{eid}] indexReturn={idx} 超出 ±{MAX_ABS_INDEX_RETURN} 边界")


def check_unique_ids(events: list[dict], report: Report) -> set[str]:
    seen: dict[str, str] = {}
    for ev in events:
        eid = ev.get("id")
        if eid is None:
            continue
        if eid in seen:
            report.error(f"ID 重复: {eid}（出现在 {seen[eid]} 与 {ev['__source__']}）")
        seen[eid] = ev["__source__"]
    return set(seen)


def check_references(events: list[dict], ids: set[str], report: Report) -> None:
    for ev in events:
        eid = ev["id"]
        for field in ("requires", "unlocks"):
            for ref in ev.get(field, []) or []:
                if ref not in ids and not is_predicate(ref):
                    report.error(f"[{eid}] {field} 引用了不存在的 id: {ref}")
        for group in ev.get("requireAnyOf", []) or []:
            if not isinstance(group, list):
                report.error(f"[{eid}] requireAnyOf 的元素必须是数组")
                continue
            for ref in group:
                if ref not in ids and not is_predicate(ref):
                    report.error(f"[{eid}] requireAnyOf 引用了不存在的 id: {ref}")
        for ref in ev.get("exclusiveWith", []) or []:
            if ref not in ids:
                report.error(f"[{eid}] exclusiveWith 引用了不存在的 id: {ref}")


def check_windows(events: list[dict], report: Report) -> None:
    for ev in events:
        eid = ev["id"]
        window = ev.get("window")
        if not isinstance(window, list) or len(window) != 2:
            report.error(f"[{eid}] window 必须是长度为 2 的数组")
            continue
        try:
            lo = date.fromisoformat(window[0])
            hi = date.fromisoformat(window[1])
            d = date.fromisoformat(ev["date"])
        except (ValueError, TypeError) as exc:
            report.error(f"[{eid}] 日期解析失败: {exc}")
            continue
        if lo > hi:
            report.error(f"[{eid}] window 起点晚于终点: {window}")
        if not (lo <= d <= hi):
            report.error(f"[{eid}] date={ev['date']} 不在 window {window} 之内")


def check_acyclic(events: list[dict], report: Report) -> None:
    """对 requires + requireAnyOf 中的事件引用做拓扑排序。"""
    ids = {ev["id"] for ev in events}
    deps: dict[str, set[str]] = {}
    for ev in events:
        edges: set[str] = set()
        for ref in ev.get("requires", []) or []:
            if ref in ids:
                edges.add(ref)
        for group in ev.get("requireAnyOf", []) or []:
            for ref in group:
                if ref in ids:
                    edges.add(ref)
        deps[ev["id"]] = edges

    WHITE, GRAY, BLACK = 0, 1, 2
    color = {n: WHITE for n in deps}
    stack_path: list[str] = []

    def visit(node: str) -> bool:
        color[node] = GRAY
        stack_path.append(node)
        for dep in deps.get(node, ()):
            if color[dep] == GRAY:
                cycle = " → ".join(stack_path[stack_path.index(dep):] + [dep])
                report.error(f"检测到因果环: {cycle}")
                return False
            if color[dep] == WHITE and not visit(dep):
                return False
        stack_path.pop()
        color[node] = BLACK
        return True

    for node in deps:
        if color[node] == WHITE:
            if not visit(node):
                return


def check_tier_ordering(events: list[dict], report: Report) -> None:
    """
    分层约束：gse / insurer 层的首个事件不得早于投行层或银行层的首个失败事件。
    这是「传染必须有源头」的物理约束。
    """
    def earliest_after(tiers: set[str]) -> date | None:
        dates = [
            date.fromisoformat(ev["date"])
            for ev in events
            if ev.get("tier") in tiers and ev.get("isSystemicEvent")
        ]
        return min(dates) if dates else None

    upstream = earliest_after({"investment_bank", "commercial_bank"})
    if upstream is None:
        report.warn("未找到投行/银行层的系统性事件，跳过分层时序校验")
        return

    for tier in ("gse", "insurer"):
        downstream = earliest_after({tier})
        if downstream is not None and downstream < upstream:
            report.error(
                f"分层约束违规：{tier} 层最早事件 {downstream} 早于 "
                f"投行/银行层最早事件 {upstream}"
            )


def summarize(events: list[dict]) -> None:
    by_year: dict[str, int] = {}
    by_tier: dict[str, int] = {}
    systemic = 0
    traps = 0
    for ev in events:
        by_year[ev["date"][:4]] = by_year.get(ev["date"][:4], 0) + 1
        by_tier[ev["tier"]] = by_tier.get(ev["tier"], 0) + 1
        if ev.get("isSystemicEvent"):
            systemic += 1
        if ev.get("isTrap"):
            traps += 1

    print(f"事件总数        : {len(events)}")
    print(f"系统性事件      : {systemic}")
    print(f"陷阱事件        : {traps}")
    print("按年份          : " + ", ".join(f"{y}={n}" for y, n in sorted(by_year.items())))
    print("按分层          : " + ", ".join(f"{t}={n}" for t, n in sorted(by_tier.items())))


def main() -> int:
    report = Report()
    events = load_events(report)
    if not events:
        for e in report.errors:
            print(f"ERROR  {e}")
        return 1

    check_fields_and_enums(events, report)
    ids = check_unique_ids(events, report)
    check_references(events, ids, report)
    check_windows(events, report)
    check_acyclic(events, report)
    check_tier_ordering(events, report)

    print("=" * 64)
    print("事件卡数据集校验")
    print("=" * 64)
    summarize(events)
    print("-" * 64)

    for w in report.warnings:
        print(f"WARN   {w}")
    for e in report.errors:
        print(f"ERROR  {e}")

    print("-" * 64)
    if report.errors:
        print(f"结果: 失败（{len(report.errors)} 个错误, {len(report.warnings)} 个警告）")
        return 1
    print(f"结果: 通过（0 个错误, {len(report.warnings)} 个警告）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
