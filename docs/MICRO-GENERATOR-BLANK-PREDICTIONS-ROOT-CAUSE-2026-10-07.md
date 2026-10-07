# 空白预测根因定位：生成口径 ≠ 训练/dev 口径（2026-10-07）

## 症状

run2（v4 语料）dev CE 已降到 **2.4021**（v3 最好 4.5463），但用户回帖的 **139 条补预测全是空白行**
（predLen 256–1024、`truncated:false`、recall 0.0）。也就是说：**指标说模型会，交付物说不会**。
在这种状态下继续判读、调模型、加语料都没有意义——先修管线。

## 第一步就抓到的硬数字（v4 dev 139 条，24k 自训词表实测）

| 量 | 值 |
| --- | --- |
| dev **prompt** token 数 | 中位 **1919** · p90 2833 · 最大 4994 |
| dev gold token 数 | 中位 322 |
| dev prompt+gold | 中位 2237 · 最大 5541 |
| 生成侧自适应长度 `max_new` | `min(1024, max(256, gold_tok×1.6+96))` |
| 生成侧旧截断上限 `ctx − max_new − 1`（ctx=2048） | **1023 ~ 1791** |
| **被切掉头部的 dev 行数** | **139 / 139 = 100 %** |

## 为什么会致命（口径不一致，不是"数据不好"）

同一段代码里有两个不同的口径：

* **devloss**（就是报出 2.4021 的那个指标）：喂**完整 prompt**（单行上限 4096 token，139 条里绝大多数没触发），
  label 只算答案段 ⇒ 这是"模型能力"的唯一直测。
* **生成侧**（`greedy_gen` / `greedy_gen_cached`）：`prompt_ids[-(ctx - max_new - 1):]`，
  即**从尾部留 1023~1791 token、把头全切掉**。CONTEXT 段和 RAW 的开头全部消失，
  模型只看到"RAW 的尾巴 + `<|asst|>`"。

于是**用来证明"模型会"的那个输入，和真正生成时的输入根本不是同一个东西**。
（这条在沙箱里也复现过：本地 CPU 用随机权重跑评测，`emptyOutputs` 与 `truncated:false` 的签名完全一致。）

## 修复（三件，均已入库）

1. **生成侧默认不切头**：`--ctx-limit`（默认 8192）只当"prompt+生成"的硬上限；实测最长 4994+1024 < 8192
   ⇒ 真实数据下**零截断**。`evaluate()`（训练内评测）同样改为 8192，不再按训练 ctx 切头。
2. **KV 缓存路径分块预填充**（2048/块）：因果掩码按"块内位置 + 已有缓存长度"对齐，数学等价，
   峰值显存按块计 ⇒ 数千 token 的长 prompt 不再一次性分配 T×T 注意力矩阵。
3. **生成前自检探针**（`--probe`，默认开）+ **训练行记忆检查**（`--probe-train`，默认 1 条）：
   在**真实权重、真实 prompt、真实 fp16 路径**上打印
   * prompt token 数 + 尾部文本（确认模型确实看到"…RAW 尾 + `<|asst|>`"）；
   * teacher-forced 首字 **top-5** 与 gold 首 token（判"模型会不会开口"）；
   * **模型直算 vs KV 缓存**（整块 / 分块）的 `max|Δlogit|` 等价断言；
   * 32-token 贪心 plain vs cached 文本一致率（软指标，不比字符串相等）；
   * 与训练内 devloss **完全同口径**的 teacher-forced CE。
   判定写进 `dev-predictions-summary.json.probeVerdict` 与 `probe.json`：
   `ok` / `cache-broken` / `no-output` / `mem-only`。
   * `no-output`：**连训练行都生不出任何 token** ⇒ 管线/ckpt 加载坏了，此结果不可判读；
   * `mem-only`：训练行能开口、dev 不能 ⇒ 模型只会背稿（管线是好的，别再怪生成）。

## 验证状态（避免夸大）

* 沙箱（CPU、**随机权重**、迷你语料）smoke：探针三项跑通，等价偏差 **1.79e-07**，
  summary/probe.json 落盘正常，`no-output` 判定按要求触发。
* **真实权重上的结论仍待 Kaggle 跑**：`deploy/kaggle/repred_micro.py`（见 `KAGGLE-MICRO-MODEL-RUN.md`）。
  跑完把 zip + `[probe]` 日志回传，再进 7 轴判读。

## 纪律

* 这条链没验通之前：**不判读、不调模型、不加语料**。空白预测不是"模型不行"的证据。
* 判读器、gold 自检、7 轴口径不变。

## 本轮固定引用（两层 SHA 钉法，别用标签）

| 层 | 提交 | 说明 |
| --- | --- | --- |
| URL 层（launcher 本身） | `48a7982c213ed7d9820f4f98bd85f7522e391e29` | `deploy/kaggle/*.py` 所在的提交 |
| tools 层（脚本内部 `PIN`） | `ab8fa97e234407e129c4adb815e1a69a71c40dd7` | `tools/` + 语料所在；`tools/` 内容与 URL 层逐字相同 |

两条命令（互不影响）：

```bash
# A. 重跑 dev 预测（自检版）——用已训 ckpt，跑完打 zip + [probe] 判定
!curl -sSL https://raw.githubusercontent.com/liaocr/cfb/48a7982c213ed7d9820f4f98bd85f7522e391e29/deploy/kaggle/repred_micro.py | python3 -

# B. ckpt 丢了时（同配置补训 ≈ run2 的 2040 步，再走同一套自检+评测）
!bash -c 'export CFB_REPRED_TRAIN_STEPS=2040; curl -sSL https://raw.githubusercontent.com/liaocr/cfb/48a7982c213ed7d9820f4f98bd85f7522e391e29/deploy/kaggle/repred_micro.py | python3 -'
```

> **不要用标签钉**：raw CDN 对 force-move 过的标签会继续吐旧内容（本轮实测踩过，已删掉那个标签）。

## 判据（跑完看哪几行）

* `[probe·dev] gold 段 CE(全prompt) X.XX`：与 devloss 同口径，run2 应 ≈2.4；远高于它说明 prompt 处理/ckpt 有问题。
* `[probe·旧口径] … CE：全 prompt A → 切头后 B`：**B ≫ A** ⇒ 上一轮空白就是截断造成的（根因坐实）；
  `B ≈ A` ⇒ 不是截断，去看 `max|Δlogit|`（等价断言）。
* `max|Δlogit|`：应 ≲1e-2（fp16 噪声量级）。>0.5 ⇒ KV 缓存路径有 bug（已自动强制 plain）。
* `verdict`：`ok` / `cache-broken` / `no-output`（连训练行都不开口 ⇒ 别判读）/ `mem-only`（只会背稿）。
