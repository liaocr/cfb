# -*- coding: utf-8 -*-
import pathlib, re, kagglesdk
root = pathlib.Path(kagglesdk.__file__).parent
hits = []
for f in root.rglob("*.py"):
    t = f.read_text(encoding="utf-8", errors="replace")
    for m in re.finditer(r"(?i)\b(cancel|stop|terminate)\w*", t):
        line = t[: m.start()].count("\n") + 1
        hits.append((str(f.relative_to(root)), line, m.group(0)))
seen = set()
for h in hits:
    k = (h[0], h[2].lower())
    if k in seen:
        continue
    seen.add(k)
    print(h)
print("--- kernels service methods ---")
import importlib
for mod in ("kagglesdk.kernels.services.kernels_api_service",):
    try:
        m = importlib.import_module(mod)
        for n in dir(m):
            if "Service" in n:
                cls = getattr(m, n)
                print(n, [x for x in dir(cls) if not x.startswith("_")])
    except Exception as e:
        print("ERR", mod, repr(e))
