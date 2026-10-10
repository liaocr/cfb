# 出生单元批量切分 + 锻造管道（2026-10-07）

> **范围**：把「情景 → 金标」这条路跑通 = 批量切出生单元（A 路）+ 在出生单元上锻出"好"的参考压缩块、用**生产的同一批尺子**打分、并用**产线稿与受控负例**验证尺子的判别力（B 路）。
> **没做的事**：没有训练任何模型；没有真机（E1/E2 全部未测）；没有人工审核——所有评审记录都是 AI 单审（`humanReviewerCount: 0`），不冒充人工。

## 1. A 路：批量切分（普查，9 shard 全覆盖）

工具：`tools/micro-generator/scan-birth-units.py`（新）。

**为什么要新工具**：旧提取器用 DuckDB 按 `file_row_number` 取单行，`messages` 列整块物化——shard 26 第一行就要 >900MB，沙箱（~2GB）直接 rc137。实测对比：同一行 `SELECT repo, instance_id` 约 10MB，加 `messages` 即 OOM。新工具改为「一次性整 shard 下载 → pyarrow `iter_batches`(2 行/批) 流式解码」，每 shard 下载 2–7s、解码 5s，内存峰值 <200MB；`build_units()` 与原提取器**逐字复用**，单元形状不变。

| 项 | 值 |
|---|---|
| 扫描行数 | 21,208（shards 25–33 全量） |
| 命中单元数（raw≥1500 字符、每行 1 个） | **19,992**（行命中率 94.3%） |
| 落盘样本 | 144（每仓库 1 条 × 16 条/shard，保多样性） |
| 仓库数 / 许可 | 144 · MIT 68 · Apache-2.0 48 · BSD-3-Clause 23 · BSD-2-Clause 5 |
| 耗时 | 86.9s |

- 落盘：`transfer/models/micro-generator-v4flash-scenarios/birth-units-census-batch1.jsonl.gz`（1.6MB）+ `.manifest.json`
- 逐 shard 命中：25→2369 · 26→2348 · 27→2367 · 28→2340 · 29→2362 · 30→2354 · 31→2363 · 32→2361 · 33→1128
- 含义：`raw≥1500` 下约 **2 万个**出生单元可切——切分不再是瓶颈；瓶颈是"给它们锻出好尺子"的评审吞吐。

## 2. B 路：锻造管道（情景 → 金标）

工具：`tools/micro-generator/forge-birth-units.mjs`（新）。

**口径纪律（关键）**：

1. **判据不另立**：M1/M3/M4/M5/M6/M7/M8 的表达式**逐字照抄** `tools/helpers/gold-standard.mjs` 的 `measureGold()`；`hasClosedRead` / `anchorsOf` / `handDraftGate` / `FIX_INTENT_RE` / `auditMode1Gold` 全部直接 import 生产实现。
2. **证据基 = raw ∪ ctx**（出生时刻起草人看得见的文本）。`after.*`（后续 6 步）**故意不进证据基**——它是事后代理，进去就等于允许刚出生的稿子引用未来信息。
3. **未测就是未测**：M2 / E1 / E2 / R1 / R2 全部记 `未测`，不折算成通过。本语料天花板 = `provisional-gold`，**不是 gold**。
4. 另有**离线代理**（明确标注不是真机判据）：`fixAlignmentProxy` = 稿中标识符在后续真实动作里出现的比例，对齐的是"这条线把读者带到哪"。

**已锻 12 条（3 批，覆盖 10 个仓库，含 2 条盲测批次）：**

