
import importlib, io, sys
OUT = io.open(r"D:\cfb\.cfb-offline\_deps.txt","w",encoding="utf-8")
for m in ["tokenizers","transformers","torch","sentencepiece","numpy"]:
    try:
        mod = importlib.import_module(m)
        OUT.write("%-16s OK  %s\n" % (m, getattr(mod,"__version__","?")))
    except Exception as e:
        OUT.write("%-16s MISSING (%s)\n" % (m, type(e).__name__))
OUT.close(); print("ok")
