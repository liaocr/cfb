import urllib.request, socket, sys
socket.setdefaulttimeout(20)
urls = {
  "hf-mirror api": "https://hf-mirror.com/api/models?limit=1",
  "hf-mirror resolve": "https://hf-mirror.com/api/models/Qwen/Qwen3-0.6B",
  "raw.githubusercontent": "https://raw.githubusercontent.com/liaocr/cfb/main/package.json",
  "pypi torch json": "https://pypi.org/pypi/torch/json",
  "pypi transformers json": "https://pypi.org/pypi/transformers/json",
  "datasets-server hf": "https://datasets-server.huggingface.co/valid",
}
for k, u in urls.items():
    try:
        r = urllib.request.urlopen(u)
        b = r.read(200)
        print(f"OK   {k:24} status={r.status} bytes={len(b)}")
    except Exception as e:
        print(f"FAIL {k:24} {type(e).__name__}: {str(e)[:90]}")