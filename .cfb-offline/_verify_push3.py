
# -*- coding: utf-8 -*-
import pathlib, re
t = pathlib.Path(r"D:\cfb\.cfb-offline\_kaggle-pull\cfb-rwkv7-compressor.py").read_text(encoding="utf-8")
m = re.search(r'if __name__ == "__main__":\s*.*', t, re.S)
print("--- 注入的入口（Kaggle 上那一份）---")
print(m.group(0).strip())
