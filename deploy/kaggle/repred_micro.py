#!/usr/bin/env python3
"""Kaggle 一键（code 框一条命令）：用已训好的微模型 ckpt 重跑 dev 预测，带「生成前自检」。

为什么要重跑：上一轮 139 条补预测全是空白行。定位结论——**生成侧和训练/dev 口径不一致**：
  * devloss（报出 2.40 的那个指标）喂的是**完整 prompt**（dev prompt 中位 1919 token）；
  * 而生成侧（eval-micro-gen）把 prompt 从**头部**切到 `ctx - max_new - 1` ≈ 1023~1319 token
    ⇒ 实测 **139/139 行 100% 被切**（CONTEXT 与 RAW 开头全丢）。
本脚本固定 checkout 含修复的提交，修复三件事：① 生成侧默认不切头（8192 硬上限）；② KV 缓存
路径分块预填充（长 prompt 不炸显存）；③ 加自检探针（prompt 构成 / teacher-forced 首字 /
模型直算 vs 缓存版等价断言 / 训练行「记忆检查」），自检不过的结果自动在 summary 里标出来。

用法（Kaggle notebook，Internet ON，Accelerator = GPU T4 x2）：
  !curl -sSL https://raw.githubusercontent.com/liaocr/cfb/<PIN>/deploy/kaggle/repred_micro.py | python3 -

可选环境变量：
  CFB_REPRED_CKPT=<run 目录或 .pt>   不给就自动搜索（/content/runs/*/out、/kaggle/working/**/out）
  CFB_CORPUS=transfer/models/micro-generator-gen-v4   （默认 v4 = run2 训练时的语料，保证可比）
  CFB_REPRED_TRAIN_STEPS=<N>         找不到 ckpt 时先按同配置补训 N 步再评测（0=不补训）
  CFB_WORKDIR=/kaggle/working/cfb-micro-run          工作目录（默认同 train_micro.py）
  CFB_REPRED_ARGS="--limit 5"                        附加参数透传（先小样试跑用）
"""
from __future__ import annotations

import json, os, subprocess, sys, time, zipfile
from pathlib import Path

REPO = "https://github.com/liaocr/cfb.git"
PIN = os.environ.get("CFB_SHA", "microgen-v2")   # 不可变标签（= 提交 c1b1e3f… 见文档）；CFB_SHA 可覆盖
CORPUS = os.environ.get("CFB_CORPUS", "transfer/models/micro-generator-gen-v4")
WDIR_ENV = os.environ.get("CFB_WORKDIR", "")
CKPT_ENV = os.environ.get("CFB_REPRED_CKPT", "")
TRAIN_STEPS = int(os.environ.get("CFB_REPRED_TRAIN_STEPS", "0"))
# 代码自检标记：确认 checkout 到的确实是含修复+探针的版本（防 CDN 缓存跑旧代码）
MARKER = "--probe-train"


def sh(cmd: str) -> subprocess.CompletedProcess:
    print(f"$ {cmd}", flush=True)
    return subprocess.run(cmd, shell=True, text=True)


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


def find_ckpt(wd: Path) -> Path | None:
    """按优先级找已训好的 ckpt（返回 run 目录，目录里应有 tokenizer.json）。"""
    cands: list[Path] = []
    if CKPT_ENV:
        cands.append(Path(CKPT_ENV))
    cands += [wd / "out", Path("/kaggle/working/cfb-micro-run/out"), Path("/content/runs/run2-v4/out"),
              Path("/content/runs/run2-v4"), Path("/content/out")]
    pats = ["/content/runs/*/out", "/kaggle/working/*/out", str(wd / "*")]
    for pat in pats:
        cands += sorted(Path("/").glob(pat.lstrip("/")), key=lambda p: p.stat().st_mtime if p.exists() else 0,
                        reverse=True)
    seen: set[str] = set()
    for c in cands:
        d = c if c.is_dir() else c.parent
        if not d.exists() or str(d) in seen:
            continue
        seen.add(str(d))
        for name in ("micro-gen-best.pt", "micro-gen.pt"):
            if (d / name).exists() and (d / "tokenizer.json").exists():
                return d
    return None


