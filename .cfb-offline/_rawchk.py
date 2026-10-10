import urllib.request
req = urllib.request.Request('https://raw.githubusercontent.com/liaocr/cfb/main/deploy/kaggle/train_rwkv7.py', headers={'User-Agent':'M'})
t = urllib.request.urlopen(req, timeout=60).read().decode('utf-8')
print('len', len(t))
for probe in ['DEFAULT_MAX_LEN = 6144', '相对路径落到脚本目录', '找不到数据文件', 'sm_70']:
    print('%-28s %s' % (probe, 'OK' if probe in t else 'MISSING'))