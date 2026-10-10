
# -*- coding: utf-8 -*-
# Stage 1 探针：向教师模型要 10 份压缩稿，量过尺率与真实花费。
# 目标不是产出训练集，是回答「这个任务教师做不做得动」。
import io, json, os, re, time, urllib.request, urllib.error

ENVF = r"C:\Users\Liaocr\.secrets\keys.env"
env = {}
for l in io.open(ENVF, encoding="utf-8"):
    l = l.strip()
    if not l or l.startswith("#") or "=" not in l: continue
    k, v = l.split("=", 1); env[k.strip()] = v.strip()
KEY, BASE, MODEL = env["DEEPSEEK_API_KEY"], env["DEEPSEEK_BASE_URL"], env["DEEPSEEK_MODEL"]

OUT = io.open(r"D:\cfb\.cfb-offline\_stage1.txt", "w", encoding="utf-8")
def p(*a): OUT.write(" ".join(str(x) for x in a) + "\n")
RAWOUT = io.open(r"D:\cfb\.cfb-offline\_stage1_drafts.jsonl", "w", encoding="utf-8")

SYSTEM = """你是思维链压缩器。用户会给你一次真实软件工程任务的题面与当时模型写下的完整思考过程（英文）。
请把那段思考压成一份**中文压缩稿**，供后续模型直接阅读以继续任务。

硬要求：
1) 保留所有承重的事实、结论、决定、落点、验收依据；删掉探索过程、重复、已被推翻的猜测。
2) 引用原文时必须是**真的逐字**，用「」包裹；不确定是否逐字就改写、不要加引号。
3) 必须写清「落点」——要动手改的那个文件路径，且必须是原文里确实在讨论要改的那个文件；不要用报错信息里出现的路径充数。
4) 不许编造原文与题面里都没有的文件名、命令、标识符、数字。
5) 长度不超过原文的 55%。

直接输出压缩稿，不要前言、不要解释。"""

def call(messages, max_tokens=1600, timeout=180):
    body = {"model": MODEL, "messages": messages, "max_tokens": max_tokens, "temperature": 0.2}
    req = urllib.request.Request(BASE + "/chat/completions", data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            j = json.loads(r.read().decode("utf-8", "replace"))
            return j, time.time() - t0, None
    except urllib.error.HTTPError as e:
        return None, time.time() - t0, "HTTP %s %s" % (e.code, e.read()[:300])
    except Exception as e:
        return None, time.time() - t0, repr(e)[:300]

sl = [json.loads(l) for l in io.open(r"D:\cfb\.cfb-offline\ruler\raw-mine-shortlist.jsonl", encoding="utf-8") if l.strip()]
# 取分布靠中、且彼此不同仓库的 10 条
import collections
seen = set(); picks = []
for o in sl:
    if o["repository"] in seen: continue
    if not (2000 <= o["rawChars"] <= 5000): continue
    seen.add(o["repository"]); picks.append(o)
    if len(picks) >= 10: break
p("探针单元数 =", len(picks))
p("")

results = []
total_cost = 0.0
total_tok = 0
t_start = time.time()
for i, o in enumerate(picks, 1):
    user = "[题面]\n" + o["ctx"] + "\n\n[思考过程]\n" + o["raw"] + "\n\n请输出中文压缩稿。"
    j, el, err = call([{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}])
    if err:
        p("[%2d] %-42s ERROR %s" % (i, o["unitId"][:42], err)); continue
    msg = j["choices"][0]["message"]
    draft = (msg.get("content") or "").strip()
    u = j.get("usage") or {}
    cost = u.get("cost", 0) or 0
    total_cost += cost; total_tok += u.get("total_tokens", 0)
    results.append({"unitId": o["unitId"], "repository": o["repository"], "raw": o["raw"], "ctx": o["ctx"], "draft": draft})
    RAWOUT.write(json.dumps({"id": o["unitId"], "family": o["repository"], "raw": o["raw"], "ctx": o["ctx"], "draft": draft}, ensure_ascii=False) + "\n")
    p("[%2d] %-42s %5.1fs  raw=%d draft=%d  tok=%s cost=%.6f" % (
        i, o["unitId"][:42], el, len(o["raw"]), len(draft), u.get("total_tokens"), cost))
    p("     稿：%s" % draft.replace("\n", " / ")[:300])
p("")
p("=== 合计 ===")
p("  成功 %d / %d   用时 %.1fs   总 token %d   总花费 $%.6f" % (len(results), len(picks), time.time() - t_start, total_tok, total_cost))
p("  单条均摊 $%.6f  => 3000 条约 $%.2f" % (total_cost / max(1, len(results)), total_cost / max(1, len(results)) * 3000))
OUT.close(); RAWOUT.close(); print("ok")
