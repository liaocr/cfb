#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 RWKV7 压缩器训练内核推到 Kaggle 并开跑（在本机执行）。

为什么必须显式指定 machine_shape = NvidiaTeslaT4
------------------------------------------------
fla 依赖 Triton kernel，需要 sm_70+。Kaggle 的 P100 是 **sm_60**，kernel 编不出来。
不写这个字段就由 Kaggle 自己挑，很可能给 P100，然后失败在一个与训练毫无关系的地方，
而且报错信息不会告诉你"是卡选错了"。

为什么要把训练器合成一个自包含的 kernel.py
------------------------------------------
Kaggle 的 script kernel **不接受命令行参数**，只运行 code_file。所以这里：
  1. 从 GitHub raw 下载 train_rwkv7.py；
  2. 切掉它的 if __name__ == "__main__": 块；
  3. 拼上一段显式 argv 的入口（冒烟 / 真训）；
  4. 写成 kernel.py，作为唯一的 code_file 推送。
数据不随内核上传 —— 内核开了外网，由训练器自己从 raw.githubusercontent 下载，
这样不存在"多文件上传到底带不带"的不确定性。

为什么会一直 QUEUED（实测，不是推演）
----------------------------------
这个脚本走的是 **batch 车道**：读了 kaggle CLI 源码，kernels_push() 只调
save_kernel()，**从不调** create_kernel_session()。而 kagglesdk 里
create_kernel_session() 的文档字符串写着它是给 **interactive** session 用的。
所以网页里点开跑（interactive）立刻派机器，而 CLI push（batch）要等调度器。
两者扣同一份配额，但 batch 会排队 —— 2026-10 实测排了 **2 小时**。

排队时怎么判断是“正常排队”而不是“卡死了”（四项都要看）：
  1. kernels_status() 返回 QUEUED 且 **kernel_session_id 为空**（没分到机器）；
  2. get_accelerator_quota_statistics() 里 timeUsed 远小于 totalTimeAllowed；
  3. list_kernels() 里没有别的内核在抢卡；
  4. kernels_logs() 返回 **0 字符**（没机器就没日志）。
四条都符合就只能等 —— 不要取消重推，那只会重新排到队尾。
真急着要结果就去网页里手动点开跑（走 interactive 车道）。

用法
----
  python deploy/kaggle/start-rwkv7.py --smoke     # 只验证环境（默认）
  python deploy/kaggle/start-rwkv7.py --train     # 真训
  python deploy/kaggle/start-rwkv7.py --status    # 查状态
  python deploy/kaggle/start-rwkv7.py --wait      # 查状态 + 拉日志，直到终态
  python deploy/kaggle/start-rwkv7.py --stop      # 停掉正在跑的 session
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

BASE = "https://raw.githubusercontent.com/liaocr/cfb/main"
SLUG = "cfb-rwkv7-compressor"
TRAINER_URL = f"{BASE}/deploy/kaggle/train_rwkv7.py"
DATA_TRAIN = f"{BASE}/deploy/kaggle/data/sft-train.jsonl"
DATA_DEV = f"{BASE}/deploy/kaggle/data/sft-dev.jsonl"
OUT_DIR = "/kaggle/working/rwkv7-compressor"


def get(url: str, tries: int = 4) -> str:
    """带重试的下载。

    raw.githubusercontent.com 到本机这条链路实测会被重置
    （ConnectionResetError WinError 10054），一次就放弃会让整轮 push 白费。
    """
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "cfb-kaggle-launcher"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read().decode("utf-8")
        except Exception as exc:  # noqa: BLE001
            last = exc
            if i < tries - 1:
                print(f"· 下载失败（{exc!r}），{2 ** i}s 后重试 {i + 2}/{tries}")
                time.sleep(2 ** i)
    raise SystemExit(f"FATAL: 下载失败 {tries} 次：{url}\n  最后错误：{last!r}")


def trainer_source() -> str:
    """优先用本机这份训练器，拿不到再回落到 GitHub raw。

    推之前一定已经 commit + push 过，本机与远端一致；用本机这份就少一个
    网络单点（raw.githubusercontent 这条链路并不稳）。回落到远端是为了
    在别的机器上、或工作区不干净时仍然能用。
    """
    local = Path(__file__).resolve().parent / "train_rwkv7.py"
    if local.is_file():
        txt = local.read_text(encoding="utf-8")
        if 'if __name__ == "__main__":' in txt:
            print(f"· 训练器用本机 {local.name}（{len(txt)} 字符）")
            return txt
        print(f"· 本机 {local.name} 里没有 __main__ 块，改用远端")
    return get(TRAINER_URL)


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
            out = Path(".cfb-offline/kaggle-out/v10")
            out.mkdir(parents=True, exist_ok=True)
            lg = subprocess.run([sys.executable, "-m", "kaggle", "kernels", "logs", kid],
                                capture_output=True, text=True)
            (out / "kernel.log").write_text((lg.stdout or "") + (lg.stderr or ""), encoding="utf-8")
            print(f"· 日志已存 {out / 'kernel.log'}（{(len(lg.stdout or ''))} 字符）")
            return 0 if cur == "COMPLETE" else 1
        time.sleep(interval)


