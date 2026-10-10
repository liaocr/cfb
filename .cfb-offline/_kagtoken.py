# -*- coding: utf-8 -*-
import os, pathlib, stat
d = pathlib.Path(os.path.expanduser('~')) / '.kaggle'
d.mkdir(parents=True, exist_ok=True)
p = d / 'access_token'
p.write_text('KGAT_711e5699f2f808ce91d476beeeaf000f', encoding='utf-8')
try: os.chmod(p, 0o600)
except Exception: pass
print('written:', p, '| bytes', p.stat().st_size)
# 顺带写一份 kaggle.json（老式 CLI 只认这个；username 待认证后补）
print('dir:', [x.name for x in d.iterdir()])