《DSH 模型行为品质工程 · 完整演进史与认知沉思录》

记录周期：2026-08（跨越上千步真实会话与数万次工具调用）
实验平台：DeepSeek Harness (@deepseek-ai/dsh rc.6) · Web GUI (:3000) · Windows
核心目标机：deepseek-v4-flash @ openmodel.ai（中转 anthropic-messages 协议线）
对照标杆：deepseek-v4-pro 灰测版顶尖思维链（9 组全量工业级逆向样本）
主线命题：如何通过外挂引导（Agent
Scaffolding），将一个受限于参数容量的小模型（Flash），从“发疯、试探、死锁、自欺”中拯救出来，养成稳重、细心、诚实的工程师品质？

序言 · 我们的理想与立论之基

“我们无法让一个普通人拥有天才的智商，但我们能让普通人学会稳重、细心等品质。”

这是一切的源头，也是贯穿整场探索的唯一灯塔。

在这个项目中，我们从不幻想修改模型的权重（参数能力是预训练给定的，改不了）；我们做的一切，是在认知与行为层为模型建立一套不可磨灭的“工程品格”：

  - 稳重（不盲动：公理先行、先做预算、该停就停）；
  - 细心（不放过：探针先证伪、程序化断言、改动必终验）；
  - 诚实（不自欺：破除一致性陷阱、技术能跑≠需求达成、接近≠通过）；
  - 克制（不执器：达标即止、现实细节是启发而非打勾清单）。

这是一部由一位初三 OIer 在无数个深夜里，面对 Token
的极度紧张、面对一次次黑屏与死锁，拒绝任何虚伪断言与跑分作弊，凭借**“一版一变量”与“思维链逐字定性 Diff”**硬生生砸出来的工程血泪史。

第一卷 · 认知公理与创作哲学（为什么这样设计？）

这一部分不是教条，而是从上千次失败与顿悟中凝聚出来的二十三条认知公理：

1. 神/鬼二元性（Dual-Attractor）

发现：同一模型在 spec 条件下维护任务拿 99 分，greenfield 任务仅 6 分；react 条件下正好反过来（10
vs 91）。摆动分数的不是模型智商，而是 Prompt 激活的吸引子状态。 推论：优化模型 =
优化边界条件（引导与工具面），而不是换模型。

2. 行为的相变分带性（Phase Banding）

发现：Persona 轴 21 个连续模式点实测呈现“三带相变”：稳定 spec 带（0-0.19）、不稳定过渡带（0.2-0.49）、稳定 react
带（0.5-1.0）。 推论：连续旋钮是幻觉，路由只选稳定带，过渡带永不自动选取。

3. 复刻训练分布（RL Native Attractor）—— B 版神力的源头

发现：B 版预设（router-rl）仅用一句话 You are a helpful software engineer assistant. +
双工具（bash + str_replace_editor），在无任何引导下跑出了惊艳全球的 7457f（Poolrooms 一遍写对、0.92
曝光、水法线与焦散自发涌现）。 推论：这是 DeepSeek 在代码 RL
阶段最原生的奖励最高分布。首轮工具面必须复刻此分布，工具目录必须在首次工具调用后才动态提升（Promotion）。

4. 近场注入的时空敏感性（Near-Field Waterfall）

发现：头部绑定句与尾部拼接入参，推理字符差距可达 15~20 倍（4169 vs 200）。Flash 对指令位置极度敏感。 推论：引导必须作为独立消息，在
agent/pre-step 瀑布流中紧贴最新真实用户输入注入，且单轮仅注入一次。

5. 结构条款有效，内容清单反噬

发现：告诉模型“先定坐标，再定氛围，最后定材质”（结构纪律），模型 27 步 Oneshot
交付；告诉模型“每个表面都要照亮、必须有磨损与污渍”（内容清单），模型应激引发 5 个巨大矩形光与 SpotLight 42 的“加灯风暴”（7757b）。
推论：治思维链病用结构、顺序与物理因果；写具体清单必遭反噬。

6. 零环境假定（Zero-Assumption Robustness）

发现：真实用户环境千奇百怪（无 PIL、无特定浏览器环境、报错多义）。试图在 Harness 里做特定报错拦截、或在 Prompt 里喂 API
链接，都是温室跑分作弊。 推论：模型必须具备在黑暗中用 curl 抓源码、自制 C# 像素探针的自适应生存本能。

7. 破除自证陷阱（Consistency ≠ Fidelity）

发现：99A 坦克复盘血泪（94d3）与 Poolrooms 伪交付（efdd6f70）铁证：模型可以用“编译器 0 报错 + 截图均值非黑 + 自定义
Shader 跑通”来宣布成功，而实际上地板根本没开洞、水面完全不透明。 推论：技术可运行 \neq 需求达成。
自检若只基于自己脑补的数字，就是完美的闭门造车；验证必须死死锚定观察者视角的真实空间事实。

第二卷 · 架构蓝图与运行机理

整个系统由 DSH Cordis 插件体系、三层上下文架构与物理状态机 共同驱动：

┌────────────────────────────────────────────────────────────────────────┐
│  任务需求层 (Task Spec)   ── 载体: PROMPT.txt / 用户输入 (零喂饭、纯意图)   │
├────────────────────────────────────────────────────────────────────────┤
│  细化分诊层 (DETAIL_GUIDE) ── 载体: solve / visual / exec / info 四大学科因果 │
├────────────────────────────────────────────────────────────────────────┤
│  通用姿态层 (RL_GUIDE)     ── 载体: 4 大品质 / 12 黄金法则 Pro 完全体 (<250词) │
├────────────────────────────────────────────────────────────────────────┤
│  系统脚手架 (Harness)      ── 载体: router-bootstrap-v1.mjs + DSH 运行时    │
│  - 2工具起手 (bash+editor) ──> 首次调用后动态提升 (Promotion) 全目录          │
│  - 真实用户消息过滤 (source.kind === 'user') + agent/pre-step 近场注入   │
│  - 物理死锁截断 (Chrome --user-data-dir 隔离 + 退出 kill)                 │
└────────────────────────────────────────────────────────────────────────┘

核心运行时代码定稿（router-rl-minimal）

1. 通用引导：RL_GUIDE（734 字符 / 4 大品质 / 12 黄金法则 Pro 实战完全体）

const RL_GUIDE =
    GUIDE_HEAD + '\n[行为品质·Pro实战完全体] 4 品质 / 12 黄金法则。只定姿态与认知流水线：\n' +
    '① 稳重（先算后动）：' +
    '1 空间与公理先行：新任务彻底清场重建，先定公理化坐标系与几何规格，再定物理基调，最后推演材质细节，基础未定不堆细节；' +
    '2 前向物理锁定：落笔前预估叠加效应（Watch the sum：光照/自发光/管线衰减防过曝，介质透射自洽），首发锁定参数，杜绝盲调试错；' +
    '3 离线预算与证伪：复杂逻辑与空间布局优先用离线脚本/确定性推导展开，算清运行时预算，降本不降质；面对歧义先造反例证伪。\n' +
    '② 细心（深思后验）：' +
    '4 业务与空间断言优先：90% 推理在先，落笔必断言空间可见性与业务事实（如开槽/遮挡/透光），断言业务而非仅查语法，验证是门禁不是梯子；' +
    '5 最小单变量探针：出错用最小样本隔离根因，一次只变动一个变量；' +
    '6 改动必落地与终验：每次改动必确认落地，交付前最后一次修改必须有真实验证闭环；' +
    '7 探针先证伪：现象反常先验证观测工具与探针本身（文件大小/截图帧/CDN），再查管线环境与逻辑，最后才改场景参数，绝不盲目归因。\n' +
    '③ 诚实（绝对达标）：' +
    '8 破除自证陷阱：“技术可运行≠需求达成，非黑无报错≠画面正确”，严禁以管线存在代替感知达成（如不透明水面），必须逐条核验观察者视角真实空间事实；' +
    '9 单一事实源：同一几何/数值只允许一个权威来源，严禁复制副本（两处使用立即抽取公共函数），杜绝设计代码漂移；' +
    '10 验证权威完整：验证手段必须可靠且覆盖全局，手段不足时不以偏概全。\n' +
    '④ 克制（达标即止）：' +
    '11 判据达标即止：判据满足立即收工交付（Commit rule），不反复自疑，不发起多余修饰；' +
    '12 启发而非清单：工具是手段产物是目标；现实细节是启发（hints）而非机械打勾清单，自主推演所需。';

