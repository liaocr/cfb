
# -*- coding: utf-8 -*-
"""对比两轮训练：旧数据（v10）vs 新数据（v11）。

零 GPU 成本 —— 两轮的生成稿都在本地，这里只做重打分。

**判读规则在看数据之前写死。** 用户的问题是「看看问题有没有解决」，
而这里的问题特指 v10 的**过拟合**（train loss 0.0006 / dev loss 3.4794，差 5800 倍）。
所以判据围绕过拟合：

  过拟合已解决 <=> 同时满足两条：
    (1) 训练/验证损失差距**显著收窄**：dev/train 比值从 v10 的极值降到 < 10；
    (2) dev 上有受力点的过门率**不降**：新数据 >= 旧数据（同 89 条冻结 dev，gen-ruler/5 重算）。
  只满足 (1) 不满足 (2) => 「过拟合没了，但也没学会」—— 那是**欠训**，处方相反。
  只满足 (2) 不满足 (1) => 「分数好看了，但泛化没改善」—— 要查是不是 dev 泄漏。

不判定：两轮的 dev 不是同一批单元（必须查 id 集合），直接报错退出。
"""
import io, json, os, subprocess, sys

ROOT = r"D:\cfb"
OLD = r"D:\cfb\.cfb-offline\kaggle-out\v10"
NEW = r"D:\cfb\.cfb-offline\kaggle-out\v11"

def rd(p):
    rows = []
    with io.open(p, encoding="utf-8") as f:
        for l in f:
            l = l.strip()
            if l:
                rows.append(json.loads(l))
    return rows

def score(gen_file, label, outdir):
    out = os.path.join(outdir, "eval-%s.json" % label)
    r = subprocess.run(["node", "tools/eval-sft.mjs", "--sft", ".cfb-offline/sft",
                        "--gen", gen_file, "--out", out],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        sys.stderr.write(r.stderr or "")
        return None
    return json.load(io.open(out, encoding="utf-8"))

def curve(d):
    p = os.path.join(d, "learning-curve.json")
    return json.load(io.open(p, encoding="utf-8")) if os.path.exists(p) else None

def devids(d):
    p = os.path.join(d, "dev-generations.jsonl")
    return [o["id"] for o in rd(p)] if os.path.exists(p) else None

def main():
    print("=" * 74)
    print("旧数据 v10  vs  新数据 v11")
    print("=" * 74)

    io_ = devids(OLD); in_ = devids(NEW)
    if io_ is None or in_ is None:
        print("缺 dev-generations.jsonl（旧 %s / 新 %s），无法对比" % (io_ is None, in_ is None))
        return 1
    if set(io_) != set(in_):
        print("FATAL: 两轮 dev 不是同一批单元 —— 旧 %d 条、新 %d 条，交集 %d 条。"
              % (len(io_), len(in_), len(set(io_) & set(in_))))
        print("       dev 没冻住的话，下面的对比全部无意义。先查 --dev-ids。")
        return 1
    print("dev 单元：两轮同为 %d 条，逐 id 相同 ✓" % len(io_))

    co, cn = curve(OLD), curve(NEW)
    if co and cn:
        print("\n--- 训练器记录的损失（过拟合的直接读数）---")
        print("%-8s %-22s %-22s" % ("step", "v10 旧数据", "v11 新数据"))
        m = {p["step"]: p for p in cn}
        for p in co:
            q = m.get(p["step"], {})
            print("%-8s train %-8s dev %-9s | train %-8s dev %-9s" % (
                p["step"], p.get("trainLoss"), p.get("devLoss"),
                q.get("trainLoss"), q.get("devLoss")))
        fo = co[-1].get("devLoss"); to = co[-1].get("trainLoss")
        fn = cn[-1].get("devLoss"); tn = cn[-1].get("trainLoss")
        if fo and to and fn and tn:
            print("\n最终 dev/train 比：v10 %.0f  ->  v11 %.0f" % (fo / max(to, 1e-9), fn / max(tn, 1e-9)))

    res = {}
    for name, d in (("v10 旧数据", OLD), ("v11 新数据", NEW)):
        g = os.path.join(d, "dev-generations.jsonl")
        if not os.path.exists(g):
            print("缺 %s" % g); continue
        rep = score(g, "final", d)
        if rep:
            res[name] = rep

    print("\n--- dev 过门率（gen-ruler/5 重算，同 89 条）---")
    print("%-14s %-12s %-12s %-11s %s" % ("", "学生", "教师", "学生软分", "教师软分"))
    for name, rep in res.items():
        sc = rep["scoreable"]
        print("%-14s %-12s %-12s %-11s %s" % (
            name, "%d/%d" % (sc["studentPass"], sc["n"]), "%d/%d" % (sc["teacherPass"], sc["n"]),
            rep["softScore"]["studentMean"], rep["softScore"]["teacherMean"]))
    for name, rep in res.items():
        gd = rep["guard"]
        print("%-14s 过 G1 门后：%d/%d" % (name, gd["studentPass"], rep["scoreable"]["n"]))

    # ---- 判读 ----
    print("\n--- 判读（规则在看数据之前写死，见文件头）---")
    if co and cn and len(res) == 2:
        fo, to = co[-1].get("devLoss"), co[-1].get("trainLoss")
        fn, tn = cn[-1].get("devLoss"), cn[-1].get("trainLoss")
        gapFix = (fn / max(tn, 1e-9)) < 10 if (fn and tn) else None
        ro = res["v10 旧数据"]["scoreable"]["studentRate"]
        rn = res["v11 新数据"]["scoreable"]["studentRate"]
        notWorse = rn >= ro
        print("  损失差距收窄到 <10 倍：%s" % gapFix)
        print("  dev 过门率不降：%s（%.1f%% -> %.1f%%）" % (notWorse, ro * 100, rn * 100))
        if gapFix and notWorse:
            print("  => **过拟合已解决**")
        elif gapFix and not notWorse:
            print("  => **过拟合没了，但也没学会** —— 现在是欠训，处方相反（加步数/加数据）")
        elif gapFix is False and notWorse:
            print("  => **分数好看了但泛化没改善** —— 查 dev 泄漏（同一仓库的单元进训练集了？）")
        else:
            print("  => **都没解决**：既没泛化也没学会")
    else:
        print("  数据不足，不判定")
    return 0

if __name__ == "__main__":
    sys.exit(main())
