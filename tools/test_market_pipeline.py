import unittest, sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'data/pipeline'))
from build_market import align_to_calendar
class BackfillTests(unittest.TestCase):
 def test_backward_fill_uses_forward_return_not_its_inverse(self):
  rows=[{'date':'2007-03-19','open':100,'high':101,'low':99,'close':100,'volume':100}]
  result,count=align_to_calendar(rows,['2007-03-16','2007-03-19'],{'2007-03-16':90,'2007-03-19':100},1)
  self.assertEqual(count,1);self.assertEqual(result[0]['close'],90)
  self.assertTrue(result[0]['filled']);self.assertEqual(result[0]['volume'],0)
  self.assertEqual(result[1],rows[0])
if __name__=='__main__':unittest.main()