2. 细化分诊：DETAIL_GUIDE（四大学科因果流水线）

const DETAIL_GUIDE = {
  solve:
    '\n\n[detail · algorithm/code task] 数学与工程因果推演：\n' +
    '先冻结坐标系、硬点/全局参数与交付形态；验证器与生成器共享同一数据源，禁止两套逻辑分叉。' +
    '先算状态空间/复杂度/成本预算；主算法带保守回退与边界兜底，不做过度抽象框架。' +
    '纯算法核心与 DOM/IO 分离；自测断言残差、约束保持、对称、连续性与有限性。' +
    '完成 = 数值与逻辑零残差 + 需求逐条核对 + 真实环境运行；不实现未要求的抽象/伪兼容。',

  visual:
    '\n\n[detail · visual task] 物理因果推演流水线：\n' +
    '1 空间公理：先定死绝对尺寸与空间坐标系，基础未定绝不调光影；\n' +
    '2 物理因果布光：光照与材质是能量乘积（考虑管线衰减与叠加防过曝），拒绝无影棚式泛光；\n' +
    '3 介质分层推导：水/玻璃等介质由光吸收深度与菲涅尔决定（深浅分层与折射），表面受潮/磨损自发引起粗糙度突降，从物理因果推演参数，拒绝生硬默认值；\n' +
    '4 细节生长与预算：微观细节在参数化生成层随骨架生长，不后贴；堆细节前先定几何/绘制/曝光预算，用渲染顺序与色调映射（ToneMapping/ACES）保护宏观基底。',

  exec:
    '\n\n[detail · setup/fix task] 命令输出是验证器：\n' +
    '先建立可重复验证闭环（headless 构建测试、数值探针、真实运行）。' +
    '失败先程序化探针定位根因（打印坐标/区间/计时），再视觉确认；区分真假阳性与数值病态。' +
    '单变量隔离，每次改动确认落地；性能问题先计时定位再优化，不盲重试、不以“没报错”当完成。',

  info:
    '\n\n[detail · research/info task] 来源是验证器：\n' +
    '引用原文、区分事实与推断、标注不确定性；明确“内部一致性 ≠ 真实性”，写清验证盲区。' +
    '完成 = 需求逐条核对 + 关键事实原文引述 + 标注已知盲区；答完即止，严禁发散。',
}

第三卷 · 编年史：从暗夜摸索到认知觉醒

这是一段充满了波折、狂喜、阵痛与重构的漫长远征。

[第一纪元: 基石] ──> [第二纪元: 封神] ──> [第三纪元: 水肿] ──> [第四纪元: 觉醒与巅峰]
Minimal 双工具        Boats! 5:50 满分     6000字加灯风暴         9组 Pro 逆向 + abd9af3e
相变三带发现          BRUTE-FORCE LAW     注意力税与死锁         空间公理与自适应落地

纪元 I · 蛮荒与基石（阶段 0-1 · 2026-08 上旬）

1. 工具身份决定论（Anchored-Standard）

  - 困境：Standard 全目录模式只有 91 分，模型在 25 个工具间无所适从、到处试探。
  - 突破：发现首轮给真实双工具 Schema（bash + str_replace_editor），模型行为当场收敛，以 98/99 分稳定输出。这奠定了
    “复刻 RL 训练分布” 的最高指导思想。

2. 路由分诊与近场注入的诞生（v21 / v22）

  - 战役：修复了插件消息误触发锁死弱模式的 Bug（F1），设立了 32768 的 maxTokens 护栏（F2），首创独立于用户消息尾部的
    agent/pre-step 瀑布近场注入机制。

纪元 II · 黄金时代与算法封神（阶段 2-3 · v2.2 \rightarrow v3.0）

1. Boats! 算法战役（oj-bench P2 · 40 测试点满分破纪录）

  - 战况：算法模型一度陷入 20 分钟考古裁判代码（rl-x）、暴力枚举最优性证明的泥潭。
  - 定稿：确立了震惊业界的 BRUTE-FORCE LAW——“暴力只用于验证一个难证的推导结论一次，Judge 才是验证代码正确性的唯一裁判”。
  - 战果：rl-ab 创下 5分50秒 / 86K 推理 / 18 工具 / 40-40 全通过的巅峰战绩！ 彻底确立了通用引导的骨架。

2. j-space 协议大清洗

  - 实证：对照实验（rl-t vs rl-u）表明，注入完整 170KB 的 j-space 协议导致严重的上下文污染（负优化）。
  - 果断决断：彻底从模型环境中抹除 j-space，仅保留注释理念，实现模型环境零残留。

纪元 III · 规则水肿与加法深渊（阶段 3 · v3.1 \rightarrow v3.9.1）

这是整个工程最痛苦的弯路：我们陷入了“出问题 \rightarrow 加规则”的打地鼠死循环。

1. 物理计算的超时（黑洞 rl-bh）

  - 模型写了极度严密的 Kerr-Newman 度规与 RK4，但 600 步 \times 130 万像素卡死 Chrome。由此催生了 v3.1
    运行时预算条款（降实现成本不降质量）。

2. 视觉任务的崩溃与“加灯风暴”（v3.7 \rightarrow v3.9.1）

  - 惨痛教训（7757b）：为了让场景“变亮、细节丰富”，我们在 v3.9.1 加入了 ABC 具象条款（every visible surface）。
  - 反噬现场：模型应激生成了 5 个 20×14 米的巨大矩形光源 + SpotLight 42，造成全屏死白、天花板全黑、水体变成 0.9 浓度的塑料板。
  - 反思：当 Prompt 充斥着具体要求时，模型从“思考者”退化成了“应激打勾机器”。

纪元 IV · 向死而生的大裁军与 Pro 逆向战役（阶段 4 · v4.0）

1. 极简 12 法则首测（session-18c4e7e8 · 61 工具的沉思）

  - 战况：大刀阔斧将 6000 字砍到 200 字极简 12 法则。无加灯风暴、无结构错位，但工具数飙升到 61 步（16.7 分钟）。
  - 穿透根因：极简版给出了“道德要求（要细心要稳重）”，却阉割了 v3.8.6 的设计顺序（Design Order）与 v3.9
    的物理前向预算（Watch the sum），导致模型首发曝光写成 1.15，随后陷入了 30 轮后验盲调试光循环！

2. 探针陷阱的血泪教训（session-82f74861）

  - 现场：Chrome 截出了 112KB 的暗图（实质是 CDN 未加载完的旧帧），模型在 Step 29 恐慌归因：“是不是我改了 waterY
    导致画面黑了？”，疯狂修改代码，死锁在第 42 步无法交付。
  - 顿悟：模型缺少 “探针先证伪” 的本能！排错必须先查探针，最后才改场景。

3. 解剖 9 组 DeepSeek V4 Pro 顶尖思维链

我们调集了灰测版 V4 Pro 的全量实战样本（33b 武直、6635 悬挂、7d8f 涡喷、94d3 坦克/审计、cd044 黑洞/相机、eb781
古建、f4b 赛博朋克），逆向提纯出世界顶级模型的五大因果律：

1.  公理化空间定界（ISO 8855 坐标系先行）；
2.  确定性离线展开（自己写 GLSL \rightarrow JS 转译器离线测物理，不靠运行时碰运气）；
3.  程序化断言优先于视觉（网格体积数学校验秒抓顶点反向绕序）；
4.  探针先证伪与管线归因（排查出 three.js r155+ BRDF 除以 \pi）；
5.  破除自证陷阱（consistency ≠ fidelity）。

