# RWKV7 压缩器 · Kaggle 真机冒烟实测记录

> 全部数字来自 Kaggle 真机运行日志，不是推演。
> 环境：NvidiaTeslaT4 ×2 · sm_75 · torch 2.11.0+cu128 · transformers 5.16.1 · fla 0.5.2 · Python 3.13
> 内核：`liaocr/cfb-rwkv7-compressor`（script kernel，private，enable_internet）

## 一、四轮冒烟的战报

| 轮 | 走到哪一步 | 死因 |
|----|-----------|------|
| v1 | GPU 检测通过 | `ModuleNotFoundError: No module named 'fla'` |
| v2 | 数据/分词/建模全过，死在第一次 `backward()` | `fla/modules/l2warp.py:47` dtype 崩 |
| v3 | 过了 l2warp，死在 Triton kernel 里 | `OutOfResources: shared memory, Required 98304, Limit 65536` |
| v4 | 见下 | — |

三个坑互相独立，都是**环境/库层面的**，与我们的训练配方无关。

## 二、坑 1：Kaggle 镜像里没有 fla，而且装哪个包有讲究

Kaggle 镜像自带 torch/transformers，**没有 fla**。

关键事实（拆 PyPI wheel 数出来的，不是猜）：

| 包 | 内容 | 条目数 |
|----|------|--------|
| `fla-core` 0.5.2 | `fla/ops` + `fla/modules` + `fla/utils` | 319，**无 `fla/models`** |
| `flash-linear-attention` 0.5.2 | `fla/layers` + `fla/models` | 154，依赖 `fla-core==0.5.2` |

而 HF 仓库 `fla-hub/rwkv7-0.1B-g1` 的 `modeling_rwkv7.py` 只有 **157 个字符**，是一句转发：

```python
from fla.models.rwkv7 import RWKV7ForCausalLM, RWKV7Model, RWKV7Config
```

所以 **`trust_remote_code=True` 救不了** —— 只有 `flash-linear-attention` 带 `fla/models`。

修法（`train_rwkv7.py` 第 2 步）：先试导入，缺了就

```
pip install --quiet --no-deps --progress-bar off \
    flash-linear-attention==0.5.2 fla-core==0.5.2 einops
```

`--no-deps` + 显式列依赖，避免 pip 顺手升级 torch/transformers 把镜像搞坏。
实测安装耗时约 **5 秒**。

## 三、坑 2：fla 的 `l2_warp` 在 fp16 logits 下 backward 必崩

```
File fla/modules/l2warp.py, line 47, in backward
  glogits.scatter_(-1, ids, maxx * grad_output)
RuntimeError: scatter(): Expected self.dtype to be equal to src.dtype
```

根因：`modeling_rwkv7.py:533`

```python
loss = l2_warp(loss, logits) if self.config.use_l2warp else loss
```

`config.json` 里**根本没有 `use_l2warp` 这个键**，dataclass 默认 `True`。
模型权重 fp16 ⇒ logits fp16 ⇒ `glogits` fp16，而 `maxx * grad_output` 是 fp32，
`scatter_` 直接报错。

修法：`model.config.use_l2warp = False`。

**同时发现一个更要命的问题**：原来把权重直接载成 fp16、没有 autocast 也没有
GradScaler —— 纯 fp16 训练梯度会大量下溢，等于白训。改为：

- 主权重一律 **fp32**
- 前向走 `torch.autocast("cuda", dtype=torch.float16)`
- 反传走 `torch.amp.GradScaler`
- `scaler.unscale_(opt)` **之后**再 `clip_grad_norm_`（顺序反了 clip 就是错的）

T4 是 sm_75，只有 fp16 有张量核，bf16 不加速。

## 四、坑 3：T4 的 64KB 共享内存装不下 fla 默认的 chunk_size=64

```
triton.runtime.errors.OutOfResources: out of resource: shared memory,
Required: 98304, Hardware limit: 65536
  at fla/ops/generalized_delta_rule/dplr/chunk_A_bwd.py:509
```

链路：

