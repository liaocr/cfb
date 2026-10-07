#!/usr/bin/env python3
"""Kaggle 一键（code 框一条命令）：从零训练「任务专用微模型」生成式压缩器。

内部固定 checkout 标签 microgen-v2（tools 与语料均来自该提交），避免 CDN 缓存跑旧代码。

与 train_gen.py（Qwen3-0.6B + LoRA）并列的第二条路线：
  * 自训 16k 词表（只用我们的语料）+ 手写小 GPT 从零训（无预训练权重）
  * 不需要 transformers / 4-bit / peft；T4 上直接 fp16，DDP 用满所有卡
  * 产物：/kaggle/working/RESULTS.txt + cfb-micro-gen-run1.zip（含 tokenizer/model/predictions）

用法（Kaggle notebook，Internet ON，Accelerator = GPU T4 x2）：
  !curl -sSL https://raw.githubusercontent.com/liaocr/cfb/microgen-v2/deploy/kaggle/train_micro.py | python3 -
"""
from __future__ import annotations

import json, os, shutil, subprocess, sys, time, zipfile
from pathlib import Path

REPO = "https://github.com/liaocr/cfb.git"
PIN = os.environ.get("CFB_SHA", "microgen-v2")   # 不可变标签；含生成侧截断修复 + 自检探针
# 语料：默认用 v4（= v3 + batch3 + batch4 的合并语料，评测集固定为 v3 dev 保持跨轮可比）；
# 可用 CFB_CORPUS 覆盖。找不到时回退 v3 并告警。
CORPUS = os.environ.get("CFB_CORPUS", "transfer/models/micro-generator-gen-v5")
CORPUS_FALLBACK = "transfer/models/micro-generator-gen-v4"

# ---- 训练超参（全局量：换卡数时 token 预算不变）----
def _env(name, default, cast=int):
    return cast(os.environ.get(name, default))


VOCAB = _env("CFB_VOCAB", 24576)
CTX = _env("CFB_CTX", 2048)
D_MODEL = _env("CFB_D_MODEL", 512)
LAYERS = _env("CFB_LAYERS", 8)
HEADS = _env("CFB_HEADS", 8)
GLOBAL_BATCH = _env("CFB_GLOBAL_BATCH", 12)   # 每步 token = GLOBAL_BATCH × CTX = 24,576
TOTAL_TOKENS = _env("CFB_TOTAL_TOKENS", 60_000_000)  # ≈ 40 epoch（语料约 1.5M tokens）
TIME_BUDGET = _env("CFB_TIME_BUDGET", 1500)   # 秒；到点收工，保证训练+评测+打包 < 45 分钟
LR = float(os.environ.get("CFB_LR", 3e-4))
FINAL_EVAL = _env("CFB_FINAL_EVAL", 64)       # 最终评测用多少条 dev（全量 139 稍后可补）
WDIR_ENV = os.environ.get("CFB_WORKDIR", "")


def sh(cmd: str, **kw) -> subprocess.CompletedProcess:
    print(f"$ {cmd}", flush=True)
    return subprocess.run(cmd, shell=True, text=True, **kw)


def count_gpus() -> int:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                             capture_output=True, text=True).stdout.strip()
        return len([l for l in out.splitlines() if l.strip()])
    except Exception:
        return 0


def workdir() -> Path:
    if WDIR_ENV:
        return Path(WDIR_ENV)
    w = Path("/kaggle/working")
    return (w if w.exists() else Path("/tmp/cfb-micro")) / "cfb-micro-run"