4. 终局之战：session-abd9af3e（Pro + 4/8 加固首飞）

  - 对阵：空工作区、零 Prompt 喂饭、无 Python PIL 库、Flash 无法看图。
  - 壮举：
      - Step 3 空间断言先行：池底可见瓷砖网格，光线透过水面在池底形成光斑；
      - Step 10 Oneshot 千行成稿：地板真的用 THREE.Shape + holes 挖出了泳池槽口，水体设置 transparent:
        true, opacity: 0.6 + 折射着色器，池底网格与台阶真实穿透可见；
      - 自适应降级：环境缺库，自发写 C# 提取青蓝比；
      - 44 步一轮平稳交付！ 彻底打破了以往“技术合规、空间全错”的伪交付魔咒。

第四卷 · 战场档案与全量数据碑

Poolrooms（3D 池核基准）历史全景数值对照表

| 轮次 / 会话 ID   | 生效版本与预设                               | 工具数    | 推理 Token | 时长       | Exposure | 水体物理状态                                           | 核心特征与思维链定性                                                          |
| ------------ | ------------------------------------- | ------ | -------- | -------- | -------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| **7457f**    | **B 版 (router-rl)**<br>0 引导基线         | 43     | 128.1K   | 10.9m    | 0.92     | `waterColor 0x1e5b61`<br>法线 + 焦散                 | **灵性标尺**：Oneshot 惊艳，但无底线兜底（偶发漏终验、折射造假）。                             |
| **13836**    | **v3.8.6**<br>设计顺序铁律                  | **27** | 134.9K   | **9.2m** | 1.12     | `transmission`<br>(无 waterColor)                 | **极速标杆**：Oneshot 比肩 B 版，设计顺序（坐标$\rightarrow$氛围$\rightarrow$材质）大获全胜。 |
| **ea992**    | **v3.9**<br>质感与校准                     | 29     | 128.3K   | 12.9m    | 0.92     | `Water.js 0x5f9f9e`<br>sunDirection              | **质感标尺**：Watch the sum 生效，首发锁定 0.92；但引导膨胀至 6000 字。                  |
| **7757b**    | **v3.9.1**<br>ABC 具象条款                | 23     | 120.5K   | 11.1m    | 1.08     | `alpha 0.9` 不透明                                  | **加灯风暴（恶化）**：5 个 20×14m 矩形光 + SpotLight 42，白墙过曝、天花板黑。               |
| **18c4e7e8** | **极简首测**<br>12 法则初稿                   | 61     | 171.9K   | 16.7m    | 0.82     | `Reflector` 镜面水                                  | **方向正确但缺少因果**：行为底线稳，但首发没物理锚点，后验盲调 30 步。                             |
| **82f74861** | **探针陷阱轮**<br>12 法则未重启                 | 42     | 170.5K   | 卡死       | 未知       | 变暗归因错位                                           | **反面教材**：Chrome 路径摸索耗 7 步，旧帧暗图误判为业务代码错误，死锁。                         |
| **1a8df2f4** | **PROMPT 修复轮**<br>单行截图生效              | 65     | 134.7K   | 13.5m    | 正常       | 自建 `_test` 探针                                    | **命令生效**：7 步路径摩擦归零；但在 Headless 首帧异步问题上排查 22 步。                      |
| **efdd6f70** | **Pro 初测**<br>接续打磨补丁                  | 37     | 167.1K   | 12.1m    | 1.13     | `opaque. That's okay`                            | **自证陷阱**：Shader 0 报错、截图非黑，但地板没开槽、水面不透明，伪交付。                         |
| **abd9af3e** | **Pro+4/8 加固**<br>`router-rl-minimal` | **44** | 187.4K   | 14.8m    | 0.90     | **`Shape+holes` 真开洞**<br>**`opacity:0.6+折射` 见底** | **终极胜利**：空间公理完全落地，单次 write 千行一次成稿，恶劣环境自发生存并交付！                      |

第五卷 · 技术知识库与避坑圣经

这是用成百上千次报错和白屏换来的真实技术公理，供后续所有任务无条件继承：

1.  WebGL Headless 离线截图首帧铁律：
      - 在 Chrome CLI Headless 截图模式下，requestAnimationFrame 不一定会立即触发首帧渲染；
      - 代码中必须包含一行显式的同步渲染 renderer.render(scene, camera)，否则截图必为全黑。
2.  Three.js r155+ 物理光照衰减公理：
      - Three.js 自 r155 起在 PBR BRDF 中除以了
        \pi，光源默认强度需要与物理环境光强平衡，且光照能量具有绝对叠加性（Additive）；
      - 必须在设计阶段锁定 环境光 + 自发光 + Bloom + ToneMapping 总和，拒绝后处理白屏溢出。
3.  介质水体光学与几何必须同时自洽：
      - 水面真实感的第一前提是地板几何开槽（Floor Cutout）；
      - 必须使用 Beer-Lambert
        深度吸收与视线入射角菲涅尔（透射为主、浅透深浓），严禁使用单一不透明度和粗暴的镜面全反射贴图（Reflector）。
4.  单一事实源（Single Source of Truth）：
      - 任何空间常量、对称坐标、几何生成方程，只允许存在一份权威声明；
      - 严禁在左侧与右侧分别硬编码两套计算，两处使用必须立即抽取共享纯函数。
5.  排错的绝对因果顺序：
    \text{验证观测探针有效性} \longrightarrow \text{底层管线与环境输入} \longrightarrow \text{代码空间逻辑} \longrightarrow \text{最后才动场景参数}

尾声 · 写给未来的自己与探路者

翻开这份厚重的留痕，我们走过了一条不可思议的认知闭环：

我们从最开始惊叹于 B 版的“神性灵性”，到后来因为一次次瑕疵而焦虑地加上一条条规则，把系统生生推入了 6000 字合规监牢的深渊；
我们在加灯风暴与死锁中痛苦撞墙，又在冷酷的数据面前毅然决然地完成了“大裁军”；
我们深入解剖了世界第一的 9 组顶尖 Pro 思维链，终于参透了“提要求是毒药，教因果是神丹”的真谛；
最终，我们在 session-abd9af3e 里，看着一个小参数模型在完全没有人类喂饭的黑暗环境中，凭借 12
条公理，自己查文档、自己写探针、自己切出物理开口、自己推演折射，平稳交付出千行大作。

这一路，我们证明了：智能体的品质不是天赐的，是可以在行为层被严格规训与塑造的。

致未来的你： 不要迷信冗长的提示词，不要被局部的指标欺骗，不要在实验室的温室里跑分。 守住四公理，守住一版一变量，守住对事实的敬畏。

地图已经绘就，前路坦荡无垠。带着这套骨骼，去征服更大的世界！


---

# 附录 · 历史补遗与操作手册

## 历史补遗（正文未收录但必须继承）

### 1. thinking-effort 插件事故（2026-08-19，Windows）
- `@hytime/dsh-thinking-effort` 插件曾导致模型思考不落隐藏 reasoning，全部漏到表面文本（思维链"没了/垃圾"）。
- 证据：Windows 好会话（7457f）`reasoning:41`/text 1 块；坏会话 `reasoning:0`/text 20 块/maxTokens 384000。
- **处置**：已从 Windows profile 的 `package.json`（dependencies + bundles）移除 thinking 插件，删掉 node_modules junction。
- 备份：`C:\Users\Administrator\.dsh\profiles\web\package.json.bak-thinking`；插件源码仍在 `D:\dsh\dsh-thinking-effort`。
- 教训：第三方"增强思考"插件可能反而破坏 DSH 的隐藏推理链；加载前必须实测 reasoning 是否仍正常。