1. `fla/layers/rwkv7.py:310` 训练时**写死** `chunk_rwkv7(..., safe_gate=True, chunk_size=64)`
2. `safe_gate=True` 让 `chunk_A_bwd.py:505` 选 **tensorcore** 版 intra 反向 kernel
3. 该 kernel 内有 4 个 `[BT,BT]` 的 dA 矩阵（BT=64 ⇒ 每个 8KB，共 32KB），
   加 `q/k/a/b/gi/ge` 六个 `[BT,BK]`，合计 ~96KB > T4 的 64KB
4. 它的 `@triton.autotune` 只扫 `num_warps`/`num_stages`，**`BK` 是
   `chunk_A_bwd.py:490` 在外部算好传进去的常量**，autotune 碰不到
   ⇒ 12 个配置全部超限，必然失败

**fla 自己在打自己的脸** —— `dplr/chunk.py:156`：

> Due to gate numerical stability consideration, **we only support chunk_size=16
> when safe_gate=True**

层里却写死 64。所以降到 16 是**回到 fla 自己认可的配置**，不是绕过问题。

修法：fla 导入成功后 monkey-patch `fla.layers.rwkv7.chunk_rwkv7`，强制
`chunk_size=16`（`--chunk-size` 可调，`<=0` 表示不改）。
BT 64→16 后 `[BT,BT]` 矩阵小 16 倍，共享内存掉到 ~20KB 量级。

代价：chunk 数 ×4，慢一些。

## 五、已经真机验证通过的部分（这些不用再怀疑）

- T4 · **sm_75** · torch 2.11.0+cu128 · 2 卡
- 内核内能直接下载 `raw.githubusercontent.com` 的数据（外网通）
- 分词器 `RwkvTokenizer` · **vocab 65531** · eos=65530 · pad=0
- 48/48 条编码成功 · **超窗丢弃 0**
- token 长度 min 3014 / **p50 3522** / p90 4100 / max 4408 · 窗口 6144 **占用 p50 57.3%**
- 掩码边界偏差 **2/48 条非零、max 1**（正常 BPE 跨边界合并，不是模板错位）
- 模型载入成功 · **191.0M 参数** · fp32 主权重
- 编码 48 条约 0.8s

## 六、尚未验证 / 已知风险

- `chunk_size=16` 是否真能把共享内存压到 64KB 以下（v4 在跑）
- 训练 3 轮实际耗时（v3 单轮 583s 几乎全花在 Triton autotune 失败上，
  降到 16 之后这一项应大幅下降）
- 6144 窗口对 RWKV 固定状态容量的挤压：退化是渐进的，不是断崖；
  g1 的预训练上下文长度未公开，6144 是外推 —— "跑得动" ≠ "质量不掉"

## 七、训练集现状（必须先解决）

现在 `deploy/kaggle/data/sft-train.jsonl` 只有 **48 行占位数据**，
日志显示"每轮 12 微批 ⇒ 1 步 · 共 3 步"。冒烟通过后必须先产真实数据：
约 **4687 单元**，按 v4 提示词实测单价 **$2.90 / 约 90 分钟**。

## 八、Windows 本机操作注意

- 下载 Kaggle 日志必须带 `PYTHONUTF8=1`，否则 CLI 按 GBK 落盘会崩、日志变 0 字节
- pip 进度条里的 `▋` 字形也会触发同样的 GBK 崩溃 ⇒ 训练器里加了
  `--progress-bar off`，源码里也不再用 `⇒`、`←` 这类非 GBK 字形
- `raw.githubusercontent.com` 到本机这条链路会被重置
  （`ConnectionResetError WinError 10054`）⇒ launcher 的 `get()` 加了 4 次
  指数退避重试，并且**优先用本机那份 train_rwkv7.py**，少一个网络单点

## 九、停掉内核

Kaggle CLI **没有**暴露取消命令（`kernels` 子命令只有
list/files/get/init/push/pull/output/status/logs/update/delete/topics）。
绕到 kagglesdk：

```
POST /api/v1/kernels/cancel-session/{kernel_session_id}
```

已封装成 `python deploy/kaggle/start-rwkv7.py --stop`。
`kernel_session_id` 从 `kernels_status` 里取；session 已结束就拿不到，
那也没有可停的对象。
