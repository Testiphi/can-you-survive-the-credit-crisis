"""Build the isolated Q2 pack from cached Yahoo responses and frozen macro CSV.

python data/pipeline/build_2010_q2.py --raw-dir <directory containing SPX.json etc.>
Raw Yahoo chart query: period1=1261440000, period2=1277942400, interval=1d.
The cache should include Dec 22–31 2009 for split-unit overlap checks.
No downloads or substitutions happen during a normal build/CI run.
"""
import argparse
import csv
import json
import math
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PACK = ROOT / 'data/packs/2010-q2-v1'
SYMBOLS = {'SPX': '^GSPC', 'GS': 'GS', 'MS': 'MS', 'JPM': 'JPM', 'C': 'C', 'AIG': 'AIG'}


def build(raw_dir: Path):
    legacy = json.loads((ROOT / 'data/processed/market.json').read_text(encoding='utf-8'))
    series = {}
    for ticker, symbol in SYMBOLS.items():
        result = json.loads((raw_dir / f'{ticker}.json').read_text(encoding='utf-8'))['chart']['result'][0]
        assert result['meta']['symbol'] == symbol, f'{ticker}: wrong source symbol'
        quote = result['indicators']['quote'][0]
        price_scale, volume_scale = (0.1, 10) if ticker == 'C' else (1, 1)
        old = {b['date']: b for b in legacy['series'][ticker]}
        rows, overlap, dates = [], 0, set()
        for i, timestamp in enumerate(result['timestamp']):
            date = datetime.fromtimestamp(timestamp, timezone.utc).date().isoformat()
            assert date not in dates, f'{ticker}: duplicate {date}'
            dates.add(date)
            row = {'date': date, **{k: round(quote[k][i] * price_scale, 6) for k in ('open', 'high', 'low', 'close')},
                   'volume': round(quote['volume'][i] * volume_scale)}
            assert all(math.isfinite(row[k]) and row[k] > 0 for k in ('open', 'high', 'low', 'close', 'volume'))
            assert row['low'] <= min(row['open'], row['close']) <= max(row['open'], row['close']) <= row['high']
            if date in old:
                # Provider close differences are up to 0.52%; verify units, not equality of feeds.
                assert abs(row['close'] / old[date]['close'] - 1) < 0.01, f'{ticker}: split units mismatch'
                overlap += 1
            if '2010-04-01' <= date <= '2010-06-30':
                rows.append(row)
        assert overlap == 7, f'{ticker}: missing overlap evidence'
        assert len(rows) == 63 and rows == sorted(rows, key=lambda b: b['date'])
        series[ticker] = rows
    expected = [b['date'] for b in series['SPX']]
    assert all([b['date'] for b in rows] == expected for rows in series.values())
    market = {'version': 1, 'source': 'Yahoo Finance chart API',
              'sourceNote': '真实日线 OHLC（未使用 adjclose）；C 价格 ×0.1、成交量 ×10，以延续旧游戏拆股单位；其余 ×1。',
              'range': ['2010-04-01', '2010-06-30'], 'series': series, 'synthetic': {}}
    macro = []
    with (PACK / 'macro-observations.csv').open(encoding='utf-8', newline='') as handle:
        for row in csv.DictReader(handle):
            macro.append({'date': row['date'], 'vix': float(row['vix']), 'tedSpread': float(row['tedSpread']), 'tedAsOf': row['tedAsOf']})
    assert [m['date'] for m in macro] == expected
    for name, value in [('market.json', market), ('macro.json', macro)]:
        (PACK / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw-dir', required=True, type=Path)
    build(parser.parse_args().raw_dir)