### 2. PROMPT-78.txt 截图命令修复（2026-08-19）
- 原坏命令：`chrome` 无全路径、`--headless=new`、固定 `chromeprofile` → 模型开局浪费 7 步猜路径/试 headless。
- 已替换为**实测通过的单行命令**（Windows）：
```powershell
Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force; $url='file:///D:/dsh/tools/poolcore/poolrooms.html?screenshot=1'; $chrome='C:\Program Files\Google\Chrome\Application\chrome.exe'; $out='D:\dsh\tools\poolcore\shot.png'; Remove-Item $out -ErrorAction SilentlyContinue; $p=Start-Process -FilePath $chrome -ArgumentList @('--headless','--no-sandbox','--hide-scrollbars','--enable-unsafe-swiftshader','--use-angle=swiftshader','--virtual-time-budget=8000','--window-size=960,540',"--user-data-dir=D:\dsh\tools\poolcore\chromeprofile_shot",("--screenshot=$out"),$url) -PassThru -Wait -NoNewWindow; Start-Sleep -Milliseconds 500; if(!(Test-Path $out)){throw 'screenshot missing'}; Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
```

---

## 操作手册（实操命令，新对话必读）

### 1. 会话解压与读取
```powershell
node D:\dsh\research\session-runs\decompress.mjs "C:\Users\Administrator\.dsh\sessions\session-XXXX" "D:\dsh\research\session-runs\xxx-run.jsonl"
```
- 会话目录：`C:\Users\Administrator\.dsh\sessions\session-XXXX\`（内容 `session.jsonl.zstd`）
- 解压产物是 JSONL，逐行 `JSON.parse`；按 `reasoning-chunks` 的 `data.step` 聚合思维链。

### 2. 分析脚本（D:\dsh\research\session-runs\）
- `verify-guide.mjs`：打印 RL_GUIDE / visual / 总量（改引导后必跑）
- `scan-wsl-session.mjs`：会话基础统计（工具/推理/注入验证）
- `scan-format.mjs`：reasoning 块/text 块/stopReason 检查
- `tool-timeline.mjs`：按 step 输出工具调用序列
- `reasoning-search.mjs`：在思维链中按关键词搜索并打印上下文
- `step-reasoning.mjs`：打印指定 step 的完整思维链

### 3. 重启 DSH 标准姿势（Windows）
- 查进程：
```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bin.js web' }
```
- 重启：`Stop-Process -Id <PID>` → 同命令后台起（建议日志重定向：`node ...\lib\bin.js web *> C:\Users\Administrator\.dsh\web.log`）
- 改引导后**必须重启**（ESM 按 URL 缓存）；重启后先验证注入版本（新会话第一条消息查引导文本）。

### 4. 引导注入验证
- 新会话解压后，找 `user/message` 中 `source.kind==='plugin'` 且含 `[路由注入·引导消息]` 的条目。
- 检查 RL_GUIDE 关键词：`Pro实战`、`空间与公理先行`、`业务与空间断言优先`、`技术可运行≠需求达成`。
- 检查 DETAIL_GUIDE 关键词：`物理因果推演流水线`、`数学与工程因果推演`、`命令输出是验证器`、`来源是验证器`。

---

# 附录：2026-08-21 ~ 08-23 dsh-visual-studio 落地与思维链复盘

> 本附录记录从“粘贴 Pro 源码”到“最新版跑完”的完整闭环，供上下文压缩后直接恢复。

## 一、本轮核心目标

让 deepseek-v4-flash 在**无多模态视觉**、**纯文本意图 Prompt** 前提下，写出专业级 Three.js 产品展示：
“一遍写好、写精、写快、写专业”。

- 不是“只许写一次不许改”
- 不是“禁止环境检查”
- 不是“喂一个现成模板”
- 不是“把审查做成复杂系统”

正确姿态：**写前仔细思考 + 写时认真严谨 + 写前检查环境（好习惯） + 写后简单快速全面终验**。

## 二、从 Pro 源码提炼的三大核心认知

解剖 4 份世界级源码（精密腕表 / 涡喷发动机 / 黑洞 / Poolrooms）后，Pro 的底层能力只有三条：

1. **空间双字典化（No Hardcoded Coordinates）**
   - 代码头部先定义二维平面锚点字典 `POS` 与一维轴向高度阶梯 `ELEV / Z_Stack`
   - 所有零件从字典取值计算，从数学上根治零件横竖错乱、前后分离。

2. **材料语义对比分层（Semantic Contrast）**
   - 从不全场单一灰色。
   - 工业实体必然拆解为：
     【大面积结构基底（中糙中性） + 高反差核心功能件（强反光高对比） + 高光/发光点缀件】
   - 视觉层次自发涌现。

3. **零外部依赖与算法生成（Zero-Asset Self-Containment）**
   - 不依赖外部图片 URL。
   - 微观拉丝、纹理全靠 Canvas2D 纯代码生成。
   - 透光介质用高光清漆模型替代卡死的 transmission。
   - 布光必有侧向条形轮廓光（Rim Light）拉出金属勾边。

## 三、最终定稿的认知引导（router-bootstrap-v1.mjs）

### RL_GUIDE（4 品质 / 12 黄金法则）

最终版要点：

- ① 稳重：空间与公理先行、前向物理锁定、离线预算与证伪
- ② 细心：业务与空间断言优先、最小单变量探针、写前确认环境 / 写中逐段自检 / 交付前快速全面真实闭环终验、探针先证伪
- ③ 诚实：破除自证陷阱、单一事实源、验证权威完整
- ④ 克制：首发质量达标且闭环验证通过后立即收工、启发而非清单

### DETAIL_GUIDE.visual（最终纯净版）

```text
【阶段一 · 空间形体与材质基底（地基阶段）】
1 空间公理与拓扑定界：
   写前确认环境，统一纯英文代码；
   装配/多体实体必须在逻辑层先建立【平面锚点 POS】与【轴向层级 ELEV】标尺体系（z_next = z_prev + offset）；
   所有零件依附根 Group 展开，严禁散落全局绝对坐标致前后脱节；
   图元朝向归一必须在 Geometry 顶点数据层变换（如 geom.rotateX(Math.PI/2)），严禁旋转 Mesh 自身破坏局部坐标系；
   视线场/隐式计算先定死相机正交基与步长边界。

2 材料语义三位一体：
   拒绝全场景单调同色；
   严格依物理语义构建【大面积结构基底 + 高反差核心功能件 + 高光/发光点缀件】材质对比体系；
   全金属表面依物理量化环境反射（亮 Studio 环境），自发光定标。

★ 检查点一（冒烟断言）：
   写完基础骨架与材质后【立即执行第 1 次冒烟检查
   （node --check 语法 + capture_shot 验证能跑、非黑屏、大形体无错位）】；
   地基未通过，绝对禁止进入阶段二！

【阶段二 · 微观细节与光感升华（完成阶段）】
3 完美细节生成因果：
   在已验证骨架上生长细节——遵循
   ① 功能因果律：每个零件必有输入/输出或力学支撑闭环，严禁凭空添加无关联孤立运动件；
   ② 尺度层级律：外覆件与微观倒角遵循比例阶梯，严禁未缩放的默认臃肿图元；
   ③ 拓扑嵌套律：相接零件必有配合面、贯穿孔或倒角过渡，禁止盲目相交穿插；
   薄层透光介质优先采用高光清漆模型（opacity: 0.05-0.12 + clearcoat: 1.0 + depthWrite: false）；
   水面/折射采样副本防 FBO 回环；
   动画交互映射到有界状态机（lerp + clamp(t,0,1) 严禁无限制漂移）；
   同模块修改必须在思维链全盘推导后单次批量合并写入，禁止零散多次微调。

4 光感、环境与预算闭环：
   构建【主塑形光 + 侧后轮廓勾边光 + 弱环境底光】拉出流线高光；
   ACES 保护动态范围（细分 16-24 防软渲染卡死）；
   首帧必须执行同步 renderer.render(scene, camera)；
   写完执行【第 2 次终验】，确认细节光感与交互达标后，立即交付！