def main() -> int:
    t_all = time.time()
    wd = workdir()
    wd.mkdir(parents=True, exist_ok=True)
    report: dict = {"pinnedSha": PIN, "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

    n_gpu = count_gpus()
    print(f"[env] python {sys.version.split()[0]} / GPUs={n_gpu} / workdir {wd}", flush=True)

    # 1) 代码（固定 SHA；并做内容自检，确保拿到的是含修复的版本）
    repo = wd / "repo"
    if not repo.exists():
        sh(f"git clone -q {REPO} {repo}")
    sh(f"git -C {repo} fetch -q --tags --force origin && git -C {repo} checkout -q {PIN}")
    eval_py = repo / "tools" / "micro-generator" / "eval-micro-gen.py"
    marker_ok = MARKER in eval_py.read_text()
    report["sha"] = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"],
                                   capture_output=True, text=True).stdout.strip()
    report["evalHasProbe"] = marker_ok
    print(f"[repo] {report['sha']} · 含自检探针 {marker_ok}", flush=True)
    assert marker_ok, "checkout 到的 eval-micro-gen.py 没有探针（代码不对版，别硬跑）"

    corpus = repo / CORPUS
    assert (corpus / "dev.jsonl.gz").exists(), f"提交里没有语料 {CORPUS}"
    report["corpus"] = CORPUS

    # 2) ckpt
    run_dir = find_ckpt(wd)
    if run_dir is None:
        if TRAIN_STEPS <= 0:
            print("[ckpt] ✗ 没找到任何已训 ckpt（micro-gen-best.pt + tokenizer.json）。\n"
                  "       要么把 ckpt 目录传进来：CFB_REPRED_CKPT=/path/to/out，\n"
                  "       要么补训：CFB_REPRED_TRAIN_STEPS=2000 再跑本命令。", flush=True)
            return 1
        run_dir = wd / "out-repred"
        run_dir.mkdir(parents=True, exist_ok=True)
        tok_json = run_dir / "tokenizer.json"
        tools = repo / "tools" / "micro-generator"
        seed = corpus / "tokenizer-zh-seed.txt"
        if not tok_json.exists():
            sh(f"{sys.executable} {tools/'micro-tokenizer.py'} --train {corpus/'train.jsonl.gz'} "
               f"--vocab-size 24576 {f'--extra-text {seed} ' if seed.exists() else ''}--out {tok_json}")
        world = max(1, n_gpu)
        per_rank = max(1, 12 // world)
        cmd = (f"{sys.executable} -m torch.distributed.run --nproc_per_node={world} --master_port=29519 "
               f"{tools/'train-micro-gen.py'} --corpus {corpus} --out {run_dir} --vocab-size 24576 "
               f"--tokenizer {tok_json} --ctx 2048 --d-model 512 --layers 8 --heads 8 --batch {per_rank} "
               f"--steps {TRAIN_STEPS} --lr 3e-4 --warmup 50 --log-every 20 --eval-max-new 0 --eval-limit 0"
               if world > 1 else
               f"{sys.executable} {tools/'train-micro-gen.py'} --corpus {corpus} --out {run_dir} "
               f"--vocab-size 24576 --tokenizer {tok_json} --ctx 2048 --d-model 512 --layers 8 --heads 8 "
               f"--batch 12 --steps {TRAIN_STEPS} --lr 3e-4 --warmup 50 --log-every 20 --eval-max-new 0 --eval-limit 0")
        print(f"[ckpt] 没找到 → 先补训 {TRAIN_STEPS} 步（只为验证管线，别当交付质量）", flush=True)
        rc = subprocess.run(["bash", "-c", f"{cmd} 2>&1 | tee {wd/'repred-train.log'}"],
                            executable="/bin/bash").returncode
        report["trainExitCode"] = rc
    report["runDir"] = str(run_dir)
    print(f"[ckpt] 用 {run_dir}", flush=True)

    # 3) 重跑 dev 预测（自检默认开：2 条 dev + 1 条训练行「记忆检查」）
    tools = repo / "tools" / "micro-generator"
    world = max(1, n_gpu)
    extra = os.environ.get("CFB_REPRED_ARGS", "")   # 附加参数透传（如 --limit 5 先小样试跑）
    common = (f"--ckpt {run_dir} --corpus {corpus} --out {run_dir} --cap 1024 --examples 3 "
              f"--gen-mode auto --ctx-limit 8192 --probe 2 --probe-train 1 --ab-tokens 32 {extra}")
    if world > 1:
        cmd = (f"{sys.executable} -m torch.distributed.run --nproc_per_node={world} --master_port=29521 "
               f"{tools/'eval-micro-gen.py'} {common} --device cuda")
    else:
        cmd = f"{sys.executable} {tools/'eval-micro-gen.py'} {common}"
    log = wd / "repred.log"
    print("[repred] 开始（本 cell 实时输出；跑完自动打包）", flush=True)
    t0 = time.time()
    rc = subprocess.run(["bash", "-o", "pipefail", "-c", f"{cmd} 2>&1 | tee {log}"],
                        executable="/bin/bash").returncode
    report["evalExitCode"] = rc
    report["evalSeconds"] = round(time.time() - t0, 1)

    # 4) 汇总：探针/摘要/前几条预测文本
    lines = log.read_text(errors="replace").splitlines()
    probe_lines = [l for l in lines if l.startswith("[probe")]
    report["probe"] = probe_lines
    summary_p = run_dir / "dev-predictions-summary.json"
    if summary_p.exists():
        summ = json.loads(summary_p.read_text())
        report["summary"] = {k: v for k, v in summ.items() if k not in ("probe",)}
        report["probeVerdict"] = summ.get("probeVerdict")
        # 预测文本预览（看是不是真有了内容）
        preds_p = run_dir / "dev-predictions.jsonl"
        if preds_p.exists():
            rows = [json.loads(l) for l in preds_p.read_text().splitlines() if l.strip()]
            nonempty = sum(1 for r in rows if r["prediction"].strip())
            report["preds"] = dict(n=len(rows), nonEmpty=nonempty,
                                   previews=[dict(unitId=r.get("unitId"), chars=len(r["prediction"]),
                                                  head=r["prediction"][:120]) for r in rows[:3]])
            print(f"[preds] {nonempty}/{len(rows)} 条非空", flush=True)
    report["wallSeconds"] = round(time.time() - t_all, 1)
    (wd / "RESULTS-repred.txt").write_text(json.dumps(report, indent=2, ensure_ascii=False))

    # 5) 打包
    zip_p = (Path("/kaggle/working") if Path("/kaggle/working").exists() else wd) / "cfb-micro-repred.zip"
    with zipfile.ZipFile(zip_p, "w", zipfile.ZIP_DEFLATED) as z:
        for name in ("dev-predictions.jsonl", "dev-predictions-summary.json", "model-config.json",
                     "tokenizer.json", "micro-gen-best.pt", "micro-gen.pt", "probe.json"):
            p = run_dir / name
            if p.exists():
                z.write(p, name)
        z.write(log, "repred.log")
        z.write(wd / "RESULTS-repred.txt", "RESULTS-repred.txt")
    print("\n=== 自检（请连同 zip 一起发我）===", flush=True)
    for l in probe_lines:
        print(l, flush=True)
    print(f"\n[done] {zip_p}（{zip_p.stat().st_size/1e6:.1f} MB）· verdict="
          f"{report.get('probeVerdict')} · 非空预测 {report.get('preds', {}).get('nonEmpty', '?')}"
          f"/{report.get('preds', {}).get('n', '?')}", flush=True)
    return 0 if rc == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
