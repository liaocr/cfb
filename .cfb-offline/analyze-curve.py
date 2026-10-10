
# -*- coding: utf-8 -*-
"""学习曲线分析：把每个快照点的生成稿过一遍尺子，判「欠训 / 过拟合 / 目标函数不对」。

零 GPU 成本 —— 稿子已经在 Kaggle 那边生成好了，这里只做本地打分。

⚠ 判读规则在看数据之前就写死（否则就是拿曲线去凑结论）。**但这里有一次事后追加，
   必须如实说明**：原始规则只有三支（欠训 / 不是欠训 / 不判定），漏掉了「过拟合」。
   漏掉的原因不是疏忽 —— 我当时以为 412 条 × 24 轮是"训不够"，压根没想到会训爆。
   看到日志里 loss 在第 2.4 轮就掉到 0.14 才发现规则有盲区。
   追加依据是**可观测的第三方数据**（训练器在每个快照点同时记 dev loss），
   不是拿曲线去凑结论：训练 loss 降、dev loss 升 = 过拟合，这是定义，不需要阈值。
   追加的是**分支**，不是**阈值** —— 原有的 8 点 / 4 点阈值一个字没动。
"""
import io, json, os, subprocess, sys

OUT = r"D:\cfb\.cfb-offline\kaggle-out\v10"
ROOT = r"D:\cfb"
STEPS = [72, 144, 216]

def read_json(p):
    with io.open(p, encoding="utf-8") as f:
        return json.load(f)

def score(gen_file, label):
    out = os.path.join(OUT, "eval-%s.json" % label)
    r = subprocess.run(["node", "tools/eval-sft.mjs",
                        "--sft", ".cfb-offline/sft",
                        "--gen", gen_file,
                        "--out", out],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    sys.stdout.write(r.stdout or "")
    if r.returncode != 0:
        sys.stderr.write(r.stderr or "")
        return None
    return read_json(out)

def main():
    cur = None
    cp = os.path.join(OUT, "learning-curve.json")
    if os.path.exists(cp):
        cur = read_json(cp)
        print("=== 训练器记录的曲线（train / dev loss）===")
        for p in cur:
            print("  step %-5s train %-9s dev %-9s" % (p.get("step"), p.get("trainLoss"), p.get("devLoss")))
    else:
        print("(还没有 learning-curve.json)")

    pts = []
    for s in STEPS:
        g = os.path.join(OUT, "dev-generations-step%d.jsonl" % s)
        if not os.path.exists(g):
            print("缺 %s" % g); continue
        rep = score(g, "step%d" % s)
        if rep: pts.append((s, rep))
    g = os.path.join(OUT, "dev-generations.jsonl")
    if os.path.exists(g):
        rep = score(g, "final")
        if rep: pts.append(("final", rep))

    print("\n=== 学习曲线（有受力点上的过门率）===")
    print("%-8s %-9s %-9s %-9s %-9s" % ("step", "学生", "教师", "软分", "G1门后"))
    seq = []
    for s, rep in pts:
        sc = rep["scoreable"]
        seq.append((s, sc["studentRate"]))
        print("%-8s %-9s %-9s %-9s %-9s" % (
            s, "%d/%d" % (sc["studentPass"], sc["n"]),
            "%d/%d" % (sc["teacherPass"], sc["n"]),
            rep["softScore"]["studentMean"],
            "%d/%d" % (rep["guard"]["studentPass"], sc["n"])))

    # ---- 先判过拟合（定义，不需阈值）----
    overfit = None
    if cur and len(cur) >= 2:
        tl = [p.get("trainLoss") for p in cur if p.get("trainLoss") is not None]
        dl = [p.get("devLoss") for p in cur if p.get("devLoss") is not None]
        if len(tl) >= 2 and len(dl) >= 2:
            # 用最后两个点之间的斜率，避免首点噪声
            dt = tl[-1] - tl[-2]
            dd = dl[-1] - dl[-2]
            overfit = (dd > 0 and dt <= 0)
            print("\n=== 过拟合判据（定义式，无阈值）===")
            print("  最后一段: train %+.4f / dev %+.4f" % (dt, dd))
            print("  => %s" % ("**过拟合**（train 降 dev 升）" if overfit
                              else "未检出（train 降 dev 也降 = 还在学；或两者都升 = 发散）"))

    rs = [(s, r) for s, r in seq if s != "final"]
    print("\n=== 判读 ===")
    if overfit:
        print("=> **过拟合**：加数据/减轮数/加正则，**不是**加步数。")
        print("   注意：这与「欠训」的处方**方向相反** —— 判错了会越修越坏。")
    elif len(rs) >= 3:
        r1, r2, r3 = rs[-3][1], rs[-2][1], rs[-1][1]
        mono = r3 > r2 > r1
        rise = (r3 - r1) * 100
        flat = abs(r3 - r2) * 100
        print("r1=%s r2=%s r3=%s | 上升 %.1f 点 | 末段变化 %.1f 点 | 单调=%s"
              % (r1, r2, r3, rise, flat, mono))
        if mono and rise >= 8:
            print("=> **欠训**：加步数/加数据有用（P6 有意义）")
        elif flat <= 4:
            print("=> **不是欠训**：问题在目标函数（交叉熵表达不了「这一个 token 是致命的」）")
        else:
            print("=> **不判定**：既不单调上升、末段也不平，规则套不上，如实报告")
    else:
        print("=> **不判定**：曲线点不足 3 个")

if __name__ == "__main__":
    main()
