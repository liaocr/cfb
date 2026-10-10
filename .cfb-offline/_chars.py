
# -*- coding: utf-8 -*-
import pathlib, unicodedata
P = pathlib.Path(r"C:\Users\Liaocr\AppData\Local\Temp\cfb-rwkv7-23_5exm1\kernel.py")
t = P.read_text(encoding="utf-8")
astral = [c for c in t if ord(c) > 0xFFFF]
print("python len (code points) =", len(t))
print("utf-16 code units        =", len(t) + len(astral))
print("astral chars             =", len(astral))
print("bytes (utf-8)            =", len(t.encode("utf-8")))