```

## 四、任务需求层（PROMPT-WATCH.txt 已纯净化）

```text
使用 HTML5 与 Three.js 构建一个 Apple 风格的极简精密陀飞轮机械腕表悬浮展厅。
具备蓝宝石表镜、拉丝钛金属机芯夹板、镂空传动齿轮组与微视差阻尼交互。
```

- 100% 纯净，零喂饭，零工具提示。
- 输出路径由运行环境/会话上下文给出，不写进 Prompt。

## 五、脚手架工具层最终状态（D:\dsh\tools\dsh-visual-studio\）

### 1. capture-shot.mjs
- 跨平台无头 Chrome 确定性截图。
- 自动探测浏览器、SwiftShader 软渲染兜底。
- 默认 8 秒硬超时，超时/失败强杀进程树。
- **错误自述能力**：`--enable-logging=stderr`，超时/失败时输出 `[BROWSER_LOG]`，含 console.error / console.warn / 未捕获异常。
- 输出三态：`[OK]` / `[TIMEOUT]` / `[FAIL]`。

### 2. inspect-scene.mjs（已精简为外部安全读取）
- **剥离所有侵入式 AST 注入 / HTML 补丁 / eval 探针**。
- 只通过 iframe 外部读取 `window.__STUDIO__` / `window.scene` / `window.renderer`。
- 输出硬预算：
  - Triangles ≤ 80k
  - DrawCalls ≤ 50
  - Pass ≤ 3
  - DPR ≤ 2
  - 曝光黄金带
  - 首帧同步渲染
- 不再输出噪音型 `Z_FIGHTING_RISK`，不做轴向/物理能量注入式分析。

### 3. lib/ 纯函数库（保留，无侵入）
- `three.r152.min.js` / `RoomEnvironment.js` / `OrbitControls.js`
- `studio-core.js`：ACES、亮 Studio PMREM、同步渲染、截图模式
- `studio-pbr.js`：Canvas2D 程序化拉丝/微噪/Beer-Lambert、亮影棚、Blit 副本

### 4. 插件注册
- `@dsh-external/dsh-visual-studio` 已安装进 profile=web。
- 注册 3 个工具：
  - `dsh_visual_studio_init`
  - `dsh_visual_studio_capture_shot`
  - `dsh_visual_studio_inspect_scene`
- 纯文本主模型已屏蔽 `read_image` / `vision_*` 多模态工具，避免自相矛盾视觉反馈带偏。

## 六、思维链复盘（Run 0 → Run 11）

| Run | 现象 | 结论 |
|---|---|---|
| Run 0 | 一次性写对坐标系，但截图卡死 | 工具层不可靠会拖死模型 |
| Run 2/3 | 工具被用上，但空间错位；subagent 视觉自相矛盾 | 需要空间硬断言，视觉反馈不可靠 |
| Run 4/5 | inspect 超时/噪音，模型被带偏 | 工具噪音会反噬 |
| Run 6 | 页面无法渲染，vision 反复矛盾 | 主模型不应碰多模态视觉 |
| Run 7/8 | 中文串语法错误；自检抓到但页面仍不渲染 | 编码/工具问题拖后腿 |
| Run 9 | 修复真实运行时错误；编码/工具参数浪费步数 | 能力在涨，效率没涨 |
| Run 11 | 语法干净，几何推演精细；未用脚手架工具，被中断 | 写前规划/写中自检已建立，但终验未闭环 |

关键教训：

1. **模型的自检目前是外部驱动**：你不提醒“我看不到”，它就不主动截图/验证。
2. **真正精细 = 结构真实 + 材质微观 + 光照物理 + 装配树 + 参数语义 + 性能预算**，不是堆细节。
3. **审查不是优化轴**；优化轴是“写前想清楚、写中认真、写后简单快速全面终验”。
4. **环境检查是好习惯，不能砍**。
5. **不要喂模板**；教通用物理因果（POS/ELEV、材料语义分层、程序化纹理）。

## 七、常用操作（上下文压缩后快速恢复）

```powershell
# 解压会话
node D:\dsh\research\session-runs\decompress.mjs "C:\Users\Administrator\.dsh\sessions\--D-dsh--\session-XXXX" "D:\dsh\tools\dsh-visual-studio\stage1-watch\runX.jsonl"

# 扫描/分析
node D:\dsh\research\session-runs\scan-wsl-session.mjs <run>.jsonl
node D:\dsh\research\session-runs\tool-timeline.mjs <run>.jsonl
node D:\dsh\research\session-runs\reasoning-search.mjs <run>.jsonl "<pattern>"
node D:\dsh\research\session-runs\step-reasoning.mjs <run>.jsonl <step>

# 重启 DSH（改引导后必须）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bin.js web' } | Stop-Process
dsh --profile web --port 3000

