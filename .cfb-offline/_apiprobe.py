
import json, io, urllib.request, urllib.error, time, os
OUT = io.open(r"D:\cfb\.cfb-offline\_apiprobe.txt", "w", encoding="utf-8")
def p(*a): OUT.write(" ".join(str(x) for x in a) + "\n")

KEY = os.environ.get("CFB_PROBE_KEY", "")
BASE = "https://a6api.com/v1"
p("base:", BASE)

def call(path, body, timeout=90):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, raw, time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), time.time() - t0
    except Exception as e:
        return None, repr(e), time.time() - t0

# 1) /models
st, raw, el = call("/models", {}, timeout=45) if False else (None, "", 0)

# 2) 最小 chat 调用
body = {"model": "deepseek-v4.1-flash",
        "messages": [{"role": "user", "content": "Reply with exactly one word: pong"}],
        "max_tokens": 16, "temperature": 0}
st, raw, el = call("/chat/completions", body)
p("")
p("=== chat/completions ===")
p("status:", st, " elapsed: %.1fs" % el)
p(raw[:2500])
OUT.close(); print("ok")