| 单元 | 仓库 | raw 字 | 稿 字 | 压缩率 | M1 | M3 | M4 | M5 | M6 | M7 | M8 | 状态 | 落点对齐（代理） |
|---|---|---:|---:|---:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|---:|
| canonical_operator_pr1000#b10 | canonical/operator | 1496 | 444 | 0.2968 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | provisional-gold | 0.714 |
| canonical_operator_pr1000#b15 | canonical/operator | 3502 | 506 | 0.1445 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | provisional-gold | 0.333 |
| googlefonts_ufo2ft_pr299#b9 | googlefonts/ufo2ft | 1906 | 621 | 0.3258 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | provisional-gold | 0.000 |
| googlefonts_ufo2ft_pr299#b12 | googlefonts/ufo2ft | 4278 | 623 | 0.1456 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | provisional-gold | 0.700 |
| pre-commit_pre-commit-hooks_pr111#b3 | pre-commit/pre-commit-hooks | 2771 | 514 | 0.1855 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | provisional-gold | 0.750 |
| pre-commit_pre-commit-hooks_pr111#b5 | pre-commit/pre-commit-hooks | 1407 | 397 | 0.2822 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | provisional-gold | 0.500 |
| lepture_mistune_pr283#b6（盲） | lepture/mistune | 2251 | 458 | 0.2035 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | provisional-gold | 0.500 |
| cookiecutter_cookiecutter_pr1569#b3（盲） | cookiecutter/cookiecutter | 2154 | 473 | 0.2196 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | provisional-gold | n/a（落点行纯中文） |
| sbdchd_flake8-pie_pr72#b15（盲） | sbdchd/flake8-pie | 1725 | 523 | 0.3032 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | provisional-gold | 0.800 |
| mkorpela_pabot_pr651#b14（盲） | mkorpela/pabot | 1741 | 509 | 0.2924 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | provisional-gold | 0.800 |
| appium_python-client_pr646#b7（盲） | appium/python-client | 1938 | 664 | 0.3426 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | provisional-gold | 1.000 |
| workalendar_workalendar_pr32#b6（盲） | workalendar/workalendar | 2082 | 612 | 0.2939 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | provisional-gold | 0.300 |

制品（均在 `transfer/models/micro-generator-forge/`）：`forge-drafts-batch{0,1,2}.jsonl`（稿 + 锻造说明）、`forge-scores-batch{0,1,2}.jsonl`（轴表 + 代理 + 内容哈希）。

## 3. 产线基线对照：同一批情景跑**生产微编译器**（新）

工具：`tools/micro-generator/forge-line-baseline.mjs`（新）。对 148 个唯一出生单元跑 `compileV5Local(raw, {compressCtx: ctx})`（生产 JS 路径、零 API），再用**同一条尺子**打分：

| 读数 | 值 |
|---|---|
| 产线稿轴通过率（148 条去重） | M1 **148/148** · M3 90/148 · M4 **0/148** · M5 148/148 · M6 148/148 · M7 132/148 · M8 82/148 |
| 状态 | `not-gold` **148/148**（0 条 gold / 0 条 provisional-gold） |
| 压缩率 | min 0.0171 · 中位 **0.0979** · max 0.3194 |
| 生产自己的闸 `birthAccept` | **148/148 放行** |

**怎么读这三个数字**：

1. **M4 = 0/148**：产线稿全部没有"可执行验收"（窗内没有逐字命令 + 两分支）——它在生产里做对照时靠的是模板，落到任意排障情景上没给下一步落子。
2. **压缩率中位 0.098 不是"压得狠"**：`compileV5Local` 的产物是句子切片 + 模板引导词（`看清：` / `验收是：` / `改法只落一个：` 后接乱句），把 raw 剪成碎片的必然结果。示例（`canonical_operator_pr1000#b15` 产线稿开头）：`"看清：If someone passes a content dict to the constructor... 验收是：Here, the content returned by... 验收是：..."`。
3. **`birthAccept` 148/148 放行**是本表最刺眼的一格：生产闸只查"净省字符 / 发明标识符 / token 增益"，**不查"这条线有没有落到下一步"**——也就是说这套碎片会被生产原样回喂给主模型。生产缺的不是闸门数量，是 M3/M4/M8 这三条从来没进过闸。对照：锻造稿 12/12 通过全部 7 条可测轴。

**M2（不劣于产线）在本语料仍记 `未测`**：M2 的长度比较只有在产线稿本身是"可用稿"时才有意义；这里产线稿 148/148 not-gold ⇒ 这 148 条产线稿改当**真实负例**入库（见下节），M2 不接。

