# -*- coding: utf-8 -*-
import urllib.request
BASE = 'https://raw.githubusercontent.com/liaocr/cfb/main'
for p in ['/deploy/kaggle/train_rwkv7.py', '/deploy/kaggle/start-rwkv7.py', '/deploy/kaggle/data/sft-train.jsonl', '/deploy/kaggle/data/sft-dev.jsonl']:
    try:
        req = urllib.request.Request(BASE + p, headers={'User-Agent':'M'})
        r = urllib.request.urlopen(req, timeout=60)
        b = r.read()
        print('%-42s %s  %8d bytes' % (p, r.status, len(b)))
    except Exception as e:
        print('%-42s FAILED %r' % (p, e))