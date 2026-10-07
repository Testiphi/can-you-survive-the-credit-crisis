"""Build a bounded early-2007 OHLC correction, without rewriting the legacy market file."""
from __future__ import annotations
import argparse, datetime, json, statistics, urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SYMBOLS=('GS','MS','AIG','C','JPM')
PRICE_SCALE={'GS':1.0,'MS':None,'AIG':1.0,'C':0.1,'JPM':1.0}
VOLUME_SCALE={'GS':1,'MS':1,'AIG':20,'C':10,'JPM':1}

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--cache-dir',type=Path);parser.add_argument('--write',action='store_true');args=parser.parse_args()
 market=json.loads((ROOT/'data/processed/market.json').read_text(encoding='utf-8'))
 expected=[b['date'] for b in market['series']['SPX'] if '2007-01-03'<=b['date']<='2007-03-16']
 assert len(expected)==51
 out={'version':1,'source':'Yahoo Finance chart API','range':['2007-01-03','2007-03-16'],'sourceNote':'仅替换原缺口；价格和成交量统一到既有序列口径。MS价格缩放以5日重叠样本中位数确定；原始提供商成交量统计差异不逐日拟合。','scales':{},'series':{}}
 start=int(datetime.datetime(2007,1,1,tzinfo=datetime.timezone.utc).timestamp());end=int(datetime.datetime(2007,3,24,tzinfo=datetime.timezone.utc).timestamp())
 for symbol in SYMBOLS:
  url=f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?period1={start}&period2={end}&interval=1d'
  if args.cache_dir:
   rows=json.loads((args.cache_dir/f'credit-ohlc-{symbol}.json').read_text(encoding='utf-8'))
  else:
   result=json.load(urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'}),timeout=20))['chart']['result'][0]
   assert result['meta']['symbol']==symbol
   q=result['indicators']['quote'][0]
   rows=[{'date':datetime.datetime.fromtimestamp(t,datetime.timezone.utc).date().isoformat(),**{k:q[k][i] for k in ('open','high','low','close','volume')}} for i,t in enumerate(result['timestamp'])]
  old={b['date']:b for b in market['series'][symbol]}
  overlap=[b for b in rows if '2007-03-19'<=b['date']<='2007-03-23'];assert len(overlap)==5
  factor=PRICE_SCALE[symbol] or statistics.median(old[b['date']]['close']/b['close'] for b in overlap)
  error=max(abs(old[b['date']][key]/(b[key]*factor)-1) for b in overlap for key in ('open','high','low','close'))
  assert error<0.001,(symbol,'price basis mismatch',error)
  volume_factor=VOLUME_SCALE[symbol]
  assert abs(statistics.median(old[b['date']]['volume']/b['volume'] for b in overlap)/volume_factor-1)<0.005
  patch=[]
  for row in rows:
   if row['date'] not in expected:continue
   previous=old[row['date']];assert previous['volume']==0 and len({previous[k] for k in ('open','high','low','close')})==1
   b={'date':row['date'],**{k:round(row[k]*factor,2) for k in ('open','high','low','close')},'volume':round(row['volume']*volume_factor)}
   assert 0<b['low']<=min(b['open'],b['close'])<=max(b['open'],b['close'])<=b['high'] and b['volume']>0
   patch.append(b)
  assert sorted(b['date'] for b in patch)==expected
  out['series'][symbol]=patch
  out['scales'][symbol]={'price':factor,'volume':volume_factor,'overlapMaxPriceError':error,'sourceUrl':url}
  print(symbol,len(patch),'price scale',factor,'volume scale',volume_factor,'overlap price error',error)
 if args.write:
  dest=ROOT/'data/processed/early-ohlc.json';dest.write_text(json.dumps(out,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8');print('wrote',dest)
if __name__=='__main__':main()
