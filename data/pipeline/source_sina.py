#!/usr/bin/env python3
"""
数据源：新浪财经美股日 K。

## 为什么用这个源

当前开发机在中国大陆。实测：

| 源 | 结果 |
|---|---|
| Yahoo Finance | ❌ 全线 403 —— Yahoo 官方声明 2021-11-01 起中国大陆不可用 |
| Stooq CSV | ⚠️ 加了 SHA-256 工作量证明反爬 |
| FRED fredgraph.csv | ⚠️ 本机 HTTPS 超时 |
| 东方财富 push2his | ❌ 连接被重置 |
| **新浪财经美股** | ✅ **可用，且历史很长**（GS 可回溯到 1999 年） |

## 覆盖范围（实测）

- ✅ 指数：`.INX`（标普 500）、`.DJI`、`.IXIC`
- ✅ 存续机构：GS / JPM / C / AIG / MS / BAC
- ❌ 退市机构：LEH / BSC / FNM / FRE / CFC / IMB 一律没有

这个缺口恰好落在设计上可以接受的地方：**能拿到真实路径的正是活下来的机构，
拿不到的正是死掉的那些**——而后者的终局本来就应该由事件卡驱动
（docs/03 §1.1：基础历史路径 × 事件冲击）。

## ⚠️ 代码撞车

新浪按代码匹配，会返回同名的别的公司：

| 代码 | 实际返回 |
|---|---|
| `WM` | Waste Management（不是华盛顿互惠） |
| `WB` | 微博（不是瓦乔维亚） |
| `MER` | 某基金（不是美林） |

所以**必须用白名单**，不能凭代码猜。
"""

from __future__ import annotations

import json
import re
import urllib.request

UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Referer": "https://finance.sina.com.cn",
}

_URL = (
    "https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/x/"
    "US_MinKService.getDailyK?symbol={sym}&___qn=3"
)

# 白名单：只认这些代码。每一条都写清它对应哪家机构，避免代码撞车。
COVERED: dict[str, str] = {
    ".INX": "标普 500 指数",
    ".DJI": "道琼斯工业指数",
    ".IXIC": "纳斯达克综合指数",
    "GS": "高盛",
    "MS": "摩根士丹利",
    "JPM": "摩根大通",
    "C": "花旗集团",
    "AIG": "美国国际集团",
    "BAC": "美国银行",
}

# 明确拿不到、必须走合成路径的标的
UNCOVERED: dict[str, str] = {
    "LEH": "雷曼兄弟（2008 破产退市）",
    "BSC": "贝尔斯登（2008 被收购）",
    "MER": "美林证券（2009 被收购）",
    "WM": "华盛顿互惠（2008 被接管）",
    "FNM": "房利美（2010 退市）",
    "FRE": "房地美（2010 退市）",
    "CFC": "Countrywide",
    "IMB": "IndyMac",
}

# 已知会撞车的代码：即使数据能取到也不许用
COLLISIONS: dict[str, str] = {
    "WM": "Waste Management",
    "WB": "微博 (Weibo)",
    "MER": "同名基金",
}


def fetch_daily(symbol: str, timeout: int = 40) -> list[dict]:
    """取日线。返回 [{date, open, high, low, close, volume}, ...]，按日期升序。"""
    req = urllib.request.Request(_URL.format(sym=symbol), headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "replace")

    m = re.search(r"\(\s*(\[.*\])\s*\)\s*;?\s*$", raw, re.S)
    if not m:
        # 容错：可能没有结尾分号
        m = re.search(r"\(\s*(\[.*\])\s*\)", raw, re.S)
    if not m:
        return []

    try:
        rows = json.loads(m.group(1))
    except json.JSONDecodeError:
        return []

    out: list[dict] = []
    for r in rows:
        try:
            out.append(
                {
                    "date": r["d"],
                    "open": float(r["o"]),
                    "high": float(r["h"]),
                    "low": float(r["l"]),
                    "close": float(r["c"]),
                    "volume": int(float(r.get("v") or 0)),
                }
            )
        except (KeyError, TypeError, ValueError):
            continue
    out.sort(key=lambda x: x["date"])
    return out


if __name__ == "__main__":
    for sym in [".INX", "GS", "JPM", "AIG"]:
        rows = fetch_daily(sym)
        print(f"{sym}: {len(rows)} 行  {rows[0]['date']} → {rows[-1]['date']}" if rows else f"{sym}: 无数据")