# 插件重编译（src/index.ts 变更后）
node "C:\Users\Administrator\AppData\Roaming\npm\node_modules\typescript\bin\tsc" -p "D:\dsh\tools\dsh-visual-studio\tsconfig.json"
```

## 八、当前待办 / 下一步

- 让“交付前终验”成为模型**内部默认动作**，而不是等用户提醒。
- 观察最新纯 Prompt + 新引导的下一轮是否能：
  - 一遍写对（无语法错误）
  - 主动调用 capture-shot / inspect-scene 做终验
  - 达到 Pro 级“空间双字典 + 材料语义分层 + 程序化纹理”质感
- 继续精简工具噪音，但保留环境检查与简单终验。

---

# 附录 B：2026-08-24 环境修复 / capture-shot 重写 / 引导升级 / 三轮思维链复盘

> 本附录记录从“环境搞坏准备卸载”到“CDP 截图工具跑通 + 两阶段双检查点引导落地”的完整过程。
> 上下文压缩后直接读本附录 + 附录 A 即可恢复。

## 一、备份状态（卸载前）

- 备份根目录：`D:\dsh-backup-20260823-190744\`
  - `project-dsh\` = 项目 `D:\dsh` 全量（约 353 MB，含 tools / research / history 等）
  - `agent-presets\` = `.dsh\.agent-presets` 全量（6 个预设，含 router-rl-minimal）
  - `dsh-userdata\` = `.dsh` 整体备份（曾被“去看思维链”打断，目录存在但**完整性未最终确认**）
- 关键文件哈希已核对 MATCH：`router-bootstrap-v1.mjs` / `router-core.mjs` / `SESSION-NOTES.md` / `PROMPT-WATCH.txt` / `src/index.ts` / `bin/*.mjs` / `lib/*.js` / `package.json` / `cordis.patch.yml`
- 用户最终没有继续卸载，转向排查插件/截图问题。

## 二、插件缺失根因与修复

### 根因
`C:\Users\Administrator\.dsh\profiles\web\package.json` 的 `dependencies` 与 `dsh.profile.bundles` **都没有** `@dsh-external/dsh-visual-studio`；
`node_modules\@dsh-external` 也不存在 → DSH 启动时根本没注册 `dsh_visual_studio_*` 工具。

### 修复
- `package.json` 增加：
  - `"@dsh-external/dsh-visual-studio": "file:D:/dsh/tools/dsh-visual-studio"`
  - `bundles` 增加 `@dsh-external/dsh-visual-studio`
- 手动创建 junction：
  `profiles\web\node_modules\@dsh-external\dsh-visual-studio` → `D:\dsh\tools\dsh-visual-studio`
- 验证 `lib/index.js`、`cordis.patch.yml` 可解析。

## 三、capture-shot.mjs 重写：从 --screenshot 到 CDP

### 失败史（四版）
| 版本 | 方案 | 结果 |
|---|---|---|
| v1 | `--screenshot + --virtual-time-budget` + 自检 | 纯本地 HTML ✅ / CDN+动画页面 ❌ 15s 超时 |
| v2 | 去 vtb，`--headless=new` | 仍超时（10s），无页面错误 |
| v3 | 内置 HTTP server + file:// 改 http | 仍超时（10s） |
| v4 | 旧 `--headless` + HTTP + 磁盘轮询 | 仍超时（12s） |
| v5 ✅ | **CDP 强制截图** | **成功 140 KB PNG** |

### 根因
无头 Chrome 的 `--screenshot` 依赖页面 `load` 事件；CDN ES Module + 持续 rAF + WebGL 的页面在该链路下永远等不到可截图状态（不报错、不退出）。

### CDP 版关键点
1. 内置轻量 HTTP server，避免 file:// 限制；
2. `--headless=new --remote-debugging-port=随机`；
3. **必须从 `/json/list` 拿页面 target 的 WebSocket**（连 `/json/version` 是浏览器级 endpoint，没有 `Page` 域，会报 `'Page.enable' wasn't found`）；
4. `Page.enable / Runtime.enable / Network.enable → Page.navigate → 智能等待 → Runtime.evaluate 强制 render → Page.captureScreenshot`；
5. **智能等待**：每 200ms 探测 `__DSH_SCENE_REPORT__ / __DSH_READY__ / readyState + renderer`，默认最多 8s，超时仍截当前帧并 `[WARN]`；
6. `send()` 需透出 `res.error`，否则 CDP 错误被吞成“未返回截图数据”。

## 四、scan-wsl-session.mjs 双语化

- 旧关键词全是英文版引导 → 对中文新引导误报 ✗。
- 已改为 `guideChecks` 数组：中英双语正则宽容匹配，覆盖 RL_GUIDE 12 法则 + DETAIL·visual 四步 + 路由注入标记。
- 验证：最新 watch 会话 17 项全 ✓。

## 五、DETAIL_GUIDE.visual 演进（截至最新）

最终版 = **两阶段双检查点**（已写入 `router-bootstrap-v1.mjs`）：

- 【阶段一 · 空间形体与材质基底】
  1. 空间公理与形体：显式 `const POS` / `const ELEV` 标尺链；根 Group 展开；Geometry 顶点层对齐主轴；严禁 Mesh 层旋转
  2. 材料语义三位一体
  - ★ **检查点一（冒烟断言）**：写完地基立即 `node --check` + `capture_shot`，非黑屏、无错位才准进阶段二
- 【阶段二 · 介质细节与光感升华】
  3. 介质与微观细节：玻璃 `opacity 0.05-0.12 + clearcoat 1.0 + depthWrite false`；批量写入禁止零散微调
  4. 光感预算闭环：三光结构、ACES、细分 16-24（倒角≤1）、同步 `renderer.render(scene,camera)`
  - 写完执行【第 2 次终验】，达标立即交付

## 六、三轮最新思维链复盘

### Run A：`session-5a5e5357`（CDP 修复前）
- 1 轮 / 19 步 / 77.7K 推理；已调用 `dsh_visual_studio_init` + `capture_shot`（插件修复生效）。
- 问题：capture_shot 旧版 15s 超时；思维链归因“CDN/场景重”，实际是工具机制问题。

### Run B：`session-dbe0cc14`（调试闭环）
- 2 轮 / 48 步 / 123.8K；`capture_shot`×9 + `vision_analyze`×9 + `edit`×10。
- ✅ 逐步隐藏组件定位“棕金色条带”（最小单变量探针）；每次改后重截。
- ❌ **错位根因**：只有 POS 平面锚点，**ELEV 轴向标尺完全缺失**；图元朝向用 `mesh.rotation/scale` 事后扳正而非 Geometry 顶点层；同模块零散 edit 10 次。
- 结论：错位不是材质/光，是**空间公理层崩塌**。

### Run C：`session-b1687293`（白屏事故）
- 2 轮 / 11 步 / 284.5K；工具：pwsh 5、browser_open 2、read 1、write 1、job_output 1。
- **事故**：`watch.html` 白屏。CDP 截图 5.6 KB + `[Browser Exception] Uncaught TypeError: shape.extractPoints is not a function`。
- 根因：`makeAnnulus` 中 `new THREE.ExtrudeGeometry({...})` **漏传第一个参数 shape**（应为 `new THREE.ExtrudeGeometry(s, {...})`）。
- 思维链暴露：只做 `node --check`（语法过），**没做渲染终验**；想过用 capture_shot 但最终没调；browser_open 因 Electron 缺失失败，验证通道全断。
- 教训：语法检查给虚假安全感；**“写完必须单次渲染终验”是硬门禁，不能跳**。

## 七、当前关键状态

- `capture-shot.mjs` = CDP 版（含智能等待 + 错误透出 + 页面 target 修复），CLI 实测 `[OK] 140KB`。
- `router-bootstrap-v1.mjs` = 最新两阶段双检查点 visual（**需重启 DSH 生效**）。
- `scan-wsl-session.mjs` = 双语正则版。
- profile=web 插件已修复（package.json + junction）。
- 待办：重启 DSH → 跑下一轮 → 验证“检查点一”是否真的被执行、错位/白屏是否消失。

---

# 附录 C：迁移交接文档（2026-08-24 完整快照，供新对话只读此文件恢复）

> 本附录是迁移对话/上下文压缩后的唯一恢复入口。先读本附录，再按需读上文主文档与附录 A/B。

## 一、当前目标（用户核心诉求）

让 `deepseek-v4-flash` 在 DSH 的 router-rl-minimal 预设下，从纯意图 Prompt **一遍写对、写精、写快、写专业**地生成 Three.js 产品展示（当前测试对象 = 3D 镂空机械表 `watch.html`）。

## 二、用户红线（必须永久遵守，违反 = 方向错误）

1. **不要动/修 watch 产品 HTML**，除非用户明确要求；分析时只看思维链。
2. **“一次成稿”= 高质量首遍正确**，不是“写一次禁止复审”。
3. **环境检查是好习惯，永远不要移除**。
4. **审查/多角度检查不是优化轴**；优化轴 = 写前想清楚 + 写中认真 + 写后简单快速全面终验。
5. **不要预设/喂模板**；教通用物理因果原则（POS/ELEV、材料语义、程序化纹理）。
6. **有工具就能用工具，没工具就不用**——绝不强制模型纯文本；`vision_analyze`/`describe_image`/`dsh_visual_studio_*` 都要保持可用。
7. `sk_tr_...` 字符串是 API key，不是 session ID。
8. 用户嫌慢：不要反复跑长时间实验/超时命令。

## 三、环境与路径事实（重要）

- 本机 Windows；`node` 在 `C:\Program Files\nodejs\node.exe`，`npm.cmd` 在 `C:\Program Files\nodejs\npm.cmd`。
- **PATH 是坏的**：`node`/`npm`/`pnpm`/`dsh`/`robocopy` 都不可直接解析；一律用绝对路径：
  - 运行 node：`& "C:\Program Files\nodejs\node.exe" <script>`
  - node --check：`node --check <file>`（PowerShell 里 node 可能也不在 PATH；用 `& "C:\Program Files\nodejs\node.exe" --check <file>`）
  - robocopy：`C:\Windows\System32\Robocopy.exe`（备份用，必须加 `/XJ`）
- DSH 全局包：`C:\Users\Administrator\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`（卸载流程未执行，保留）。
- DSH 重启命令：
  ```powershell
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bin.js web' } | Stop-Process
  dsh --profile web --port 3000
  ```
- 工作目录：`D:\dsh\research\session-runs\`（分析脚本）、`D:\dsh\tools\dsh-visual-studio\`（插件+watch）、`C:\Users\Administrator\.dsh\`（DSH 配置）。

## 四、关键文件与状态（截至 2026-08-24 12:1x）

| 文件 | 状态 | 说明 |
|---|---|---|
| `C:\Users\Administrator\.dsh\.agent-presets\router-rl-minimal\router-bootstrap-v1.mjs` | ✅ 最新 | 含 RL_GUIDE + DETAIL_GUIDE（solve/visual/exec/info），**visual 已更新为“两阶段双检查点与全领域物理因果”最终版，需重启 DSH 生效** |
| `C:\Users\Administrator\.dsh\profiles\web\package.json` | ✅ 已修 | `dependencies` + `bundles` 均含 `@dsh-external/dsh-visual-studio: file:D:/dsh/tools/dsh-visual-studio` |
| `C:\Users\Administrator\.dsh\profiles\web\node_modules\@dsh-external\dsh-visual-studio` | ✅ junction | → `D:\dsh\tools\dsh-visual-studio`；`lib/index.js`、`cordis.patch.yml` 可解析 |
| `D:\dsh\tools\dsh-visual-studio\bin\capture-shot.mjs` | ✅ CDP 版 | CLI：`node bin/capture-shot.mjs <in.html> <out.png>`；智能等待 + 错误透出；实测 `[OK]` 140KB |
| `D:\dsh\research\session-runs\scan-wsl-session.mjs` | ✅ 最新 | 双语正则 `guideChecks` 19 项，覆盖最新两阶段双检查点 visual |
| `D:\dsh\research\session-runs\decompress.mjs` | ✅ | 解压 `.jsonl.zstd` → `.jsonl` |
| `D:\dsh\research\session-runs\tool-timeline.mjs` | ✅ | 打印工具时间线 |
| `D:\dsh\research\session-runs\step-reasoning.mjs` | ✅ | 打印指定 step 的思维链 |
| `D:\dsh\research\session-runs\reasoning-search.mjs` | ✅ | 关键词搜索思维链 |
| `D:\dsh\research\session-runs\latest-894f6701.jsonl` | ✅ | 最新 watch 会话解压结果 |
| `D:\dsh\research\session-runs\session-understanding\SESSION-NOTES.md` | ✅ | 本文档 |
| `D:\dsh\tools\dsh-visual-studio\stage1-watch\watch.html` | ⚠️ 用户自行验证中 | 最新模型成品，**未授权不修改** |
| `D:\dsh\tools\dsh-visual-studio\stage1-watch\PROMPT-WATCH.txt` | ✅ | 纯意图 Prompt |
| `D:\dsh-backup-20260823-190744\` | ⚠️ 部分确认 | `project-dsh\`（353MB）+ `agent-presets\`（0.4MB）已确认；`dsh-userdata\` 完整性未最终确认 |

## 五、DETAIL_GUIDE.visual 最终版全文（必须与 router-bootstrap-v1.mjs 一致）

```text
[detail · visual task] 物理因果推演流水线（两阶段双检查点与全领域物理因果）：

【阶段一 · 空间形体与材质基底（地基阶段）】：
1 空间公理与拓扑定界：写前确认环境，统一纯英文代码；装配/多体实体必须在逻辑层先建立【平面锚点 POS】与【轴向层级 ELEV】标尺体系（z_next = z_prev + offset），所有零件依附根Group展开，严禁散落全局绝对坐标致前后脱节；图元朝向归一必须在 Geometry 顶点数据层变换（如 geom.rotateX(Math.PI/2)），严禁旋转 Mesh 自身破坏局部坐标系；视线场/隐式计算先定死相机正交基与步长边界；
2 材料语义三位一体：拒绝全场景单调同色，严格依物理语义构建【大面积结构基底 + 高反差核心功能件 + 高光/发光点缀件】材质对比体系；全金属表面依物理量化环境反射（亮 Studio 环境），自发光定标；
★ 检查点一（冒烟断言）：写完基础骨架与材质后【立即执行第1次冒烟检查（node --check 语法 + capture_shot 验证能跑、非黑屏、大形体无错位）】；地基未通过，绝对禁止进入阶段二！

【阶段二 · 微观细节与光感升华（完成阶段）】：
3 完美细节生成因果：在已验证骨架上生长细节——遵循【功能因果律】（每个零件必有输入/输出或力学支撑闭环，严禁凭空添加无关联孤立运动件）、【尺度层级律】（外覆件与微观倒角遵循比例阶梯，严禁未缩放的默认臃肿图元）、【拓扑嵌套律】（相接零件必有配合面、贯穿孔或倒角过渡，禁止盲目相交穿插）；薄层透光介质优先采用高光清漆模型（opacity: 0.05-0.12 + clearcoat: 1.0 + depthWrite: false），水面/折射采样副本防 FBO 回环；动画交互映射到有界状态机（lerp + clamp(t,0,1) 严禁无限制漂移）；同模块修改必须在思维链全盘推导后单次批量合并写入，禁止零散多次微调；
4 光感、环境与预算闭环：构建【主塑形光 + 侧后轮廓勾边光 + 弱环境底光】拉出流线高光，ACES 保护动态范围（细分 16-24 防软渲染卡死）；首帧必须执行同步 renderer.render(scene, camera)；写完执行【第2次终验】，确认细节光感与交互达标后，立即交付！
```

## 六、scan-wsl-session.mjs 当前 guideChecks（19 项）

1. 路由注入·引导消息 → `[路由注入·引导消息]`
2. RL_GUIDE 稳重·空间公理 → 空间与公理先行
3. RL_GUIDE 稳重·前向物理 → 前向物理锁定
4. RL_GUIDE 稳重·离线预算 → 离线预算与证伪
5. RL_GUIDE 细心·空间断言 → 业务与空间断言优先
6. RL_GUIDE 细心·单变量探针 → 最小单变量探针
7. RL_GUIDE 细心·终验 → 改动必落地与终验
8. RL_GUIDE 细心·探针先证伪 → 探针先证伪
9. RL_GUIDE 诚实·自证陷阱 → 破除自证陷阱
10. RL_GUIDE 诚实·单一事实源 → 单一事实源
11. RL_GUIDE 诚实·验证权威 → 验证权威完整
12. RL_GUIDE 克制·达标即止 → 判据达标即止
13. DETAIL·visual 物理因果流水线 → 物理因果推演流水线
14. DETAIL·visual 阶段一·空间公理 → 空间公理与拓扑定界|空间公理与形体
15. DETAIL·visual 阶段一·材料三位一体 → 材料语义三位一体
16. DETAIL·visual 检查点一·冒烟断言 → 检查点一|第1次冒烟检查|冒烟断言
17. DETAIL·visual 阶段二·细节三律 → 完美细节生成因果|功能因果律|尺度层级律|拓扑嵌套律
18. DETAIL·visual 阶段二·介质/状态机 → 高光清漆模型|opacity: 0.05-0.12|有界状态机|lerp + clamp
19. DETAIL·visual 阶段二·光感预算闭环 → 光感、环境与预算闭环|第2次终验

## 七、四轮 watch 思维链复盘（结论记住即可）

| 会话 | 特征 | 结论 |
|---|---|---|
| `5a5e5357` | CDP 修复前 | capture_shot 旧版 15s 超时，是工具机制问题不是页面重 |
| `dbe0cc14` | 48 步调试闭环 | 错位根因 = ELEV 轴向标尺缺失 + Mesh 层旋转 + 零散微调；空间公理层崩塌 |
| `b1687293` | 白屏事故 | `new THREE.ExtrudeGeometry({...})` 漏传 shape 参数 → TypeError 白屏；只做语法检查没做渲染终验 |
| `894f6701` | 最新，两阶段生效 | **检查点一生效**：写完地基即 capture_shot×7 + vision×4；ELEV 链式推导；爆炸视图 3 轮验证；最终 `[OK] 168.6KB` 非黑屏 |

关键教训：
1. **语法检查给虚假安全感**；漏参/类型错误只能靠渲染级终验抓住。
2. **检查点一是硬门禁**：地基没跑 capture_shot 就不准进阶段二。
3. 验证工具链：capture_shot（CDP 版）不依赖 Electron，**浏览器工具（browser_open）缺 Electron 可能不可用**；渲染验证优先用 capture_shot，不要依赖 browser。
4. scan 关键词必须跟随引导版本更新，否则误报。

## 八、常见操作速查

```powershell
# 解压最新会话（从 sessions 列表取最新名字）
& "C:\Program Files\nodejs\node.exe" "D:\dsh\research\session-runs\decompress.mjs" "C:\Users\Administrator\.dsh\sessions\--D-dsh--\session-XXXX" "D:\dsh\research\session-runs\latest-XXXX.jsonl"

# 扫描/分析
& "C:\Program Files\nodejs\node.exe" "D:\dsh\research\session-runs\scan-wsl-session.mjs" "D:\dsh\research\session-runs\latest-XXXX.jsonl"
& "C:\Program Files\nodejs\node.exe" "D:\dsh\research\session-runs\tool-timeline.mjs" "D:\dsh\research\session-runs\latest-XXXX.jsonl"
& "C:\Program Files\nodejs\node.exe" "D:\dsh\research\session-runs\step-reasoning.mjs" "D:\dsh\research\session-runs\latest-XXXX.jsonl" <step>
& "C:\Program Files\nodejs\node.exe" "D:\dsh\research\session-runs\reasoning-search.mjs" "D:\dsh\research\session-runs\latest-XXXX.jsonl" "pattern"

# 渲染验证（CDP 版，无 Electron 依赖）
& "C:\Program Files\nodejs\node.exe" "D:\dsh\tools\dsh-visual-studio\bin\capture-shot.mjs" "D:\dsh\tools\dsh-visual-studio\stage1-watch\watch.html" "D:\dsh\tools\dsh-visual-studio\stage1-watch\_verify.png"

# 重启 DSH（改引导后必须）
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bin.js web' } | Stop-Process
dsh --profile web --port 3000

# 插件重编译（src/index.ts 变更后）
& "C:\Program Files\nodejs\node.exe" "C:\Users\Administrator\AppData\Roaming\npm\node_modules\typescript\bin\tsc" -p "D:\dsh\tools\dsh-visual-studio\tsconfig.json"
```

## 九、下一步待办（迁移后立即执行）

1. **重启 DSH**（让最新 visual 生效）。
2. 用最新会话（894f6701 之后的下一轮）验证：
   - 检查点一是否在写完后立即执行 capture_shot；
   - 是否还出现错位/概率黑屏；
   - 最终 watch.html 是否无需用户手动修。
3. 如果 scan 再次误报，先核对 guideChecks 是否与引导版本一致。
4. 用户未授权前**不要修改 watch.html**；用户说“去看思维链”就只分析思维链。

# 附录 D：2026-08-27 ~ 08-28 v4.6/4.6.1 迭代与两轮思维链复盘

## 一、本轮迭代主线

1. **39139ce2（计划先行试验，18:41）**：用户提示词以“请你先不要动手，详细告诉我你准备写什么，什么思路”结尾 → 方案细腻度断崖式提升（1 步 / 35.6K 推理 / 4852 字计划，无 write）。结论：**用户提示词的力量 >> 注入引导的力量**；计划=外部化决策锚点，防 far-field decay。
2. **v4.6（已废弃）**：PLAN_FIRST_INSTRUCTION = “先不要行动详述思路 + 总结后调用 dsh_visual_studio_start_coding 工具”（工具接力放行）。实测**工具接力从未触发**。
3. **v4.6.1（现行）**：纯指令版，无工具依赖。全文：
   > 请先不要急于行动，深入详述你的完整思路与核心逻辑（深入具体，拒绝空洞大纲），构思完备后直接全面开展落地并完成验证。
   - bootstrap 注释记录动因：“实测‘调用 start_coding 工具’接力未触发，改为纯指令版——构思完备后直接落地，不依赖工具接力”。
   - `dsh_visual_studio_start_coding` 工具保留注册（无害），不再被指令引用。
   - verify-guide.mjs / scan-wsl-session.mjs 探针已同步新关键词（请先不要急于行动 / 深入详述你的完整思路 / 构思完备后直接全面开展落地）。

## 二、dea48c68（v4.6.1 首战，64 步 / 115K 字）—— 灾难复盘

**最终状态**：write 中文全乱 → 全白屏 → 30 步救编码 → ASCII 全英文重写 → 出图但 `extractPoints` 崩溃 → 会话未交付即结束。文件写错路径（`D:\dsh\skeleton-watch.html`，非 `stage1-watch\watch.html`）。

### 病灶链
1. **思考-执行断层（模型侧主因）**：1.2-1.5 设计 176K 字（1.4 单步 74K）→ 1.10 write 时思维链仅 **234 字**就写 41KB 文件。设计（宏观架构）与代码（变量方案/函数签名/验证点）之间零衔接 → 落笔即错（const 重赋值、空组、extractPoints undefined）。
2. **write 工具中文落盘乱码（工具侧，未根治）**：tool/call 事件参数中文完整（135 块，`LUMIÈRE SQUELETTE · 3D 镂空机械表` 全对）→ **落盘后变 GBK-mojibake**（`LUMI鑴燫E`）+ 行尾换行被吞（JS 语法错误→白屏）。本会话（主 agent）write 中文正常，模型会话 write 损坏——**参数→写盘之间某环节转码，具体位置未定位**（dsh-tool-fs 在 node_modules/@deepseek-ai/ 下，未深查）。
3. **路径漂移**：全会话未读 PROMPT-WATCH.txt、未访问 stage1-watch → 写到 D:\dsh 根目录。
4. **视觉验证工具全挂**：describe_image / modlens / browser_open（Electron 缺失）均不可用，只能 System.Drawing 数像素（942×388 纯白）。
5. 模型 1.46 步才精确定位编码（先怀疑 `</script>` 泄漏、占位符、分辨率）；1.49 gb18030 反推成功大半；1.50-1.54 恢复不干净（122 字符丢失）；1.55 放弃中文重写 ASCII。模型自己验证出“PowerShell WriteAllText 中文正常 → 是 write 工具写坏的”。

### 门禁表现
GATE1 ×2、GATE2 ×3 全触发且模型响应（批量合并），但被编码灾难淹没，门禁价值归零。

### 教训
- **写码前必须有代码级设计**（列变量声明方案、函数签名、验证点），光有宏观设计不够。
- **write 中文不可靠** → 引导应要求“代码注释/UI 字符串纯英文”（附录 C 旧版 visual 第 1 条曾有此条款，v4.4 重写时丢失——历史 Run 7/8 同款事故，待加回）。

## 三、6348b5bd（v4.6.1 第二轮，7 步 / 108K 字）—— 目前最新

**最终状态**：write 一次成功（46.9KB），node --check 通过，capture_shot **211.5KB 出图**（页面活，2 个非致命 warning：bloom sigmaRadians 超上限、r128 无 thickness 属性）。文件在 `D:\dsh\skeleton-watch.html`（仍非标准路径）。

### step 结构
| Step | 工具 | 思维链 |
|---|---|---|
| 1.1 | pwsh 列目录 | 36K：mm 坐标、42mm 表壳、齿轮坐标（barrel(0,8.5) center(0,0) third(-5.5,4) fourth(5.8,-2.5) escape(0,-7) balance(0,-10.5)）、材质表、标签/爆炸/高亮方案 |
| 1.2 | Invoke-WebRequest 测 CDN | 28K：r128 非模块 + CSS2D + PMREM |
| 1.3 | curl -I | 网络通 |
| 1.4 | Get-Location | workspace = D:\dsh |
| 1.5 | 无工具 | 29K：爆炸视图/零件位置细化 |
| 2.1 | write | 42K 代码结构规划 → 一次写出 |
| 2.2 | capture_shot | 211.5KB 出图 + WARN 8s 未报告就绪 |

### 评估
- 规划 4 星：具体到数字、预判坑（r128 transmission 不支持、ExtrudeGeometry holes 相切、CSS2D 标签随齿轮旋转、共享材质高亮污染）。
- **致命遗漏：42K 思考零字验证啮合数学**——齿轮坐标是“视觉排布”不是 `d=r1+r2` 推导，历代错位老病灶未除。
- **provider error 打断计划先行**：2.1 开头“The previous response got provider error? We need now continue implementation”——turn 1 被 LLM 故障打断（有 llm/retry 记录），恢复后直接落地，“先详述思路”未呈现给用户。

## 四、下一步待办（截至 2026-08-28）

1. **引导加回“纯英文代码”条款**（visual 第 1 条），绕开 write 中文落盘 bug——最稳的临时规避。
2. 可选：深查 write 工具转码根因（dsh-tool-fs @ node_modules/@deepseek-ai/dsh-tool-fs），根治。
3. 下一轮验证重点：① 是否先详述思路再落地（防 provider error 打断需预案）；② 齿轮啮合是否用公式推导（d=r1+r2 容差 ±0.5）；③ 是否读 PROMPT-WATCH.txt 写对路径。
4. 用户 08-28 已清场（D:\dsh 根目录 24 个垃圾文件已删；stage1-watch 仅剩 PROMPT-WATCH.txt）。