def build_kernel(mode: str, tune: dict | None = None) -> str:
    src = trainer_source()
    marker = 'if __name__ == "__main__":'
    if marker not in src:
        sys.exit("FATAL: 训练器里找不到 __main__ 块，无法注入入口。")
    body = src[: src.index(marker)].rstrip() + "\n"
    argv = ["--smoke", "--data", DATA_TRAIN, "--dev", DATA_DEV]
    if mode == "train":
        argv = ["--data", DATA_TRAIN, "--dev", DATA_DEV, "--out", OUT_DIR]
        # 超参写死在启动器里而不是训练器默认值里：默认值一改，
        # 已经跑过的实验结果就没法复现了。
        for k, v in (tune or {}).items():
            argv += ["--" + k.replace("_", "-"), str(v)]
    entry = (
        "\n\n# ── 由 start-rwkv7.py 注入的入口（Kaggle script kernel 不能传命令行参数）──\n"
        "if __name__ == \"__main__\":\n"
        "    sys.exit(main([\n"
        + "".join(f"        {json.dumps(a)},\n" for a in argv)
        + "    ]))\n"
    )
    return body + entry


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--smoke", action="store_const", const="smoke", dest="mode")
    g.add_argument("--train", action="store_const", const="train", dest="mode")
    g.add_argument("--status", action="store_true")
    g.add_argument("--wait", action="store_true",
                   help="轮询到终态并拉日志（排队可能很久，见文档字符串）")
    ap.add_argument("--interval", type=int, default=60, help="--wait 的轮询间隔（秒）")
    g.add_argument("--stop", action="store_true")
    ap.set_defaults(mode="smoke")
    # 真训超参：写在这里，日志里能看见，复现得了。
    ap.add_argument("--epochs", type=float, default=5.0, help="训练轮数")
    ap.add_argument("--accum", type=int, default=4, help="梯度累积（每卡有效批 = batch x accum）")
    ap.add_argument("--lr", type=float, default=1e-4, help="峰值学习率")
    ap.add_argument("--gen-n", type=int, default=89, help="训完生成多少条 dev 稿子给尺子打分")
    ap.add_argument("--gen-max-new", type=int, default=768, help="单条生成上限 token")
    ap.add_argument("--ckpt-steps", default="",
                    help="学习曲线快照步数（逗号分隔）。到点就 dev loss + 生成一次，然后接着训。"
                         "空=不快照。曲线上每个点要同 n 才能相比。")
    ap.add_argument("--ckpt-gen-n", type=int, default=0,
                    help="快照点生成多少条（0=用 --gen-n）")
    ap.add_argument("--gen-budget", type=float, default=3600,
                    help="生成阶段时间预算（秒）。开缓存时 89 条约 15 分钟；"
                         "缓存失效（fla 的 RWKV7 缓存本就标着 unsupported）时"
                         "实测约 7 token/s、一条 60 秒，89 条要 90 分钟 —— "
                         "3600 秒能拿到 55 条上下，够配对评测，也不至于把整轮拖垮")
    args = ap.parse_args()

    user = username()
    kid = f"{user}/{SLUG}"
    print(f"· Kaggle 用户：{user} · 内核 {kid}")

    if args.status:
        r = subprocess.run([sys.executable, "-m", "kaggle", "kernels", "status", kid])
        return r.returncode

    if args.wait:
        return wait_kernel(kid, args.interval)

    if args.stop:
        return stop_kernel(kid)

    tune = {"epochs": args.epochs, "accum": args.accum, "lr": args.lr,
            "gen_n": args.gen_n, "gen_max_new": args.gen_max_new,
            "gen_budget": args.gen_budget}
    if args.ckpt_steps:
        tune["ckpt_steps"] = args.ckpt_steps
        tune["ckpt_gen_n"] = args.ckpt_gen_n or args.gen_n
    code = build_kernel(args.mode, tune)
    work = Path(tempfile.mkdtemp(prefix="cfb-rwkv7-"))
    (work / "kernel.py").write_text(code, encoding="utf-8")
    meta = {
        "id": kid,
        "title": "CFB RWKV7 compressor",
        "code_file": "kernel.py",
        "language": "python",
        "kernel_type": "script",
        "is_private": True,
        "enable_gpu": True,
        "enable_internet": True,
        "machine_shape": "NvidiaTeslaT4",
        "dataset_sources": [],
        "kernel_sources": [],
        "competition_sources": [],
        "model_sources": [],
    }
    (work / "kernel-metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"· 模式 {args.mode} · machine_shape NvidiaTeslaT4 · 合成 kernel.py {len(code)} 字符")
    print(f"· 工作目录 {work}")

    r = subprocess.run([sys.executable, "-m", "kaggle", "kernels", "push", "-p", str(work)])
    if r.returncode != 0:
        print(f"FATAL: push 失败（退出码 {r.returncode}）", file=sys.stderr)
        return r.returncode
    print(f"· 已推送并开跑。运行页：https://www.kaggle.com/code/{kid}")
    print(f"· 查状态：python deploy/kaggle/start-rwkv7.py --status")
    print(f"· 拉日志：python -m kaggle kernels output {kid} -p .cfb-offline/kaggle-out")
    return 0


if __name__ == "__main__":
    sys.exit(main())