def main() -> None:
    t_all = time.time()
    wd = workdir()
    out = wd / "out"
    for d in (wd, out):
        d.mkdir(parents=True, exist_ok=True)
    results = {"pinnedSha": PIN, "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

    n_gpu = count_gpus()
    results["gpus"] = n_gpu
    print(f"[env] python {sys.version.split()[0]} / GPUs={n_gpu}", flush=True)
    if n_gpu == 0:
        print("[warn] 没有 GPU：CPU 上也能跑完，但会很慢（这不是验收跑）", flush=True)

    # 1) 依赖：只需要 tokenizers（Kaggle 镜像通常已有）
    try:
        import tokenizers  # noqa: F401
        print("[deps] tokenizers 已存在", flush=True)
    except Exception:
        sh(f"{sys.executable} -m pip install -q tokenizers")

    # 2) 取代码（固定 SHA，避免 CDN 缓存导致跑旧代码）
    repo = wd / "repo"
    if not repo.exists():
        sh(f"git clone -q {REPO} {repo}")
    sh(f"git -C {repo} fetch -q --tags --force origin && git -C {repo} checkout -q {PIN}")
    results["repoSha"] = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"],
                                        capture_output=True, text=True).stdout.strip()
    tools = repo / "tools" / "micro-generator"
    corpus = repo / CORPUS
    if not (corpus / "train.jsonl.gz").exists() and not os.environ.get("CFB_CORPUS"):
        print(f"[warn] 提交里没有 {CORPUS}，回退到 {CORPUS_FALLBACK}", flush=True)
        corpus = repo / CORPUS_FALLBACK
    assert (corpus / "train.jsonl.gz").exists(), f"缺语料 {corpus}"
    crep = corpus / "corpus-report.json"
    if crep.exists():  # 语料出身证明（行数/仓库数/隔离校验）进 RESULTS
        cr = json.loads(crep.read_text())
        results["corpus"] = dict(dir=str(corpus.relative_to(repo)),
                                 train=cr.get("train"), dev=cr.get("dev"),
                                 isolation=cr.get("isolation"))

    # 3) 词表（默认 24k；英文训练文本 + 仓库自带中文种子，让常见中文词也是单 token）
    tok_json = out / "tokenizer.json"
    seed = corpus / "tokenizer-zh-seed.txt"
    extra = f" --extra-text {seed}" if seed.exists() else ""
    if not tok_json.exists():
        sh(f"{sys.executable} {tools/'micro-tokenizer.py'} --train {corpus/'train.jsonl.gz'} "
           f"--vocab-size {VOCAB}{extra} --out {tok_json}")

    # 4) 训练：≥2 卡用 torchrun（DDP），否则单进程
    world = max(1, n_gpu)
    per_rank_batch = max(1, GLOBAL_BATCH // world)
    steps = max(200, TOTAL_TOKENS // (world * per_rank_batch * CTX))
    common = (f"--corpus {corpus} --out {out} --vocab-size {VOCAB} --tokenizer {tok_json} "
              f"--ctx {CTX} --d-model {D_MODEL} --layers {LAYERS} --heads {HEADS} "
              f"--batch {per_rank_batch} --steps {steps} --lr {LR} --warmup 100 "
              f"--log-every 20 --time-budget-sec {TIME_BUDGET} --eval-limit {FINAL_EVAL} "
              f"--eval-max-new 0 --devloss-every {_env('CFB_DEV_EVERY', 40)} "
              f"--devloss-limit {_env('CFB_DEV_LOSS_LIMIT', 64)} --early-stop-patience 4 "
              f"--dump-predictions")
    results["train"] = dict(world=world, perRankBatch=per_rank_batch, steps=steps,
                            globalBatch=GLOBAL_BATCH, ctx=CTX,
                            plannedTokens=world * per_rank_batch * CTX * steps)
    log = wd / "train.log"

    def run_logged(cmd_str: str, append: bool = False) -> int:
        """训练输出同时进 notebook（实时）与 train.log（断线可查）。"""
        print(f"$ {cmd_str}", flush=True)
        tee = "tee -a" if append else "tee"
        wrapped = f"{cmd_str} 2>&1 | {tee} {log}"
        # pipefail：返回码取训练进程的，而不是 tee 的
        return subprocess.run(["bash", "-o", "pipefail", "-c", wrapped]).returncode

    if world > 1:
        cmd = (f"{sys.executable} -m torch.distributed.run --nproc_per_node={world} "
               f"--master_port=29517 {tools/'train-micro-gen.py'} {common}")
    else:
        cmd = f"{sys.executable} {tools/'train-micro-gen.py'} {common}"
    print(f"[train] 开始（本 cell 实时输出；另开 cell 也可 !tail -n 8 {log}）", flush=True)
    t0 = time.time()
    rc = run_logged(cmd)
    results["trainSeconds"] = round(time.time() - t0, 1)
    if rc != 0 and world > 1:
        print(f"[warn] DDP 训练返回码 {rc}，回退单卡重跑", flush=True)
        results["ddpFallback"] = True
        rc = run_logged(f"{sys.executable} {tools/'train-micro-gen.py'} {common}", append=True)
        results["trainSecondsFallback"] = round(time.time() - t0, 1)
    tail = log.read_text(errors="replace").splitlines()[-40:]
    if rc != 0:
        print("\n".join(tail), flush=True)   # 成功时上面已实时流过，不必重打
    results["trainExitCode"] = rc

    # 5) 汇总（模型规格 / 训练曲线尾 / dev 指标 / 文件哈希）
    import hashlib

    def sha256(p: Path):
        if not p.exists():
            return None
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for b in iter(lambda: f.read(1 << 20), b""):
                h.update(b)
        return h.hexdigest()

    cfg_p = out / "model-config.json"
    if cfg_p.exists():
        cfg = json.loads(cfg_p.read_text())
        params = cfg["vocab"] * cfg["d_model"]  # 嵌入+输出（共享）
        for _ in range(cfg["layers"]):
            params += 4 * cfg["d_model"] ** 2 + 2 * cfg["d_model"] * cfg["ffn_mult"] * cfg["d_model"]
        results["modelParams"] = params
        results["modelConfig"] = cfg
    losses = [l for l in tail if l.startswith("[train]")][-6:]
    results["lossTail"] = losses
    results["devLossTail"] = [l for l in tail if l.startswith("[devloss]")][-8:]
    if (out / "dev-metrics.json").exists():
        m = json.loads((out / "dev-metrics.json").read_text())
        results["bestDevLoss"] = m.get("bestDevLoss")
        results["bestStep"] = m.get("bestStep")
        results["devMetrics"] = {k: v for k, v in m.items() if k != "per_sample"}
    results["wallSeconds"] = round(time.time() - t_all, 1)
    (wd / "RESULTS.txt").write_text(json.dumps(results, indent=2, ensure_ascii=False))
    print("[results] " + json.dumps({k: results[k] for k in
                                     ("gpus", "trainSeconds", "modelParams", "devMetrics")
                                     if k in results}, ensure_ascii=False), flush=True)

    # 6) 打包
    zip_p = wd / "cfb-micro-gen-run1.zip" if WDIR_ENV or not Path("/kaggle/working").exists() \
        else Path("/kaggle/working") / "cfb-micro-gen-run1.zip"
    with zipfile.ZipFile(zip_p, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(out.rglob("*")):
            if p.is_file():
                z.write(p, p.relative_to(wd))
        z.write(wd / "RESULTS.txt", "RESULTS.txt")
        z.write(log, "train.log")
    print(f"[done] 产物 {zip_p} ({zip_p.stat().st_size/1e6:.1f} MB) / RESULTS.txt 同步在 /kaggle/working",
          flush=True)


if __name__ == "__main__":
    main()
