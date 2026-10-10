# -*- coding: utf-8 -*-
import zipfile, pathlib
w = pathlib.Path(r"D:\cfb\.cfb-offline\flash-linear-attention.whl")
print("wheel exists:", w.exists(), w.stat().st_size if w.exists() else None)
out = pathlib.Path(r"D:\cfb\.cfb-offline\_fla_whl")
z = zipfile.ZipFile(w)
names = [n for n in z.namelist() if "dplr" in n]
print("dplr entries:", len(names))
for n in names:
    print(" ", n, z.getinfo(n).file_size)
z.extractall(out)
print("extracted to", out)
