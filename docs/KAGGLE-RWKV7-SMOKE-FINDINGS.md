# RWKV7 压缩器 · Kaggle 真机冒烟实测记录

> 全部数字来自 Kaggle 真机运行日志，不是推演。
> 环境：NvidiaTeslaT4 ×2 · sm_75 · torch 2.11.0+cu128 · transformers 5.16.1 · fla 0.5.2 · Python 3.13
> 内核：`liaocr/cfb-rwkv7-compressor`（script kernel，private，enable_internet）

## 一、五轮冒烟的战报

| 轮 | 走到哪一步 | 结果 |
|----|-----------|------|
| v1 | GPU 检测通过 | 死：`ModuleNotFoundError: No module named 'fla'` |
| v2 | 数据/分词/建模全过，死在第一次 `backward()` | 死：`fla/modules/l2warp.py:47` dtype 崩 |
| v3 | 过了 l2warp，死在 Triton kernel 里 | 死：`OutOfResources: shared memory, Required 98304, Limit 65536` |
| v4 | 单卡全流程 | **通过**：3 步 + dev loss + 生成 + 存档 |
| v5 | **双卡 DDP 全流程** | **通过**：2 卡都吃上，barrier / destroy 干净收尾 |

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

- ~~`chunk_size=16` 是否真能把共享内存压到 64KB 以下~~ ⇒ **已验证**：v4/v5 全程无 OOM
- ~~训练实际耗时~~ ⇒ **已验证**：见第十节实测步时
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

## 十、冒烟 v5：双卡 DDP 全流程

### 为什么会有 v5

v4 通过之后我说了句"2 卡"，**那是错的**。日志里的
`torch.cuda.device_count()` 只是机器规格，不是使用情况。v4 代码里
`model.to("cuda")`、`torch.tensor(..., device="cuda")` 全落在 `cuda:0`，
`cuda:1` 一次都没出现，没有 DDP / DP / accelerate —— 等于 T4 白扔一张。

### 修法

`main()` 解析完参数后自检：`args.gpus <= 0` 时取 `min(device_count, 2)`；
若 `gpus > 1` 且环境变量 `CFB_DDP != 1`，用

```
torch.distributed.run --nproc_per_node N --standalone --master_port 29517
```

重新 exec 自己（`reexec_under_torchrun`），带 `CFB_DDP=1` 防递归。
进去之后：

- `local_rank = LOCAL_RANK`、`world = WORLD_SIZE`、`torch.cuda.set_device(local_rank)`
- `init_process_group(backend="nccl")`
- 非 0 号 rank 把 stdout 丢进 `os.devnull`，免得两行日志交错
- `batches = batches[local_rank::world]` —— 按 rank 切分，不重不漏
- `DistributedDataParallel(..., device_ids=[local_rank], find_unused_parameters=True)`
- dev loss / 生成 / `save_pretrained` **只在 0 号做**，且用**未包裹**的
  `base_model`（DDP 包裹层的 `.generate()` 会因 forward 签名不同而炸）
- 退出前 `barrier()`，最后 `destroy_process_group()`

### v5 真机日志（原样）

```
· 参数量 191.0M（全参微调 · fp32 主权重） · DDP 2 卡
· rank 0 分到 6 个微批
· 批 4 × 累积 8 = 有效批 32 · 每轮 6 微批 -> 1 步 · 共 3 步
  step 1/3 loss 3.0911 · 193.7s · 峰值显存 5.30 GiB
  step 2/3 loss 4.6074 · 4.5s · 峰值显存 6.95 GiB
  step 3/3 loss 4.7127 · 2.5s · 峰值显存 7.13 GiB
· 前向+反传 合计 200.7s · 首步 193.7s（含 Triton 首次编译） · 最快 2.5s/步
· 生成通路 ok（37.5s / 256 token）
=== 冒烟通过 ===
```

两条 `Loading weights:` 进度条交错、`[rank0]`/`[rank1]` 两条警告都出现，
证明两个进程**都真的载了权重**、都进了 DDP。

### 实测吞吐

| | 单卡 v4 | 双卡 v5 |
|---|---|---|
| 稳态 | 1.8 s / 微批 | 2.5 s / 微批 |
| 峰值显存 | 4.66 GiB | 7.13 GiB |
| 48 行一轮 | 12 微批 × 1.8 = 21.6 s | 6 微批 × 2.5 = 15.0 s |

**DDP 只拿到约 1.4×，不是 2×** —— 每微批多出的 0.7s 是梯度 allreduce
加上 `find_unused_parameters=True` 的图遍历。
全量 4687 行 / 批 4 = 1172 微批，每卡 586，3 轮 ≈ 1758 微批：

- 双卡：1758 × 2.5 ≈ **73 分钟**（+ 首步编译约 3 分钟）
- 单卡：3516 × 1.8 ≈ **105 分钟**

### 顺手修掉的一个报告 bug

冒烟结尾原来算的是 `steady * total_steps`，但 `total_steps` 是**优化器步数**、
每步要 `accum` 个微批 —— 等于把耗时低估 `accum`（8）倍。已改成
`steady * total_steps * accum`。

### 一条已知无害警告

`find_unused_parameters=True` 但 DDP 报 "did not find any unused parameters"。
**不改成 `False`** —— 梯度检查点下 DDP 的静态图假设本来就容易翻车，
省那 3% 不值得赌一次 73 分钟的训练。

## 十一、尺子上的一个洞：空稿能过门（已修）

真训之前给 `tools/eval-sft.mjs` 做自测，拿三个已知答案当输入喂进去：

| 输入 | 应有结果 | 修前实测 | 修后实测 |
|------|---------|---------|---------|
| 学生 = 教师稿 | = 教师基线 | 44.9% ✓ | 34.8% ✓ |
| 学生 = 原文（不压缩） | 0% | **0.0%** ✓ | 0.0% ✓ |
| 学生 = **空字符串** | 0% | **18.0%** ✗ | **0.0%** ✓ |

**空稿能过门，89 条里过 16 条。** 原因：那 16 条单元 raw 里没有任何文件路径
（`codeTask=false`），题面的失败陈述里也没有一个 raw 认得、可当承重的锚点。
于是 G1~G7 **全部空转** —— 没有引号可查、没有落点可判、没有锚点可丢、
没有命令可验，空稿当然也不算"抄"、不算"没压缩"。所有门都是**否定式**约束，
没有一条是"必须存在点什么"。

后果：模型只要学会**什么都不输出**，就能白拿 18% 的分数，而没有任何指标报警。

修法：加 **G0 no-leverage** —— `load.length === 0 && !codeTask` 直接判死。
"没有受力点"必须显式判死，不能默认放过；默认放过会让指标系统性报喜。
这和 `preflight()` 的 P5 是同一条道理，只是那道门拦在**花钱之前**，
这道门拦在**打分之时**，两道都要有。

尺子版本随之升到 **`gen-ruler/3`**（`gen-ruler/2` 下的分数不可直接比较）。
自测 16 PASS / 0 FAIL。

因为 G0 会同时剔除那些单元，评测**两个数都给**：

- **全体**（G0 算失败，保守）：教师 31/89 = 34.8%
- **有受力点子集**（剔除 G0 的 16 条，才是真正的对比）：教师 31/73 = **42.5%**

学生分数跟 **42.5%** 比，不是跟 100% 比，也不是跟 34.8% 比。
