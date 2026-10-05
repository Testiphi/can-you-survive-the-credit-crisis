#!/usr/bin/env python3
"""探测新浪美股接口对各标的的覆盖情况（尤其是退市股与指数）。"""

from __future__ import annotations

import json
import re
import urllib.request

UA = {"User-Agent": "Mozilla/5.0", "Referer": "https://finance.sina.com.cn"}

URL = "https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/x/US_MinKService.getDailyK?symbol={sym}&___qn=3"

CANDIDATES = [
    ("GS", "高盛（NYFE 存续）"),
    ("JPM", "摩根大通（存续）"),
    ("C", "花旗（存续）"),
    ("AIG", "AIG（存续）"),
    ("MS", "摩根士丹利（存续）"),
    ("BAC", "美国银行（存续）"),
    ("LEH", "雷曼兄弟（2008 破产退市）"),
    ("LEHMQ", "雷曼粉单代码"),
    ("BSC", "贝尔斯登（2008 被收购）"),
    ("MER", "美林（2009 被收购）"),
    ("WM", "华盛顿互惠（2008 被接管）"),
    ("WB", "瓦乔维亚（2008 被收购）"),
    ("FNM", "房利美（2010 退市）"),
    ("FRE", "房地美（2010 退市）"),
    ("CFC", "Countrywide（2008 被收购）"),
    ("IMB", "IndyMac"),
    (".INX", "标普 500 指数"),
    ("SPX", "标普 500（另一种写法）"),
    (".VIX", "VIX 指数"),
    ("^VIX", "VIX（另一种写法）"),
    (".DJI", "道琼斯"),
    (".IXIC", "纳斯达克"),
]


def fetch(sym: str) -> list[dict]:
    req = urllib.request.Request(URL.format(sym=sym), headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode("utf-8", "replace")
    m = re.search(r"\(\s*(\[.*\])\s*\)", raw, re.S)
    if not m:
        return []
    return json.loads(m.group(1))


print(f"{'代码':<10} {'行数':>7}  {'起':<12} {'止':<12} 说明")
print("-" * 78)
for sym, note in CANDIDATES:
    try:
        rows = fetch(sym)
        if rows:
            print(f"{sym:<10} {len(rows):>7}  {rows[0]['d']:<12} {rows[-1]['d']:<12} {note}")
        else:
            print(f"{sym:<10} {0:>7}  {'-':<12} {'-':<12} {note}")
    except Exception as e:  # noqa: BLE001
        print(f"{sym:<10} {'ERR':>7}  {str(e)[:44]:<12} {note}")
