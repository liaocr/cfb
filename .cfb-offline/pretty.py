# -*- coding: utf-8 -*-
import json, pathlib
p = pathlib.Path(r"D:\cfb\.cfb-offline\live-stream.txt")
evs = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
out = []
for e in evs:
    t = e.get("time")
    s = e.get("stream_name", "?")
    d = e.get("data", "")
    out.append(f"[{t}] {s}: {d.rstrip()}")
pathlib.Path(r"D:\cfb\.cfb-offline\live-pretty.txt").write_text("\n".join(out), encoding="utf-8")
print("events", len(evs))
print("\n".join(out[:40]))
print("...")
print("\n".join(out[-6:]))
