import importlib.util, pathlib, tempfile, json, tarfile, io, unittest, hashlib
spec = importlib.util.spec_from_file_location('cache', pathlib.Path(__file__).parents[1] / 'scripts/prebootstrap/cache.py')
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
class CacheTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(); self.p=pathlib.Path(self.tmp.name); self.bundle=self.p/'bundle'; self.bundle.mkdir(); self.dest=self.p/'runtime'
  self.identity={'image':'sha256:abc','model':'m','revision':'r','config':'x','flags':'--tp 4','maxlen':'131072','gpu':'L40S','driver':'1'}
  self.archive('torch_compile_cache/rank/kernel',b'compiled')
 def tearDown(self): self.tmp.cleanup()
 def archive(self,name,data,link=False):
  with tarfile.open(self.bundle/'cache.tar','w') as t:
   x=tarfile.TarInfo(name);x.size=len(data)
   if link: x.type=tarfile.SYMTYPE;x.linkname='/etc/passwd';x.size=0
   t.addfile(x,io.BytesIO(data))
  (self.bundle/'manifest.json').write_text(json.dumps({'v':1,'identity':self.identity,'sha256':hashlib.sha256((self.bundle/'cache.tar').read_bytes()).hexdigest()}))
 def test_restore(self):
  c.restore(self.bundle,self.dest,self.identity)
  self.assertEqual((self.dest/'torch_compile_cache/rank/kernel').read_bytes(),b'compiled')
 def test_mismatch(self):
  with self.assertRaises(ValueError): c.restore(self.bundle,self.dest,{**self.identity,'driver':'2'})
  self.assertFalse(self.dest.exists())
 def test_hash(self):
  with (self.bundle/'cache.tar').open('ab') as f:f.write(b'corrupt')
  with self.assertRaises(ValueError):c.restore(self.bundle,self.dest,self.identity)
 def test_traversal(self):
  self.archive('../escape',b'bad')
  with self.assertRaises(ValueError):c.restore(self.bundle,self.dest,self.identity)
 def test_link(self):
  self.archive('torch_compile_cache/link',b'',True)
  with self.assertRaises(ValueError):c.restore(self.bundle,self.dest,self.identity)
if __name__=='__main__':unittest.main()
