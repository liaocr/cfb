#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Prepare a local, hash-bound RWKV7 bundle. No credentials/network/GPU by default.

Historical launcher fetched mutable main data while embedding different local code.
That route is retired. Upload the checked training-data bundle as a frozen Kaggle
input, verify its mount path, then explicitly use --execute if separately approved.
--status / --wait / --stop still perform their explicitly requested remote actions.
"""
from __future__ import annotations
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

SLUG = "cfb-rwkv7-compressor"
OUT_DIR = "/kaggle/working/rwkv7-compressor"


def username() -> str:
    """从 kaggle CLI 读用户名 —— 新的 KGAT_ 令牌不把用户名编码在里面。"""
    r = subprocess.run([sys.executable, "-m", "kaggle", "config", "view"],
                       capture_output=True, text=True)
    for line in r.stdout.splitlines():
        if line.strip().startswith("- username:"):
            return line.split(":", 1)[1].strip()
    sys.exit("FATAL: 读不到 Kaggle 用户名。先跑 python -m kaggle config view 看看。")


def stop_kernel(kid: str) -> int:
    """停掉正在跑的 session。

    Kaggle 的 CLI **没有**暴露取消命令（kernels 子命令只有 list/files/get/init/
    push/pull/output/status/logs/update/delete/topics），但 kagglesdk 里有
    CancelKernelSession：POST /api/v1/kernels/cancel-session/{kernel_session_id}。
    所以绕开 CLI 直接用 SDK。session_id 得从 status 里拿；session 已经结束就
    拿不到，那也就没有可停的对象了。
    """
    from kaggle.api.kaggle_api_extended import KaggleApi
    from kagglesdk.kernels.types.kernels_api_service import ApiCancelKernelSessionRequest

    api = KaggleApi()
    api.authenticate()
    st = api.kernels_status(kid)
    d = st.to_dict() if hasattr(st, "to_dict") else dict(vars(st))
    print("· status: " + json.dumps(d, ensure_ascii=False, default=str))

    sid = 0
    for k, v in d.items():
        if "session" in k.lower() and "id" in k.lower() and isinstance(v, int) and v:
            sid = v
            break
    if not sid:
        print("· 拿不到 kernel_session_id（session 已结束或还没分配），没有可停的对象。")
        return 0

    with api.build_kaggle_client() as k:
        req = ApiCancelKernelSessionRequest()
        req.kernel_session_id = sid
        resp = k.kernels.kernels_api_client.cancel_kernel_session(req)
        err = getattr(resp, "error_message", "") or ""
    print(f"· 取消请求已发出（session {sid}）" + (f" · 服务端返回：{err}" if err else ""))
    return 0


TERMINAL = {"COMPLETE", "ERROR", "CANCEL_ACKNOWLEDGED", "CANCELLED"}


def wait_kernel(kid: str, interval: int) -> int:
    """轮询到终态。每次状态变化才打一行，避免刷屏。

    为什么要有这个：排队可能数小时，而排队期间 kernels_logs() 返回空 ——
    人工反复跑 --status 会把“正常排队”误读成“卡死了”，然后取消重推，重新排到队尾。
    """
    last = None
    t0 = time.time()
    while True:
        try:
            st = subprocess.run([sys.executable, "-m", "kaggle", "kernels", "status", kid],
                                capture_output=True, text=True)
            raw = (st.stdout or "") + (st.stderr or "")
            cur = "?"
            for name in TERMINAL | {"RUNNING", "QUEUED"}:
                if name in raw:
                    cur = name
                    break
        except Exception as exc:  # noqa: BLE001
            cur = f"status-error({exc!r})"
        if cur != last:
            print(f"· [{time.strftime('%H:%M:%S')}] 状态 {cur}"
                  f"（已等 {(time.time()-t0)/60:.0f} 分钟）", flush=True)
            last = cur
        if cur in TERMINAL:
            out = Path(".cfb-runtime/kaggle-output") / str(time.time_ns())
            out.mkdir(parents=True, exist_ok=True)
            lg = subprocess.run([sys.executable, "-m", "kaggle", "kernels", "logs", kid],
                                capture_output=True, text=True)
            (out / "kernel.log").write_text((lg.stdout or "") + (lg.stderr or ""), encoding="utf-8")
            print(f"· 日志已存 {out / 'kernel.log'}（{(len(lg.stdout or ''))} 字符）")
            return 0 if cur == "COMPLETE" else 1
        time.sleep(interval)


def load_local_trainer():
    import importlib.util
    local = Path(__file__).resolve().parent / "train_rwkv7.py"
    spec = importlib.util.spec_from_file_location("cfb_rwkv7_local", local)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def trainer_source() -> str:
    local = Path(__file__).resolve().parent / "train_rwkv7.py"
    if not local.is_file():
        raise ValueError("local trainer missing; remote main fallback is forbidden")
    source = local.read_text(encoding="utf-8")
    if 'if __name__ == "__main__":' not in source:
        raise ValueError("local trainer entrypoint missing")
    return source


def build_kernel(mode: str, tune: dict, dataset_mount: str, model_revision: str) -> str:
    import re
    if not re.fullmatch(r"[0-9a-f]{40}", model_revision or ""):
        raise ValueError("immutable model revision required")
    if not dataset_mount.startswith("/kaggle/input/") or ".." in dataset_mount.split("/"):
        raise ValueError("explicit safe Kaggle input mount required")
    src = trainer_source()
    body = src[:src.index('if __name__ == "__main__":')].rstrip() + "\n"
    argv = ["--data", dataset_mount + "/train.jsonl", "--dev", dataset_mount + "/dev.jsonl",
            "--model-revision", model_revision, "--out", OUT_DIR]
    if mode == "smoke":
        argv += ["--smoke"]
    else:
        argv += ["--admission", dataset_mount + "/admission.json"]
    for k, v in tune.items():
        argv += ["--" + k.replace("_", "-"), str(v)]
    return body + '\nif __name__ == "__main__":\n    sys.exit(main(' + json.dumps(argv) + '))\n'


def main() -> int:
    from types import SimpleNamespace
    import shutil
    ap = argparse.ArgumentParser(allow_abbrev=False, description="Offline-first, hash-bound Kaggle bundle; no push without --execute")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--smoke", action="store_const", const="smoke", dest="mode")
    g.add_argument("--train", action="store_const", const="train", dest="mode")
    g.add_argument("--status", action="store_true")
    g.add_argument("--wait", action="store_true")
    g.add_argument("--stop", action="store_true")
    ap.set_defaults(mode="smoke")
    action = ap.add_mutually_exclusive_group()
    action.add_argument("--prepare-only", action="store_true", help="默认：只在本机打包；不读凭据、不联网")
    action.add_argument("--execute", action="store_true", help="显式推送；需已上传的 --dataset-source（本轮未获授权）")
    ap.add_argument("--interval", type=int, default=60)
    ap.add_argument("--data", help="本地冻结 train.jsonl")
    ap.add_argument("--dev", help="本地冻结 dev.jsonl")
    ap.add_argument("--admission", help="真训必填；无效尺子不能签发准入")
    ap.add_argument("--model-revision", help="不可变的 40 位模型提交")
    ap.add_argument("--bundle-dir", default=".cfb-runtime/rwkv7-bundle")
    ap.add_argument("--dataset-mount", default="/kaggle/input/cfb-admitted-sft")
    ap.add_argument("--dataset-source", help="已上传的 Kaggle username/dataset-slug（不自动创建）")
    ap.add_argument("--epochs", type=float, default=3.0)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--accum", type=int, default=8)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--max-len", type=int, default=4096)
    ap.add_argument("--eos-token-id", type=int, help="显式已测的结束 id；不默默改 tokenizer/config")
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--gen-n", type=int, default=89)
    ap.add_argument("--gen-max-new", type=int, default=768)
    ap.add_argument("--ckpt-steps", default="")
    ap.add_argument("--ckpt-gen-n", type=int, default=0)
    ap.add_argument("--gen-budget", type=float, default=3600)
    args = ap.parse_args()
    if args.status or args.wait or args.stop:
        kid = f"{username()}/{SLUG}"
        if args.status:
            return subprocess.run([sys.executable, "-m", "kaggle", "kernels", "status", kid]).returncode
        if args.wait:
            return wait_kernel(kid, args.interval)
        return stop_kernel(kid)
    if not args.data or not args.dev:
        ap.error("--data and --dev must be staged local files; mutable main URLs are retired")
    if args.execute and not args.dataset_source:
        ap.error("--execute needs an already uploaded --dataset-source; no implicit GPU launch")
    trainer = load_local_trainer()
    try:
        preflight = trainer.preflight_sft(SimpleNamespace(
            data=args.data, dev=args.dev, admission=args.admission, model=trainer.MODEL_ID,
            model_revision=args.model_revision, smoke=args.mode == "smoke"))
        tune = {k: getattr(args, k) for k in ("epochs", "batch", "accum", "seed", "max_len", "lr", "gen_n", "gen_max_new", "gen_budget")}
        if args.eos_token_id is not None:
            tune["eos_token_id"] = args.eos_token_id
        if args.ckpt_steps:
            tune.update(ckpt_steps=args.ckpt_steps, ckpt_gen_n=args.ckpt_gen_n or args.gen_n)
        code = build_kernel(args.mode, tune, args.dataset_mount, args.model_revision)
        work = Path(args.bundle_dir)
        if work.exists():
            raise ValueError("refuse to overwrite a bundle; choose a fresh --bundle-dir")
        data_dir, code_dir = work / "training-data", work / "code"
        data_dir.mkdir(parents=True)
        code_dir.mkdir()
        shutil.copyfile(args.data, data_dir / "train.jsonl")
        shutil.copyfile(args.dev, data_dir / "dev.jsonl")
        if args.mode == "train":
            admission = json.loads(Path(args.admission).read_text(encoding="utf-8"))
            formal = admission["formalLineage"]
            references = [formal, *formal["bindings"].values(), *formal["evidence"].values(), *formal["sourceReviews"].values()]
            copied = {}
            for ref in references:
                source = trainer.bound_local_file(Path(args.admission).parent, ref, "bundle-formal-lineage")
                relative = ref["path"]
                if relative in {"train.jsonl", "dev.jsonl", "admission.json"}:
                    raise ValueError("bundle-lineage-reserved-filename:" + relative)
                if relative in copied and copied[relative] != ref["sha256"]:
                    raise ValueError("bundle-lineage-conflicting-file:" + relative)
                target = data_dir / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                if relative not in copied:
                    shutil.copyfile(source, target)
                    copied[relative] = ref["sha256"]
            (data_dir / "admission.json").write_text(json.dumps(admission, ensure_ascii=False, indent=2), encoding="utf-8")
        (code_dir / "kernel.py").write_text(code, encoding="utf-8")
        bundle_preflight = trainer.preflight_sft(SimpleNamespace(
            data=str(data_dir / "train.jsonl"), dev=str(data_dir / "dev.jsonl"),
            admission=str(data_dir / "admission.json") if args.mode == "train" else None,
            model=trainer.MODEL_ID, model_revision=args.model_revision, smoke=args.mode == "smoke"))
        receipt = {"schema": "cfb.kaggle-bundle/1", "mode": args.mode, "executed": False,
                   "preflight": preflight, "bundlePreflight": bundle_preflight,
                   "kernelSha256": trainer.file_sha256(code_dir / "kernel.py"),
                   "launcherSha256": trainer.file_sha256(Path(__file__)),
                   "datasetMount": args.dataset_mount, "tune": tune}
        (work / "BUNDLE.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    except (ValueError, OSError, SystemExit) as exc:
        print(f"FATAL: bundle preparation: {exc}", file=sys.stderr)
        return 2
    print(f"· 离线包已写 {work}；未推送、未开 GPU。先将 training-data 上传为独立冻结数据集，再核对挂载路径。")
    if not args.execute:
        return 0
    kid = f"{username()}/{SLUG}"
    meta = {"id": kid, "title": "CFB RWKV7 compressor", "code_file": "kernel.py",
            "language": "python", "kernel_type": "script", "is_private": True,
            "enable_gpu": True, "enable_internet": True, "machine_shape": "NvidiaTeslaT4",
            "dataset_sources": [args.dataset_source], "kernel_sources": [],
            "competition_sources": [], "model_sources": []}
    (code_dir / "kernel-metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    result = subprocess.run([sys.executable, "-m", "kaggle", "kernels", "push", "-p", str(code_dir)])
    receipt.update(executed=True, pushExitCode=result.returncode)
    (work / "BUNDLE.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