## 4. 受控负例：尺子判别力验证（新）

工具：`tools/micro-generator/forge-negatives.mjs`（新）。对 12 条正例各注入 7 类（含正对照）已知缺陷，检查尺子是否**精确**掉到对应轴上：

| 注入 | 期望轴 | 被抓住 | 实际触发轴分布 |
|---|---|---|---|
| baseline（正对照） | （必须全过） | **12/12** | 无触发 12 |
| fabricate-identifier（无据标识符） | M5 | **12/12** | M5 ×12 |
| second-fix-line（第二条改法） | M8 | **12/12** | M8 ×12 |
| menu-word（「或者也可以」） | M8 | **12/12** | M8 ×12 |
| apparatus-talk（沙箱白名单话术） | M6 | **12/12** | M6 ×12 |
| drop-acceptance（删验收行） | M4 | **12/12** | **M3+M4** ×12（已知耦合） |
| double（无据标识符+菜单） | M5+M8 | **12/12** | M5+M8 ×12 |

**总计 72/72 注入被目标轴精确抓住；正对照 12/12 保持全过。** 唯一耦合：删掉「验收：」整行会同时打掉 M3（闭合判读所在行）与 M4——如实记录，不粉饰。

**尺子校准语料（三个文件、以 `unitId` 为键）**：

| 文件 | 角色 | 条数 |
|---|---|---:|
| `forge-scores-batch{0,1,2}.jsonl` + `forge-drafts-batch{0,1,2}.jsonl` | 正例（7 轴全过） | 12 |
| `forge-negatives.jsonl` | 受控负例（期望轴 = 注入类型，可离线复现） | 84 |
| `forge-line-baseline.jsonl` | 真实负例（产线稿，148/148 not-gold） | 148 |

索引：`forge-ruler-corpus.manifest.json`（计数 + 复现命令，不复制正文）。

## 5. 锻造暴露的尺子行为（实测 5 条，不擅自改判据）

1. **M4 靠"验收"标记词驱动**：`#b15` 把验收并进落点行 → 首窗只剩 13 字 ⇒ M4=0；必须独立「验收：」行。
2. **M5 是 token 级、大小写敏感**：裸英文词 `bug`（证据只有 `Bug108.ttx`）被判无据 ⇒ 新语料的已知过严点；是否放宽留给判据所有者。
3. **M5 的切段规则**：锚点按 `.`/`/`/`-`/驼峰切段，**下划线不切** ⇒ 单独写 `pie785` 不算在证据里（整串 `pie785_celery_require_tasks_expire.py` 才算）。锻造规则：落点按完整符号名写。
4. **M3 的 ⇒ 后面必须跟结论词**：`⇒ 现状未被破坏` 不闭合，`⇒ 说明现状未被破坏` 才闭合（模式是 `⇒ (说明|就是|即|意味着|不能|得换|要)`）。
5. **M5 确实在抓"未来知识"**：`ops/model.py`、`fontInfoData.py`、`pre_commit_hooks/fix_encoding_pragma.py` 三条路径与 `remove=False`、`python -m pytest …` 这些形态在出生时刻的 ctx 里都不存在（是出生后才出现/才执行的），一律不可引用——这就是"标签不许偷看未来"的机械保证。

## 6. 当前的卡口（唯一）与下一步

- **E1/E2 需要把压缩块喂回目标模型（DeepSeek-V4.1-Flash）真跑**——需要端点。没有端点，本语料全部标签的上限就是 `provisional-gold`。
- M2 不接（产线稿在异分布上不是可用稿）；R1/R2 是 CFB 台账概念，本语料用来源钉扎代替（revision + shard + file_row_number + raw/ctx/draft 三个 sha256）。
- 锻造吞吐 = 评审吞吐（本日 12 条/3 批），普查批尚余 132 条，可继续按批推进。
- 可直接支撑"尺子"的一切已经就位：判据（生产代码）+ 正例 12 + 负例 232（84 受控 + 148 真实）。在拿到端点前，这是可以在离线继续加厚的一侧。
