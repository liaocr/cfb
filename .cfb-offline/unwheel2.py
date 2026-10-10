# -*- coding: utf-8 -*-
import zipfile, pathlib
w = pathlib.Path(r"D:\cfb\.cfb-offline\fla-core.whl")
z = zipfile.ZipFile(w)
names = [n for n in z.namelist() if "dplr" in n]
print("dplr entries:", len(names))
for n in names:
    print(" ", n, z.getinfo(n).file_size)
out = pathlib.Path(r"D:\cfb\.cfb-offline\_fla_core")
z.extractall(out)
print("extracted", len(z.namelist()), "->", out)
