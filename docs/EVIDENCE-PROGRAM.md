# 证据程序架构（2026-09-30，预注册先于实现）

## 0. 可证伪预测与证据边界

**本节写于实现与离线回放之前。** 基线来自 `transfer/mr/run4/summary.md`：红题 raw 4.9 → v4d9 8.0；flaky 3.0 → 5.0，wrong-model 9.0，eacces 8.5。

- **P1（以后经批准的效果实验）**：执行验证与环境/上下文联合恢复的增益应主要集中在 flaky（等待、重试、缺少事件证据）。wrong-model / eacces 应基本不变；任一反而上涨 **>1 分**，先重做因子归因，不宣称突破。此处历史分数只是预注册参照，**不参与架构决策**。
- **P2（本轮可验）**：关闭新接口时，全部历史稿的旧编译输出逐字不变，N1–N7 全零；打开侧车时说明稿仍逐字不变。解析出来的提议不自动获得执行权限。
- **P3（本轮可验）**：检查失败、缺失、过期、条件不等价、进程超时、判据漂移均不能推进步骤或允许收工；诊断检查通过也不能替代失败的验收。
- **P4（本轮可验）**：主动查询使用完整条件熵；无辨别力、重复且环境未变、越过预算的检查不执行。诊断有上限，最多两轮修复，第 3 轮只验证。
- **P5（本轮可验）**：规则/事实/疫苗逐项记录正/零/负效果。留出门平局拒绝，任何一项负效果不得被别处收益抵消；指纹失效、反例、退役后停止检索。
- **P6（本轮可验）**：失败后恢复最近通过状态的制品和宿主状态（包含受管文件），不回灌原失败稿。会话越权、哈希损坏、并发外部修改拒绝恢复；Git、仓库根目录、密钥路径永不纳入恢复范围。

**本轮仅零调用工程验证。** 不把可解析率、合成通过率、归档通过门或历史规则指标解释成模型成功率；无法证明“所有未见任务绝不变差”。实际保护是旧路径默认保留、新路径需宿主授权且失败关闭，外加独立冻结验收与留出门。

## 1. 归因与选择

四轮侦察共同指向表示类别，而不是继续雕刻散文。本设计将 V（独立验证）→ E（可寻址接口）→ C（有界循环）合成一条宿主流水线：

```
原压缩链 → 原说明稿（字节不变）
             └→ 类型化提议 → 宿主冻结契约绑定 → 证据程序
                    ↓                            ↓
               无损块仓/句柄                逐步检查与回执
                                                 ↓ 失败
                                       EIG 选诊断（只读、有预算）
                                                 ↓
                                     恢复通过检查点 / 另选路径
                                                 ↓
                                  逐项签名档案 + 严格留出接受门
```

**R1–R4 是能力要求，不照抄旧建议的实现蓝图。** 代码分层：纯数据与状态机、宿主本地 IO、主动查询、签名档案、事务与接线。全部 Node 内置模块，无第三方依赖，无模型调用。

### 被否决的备选

1. **直接执行稿里的 bash**：会把来源文本变成执行授权、可改弱验收或读密钥。改为宿主预先注册检查、声明本地执行能力；稿只引用检查 ID。
2. **给模型换提示词/追加 K 规则**：违反停止清单且新增生成方差。旧提示词、字数、闸门保持原有语义；新数据走独立侧车。
3. **只附仪表盘**：H-ledger 已否证。块表只是可恢复接口，实际能力来自宿主执行、步骤闸和失败恢复。
4. **把正负效果平均、Likert 排序、按自评入库**：会掩盖有害技能。档案按逐项二元回执比较，留出严格提升、无单项退化。
5. **Git reset 或全目录复制**：不是宿主状态恢复，且可能损失用户修改。用明确受管路径 + 宿主状态适配器 + 内容寻址检查点，冲突拒绝。
6. **把历史 canned 输出当实时执行成功**：历史只有离线观测，不能冒充新鲜宿主回执。回放单列可解析、可绑定、已知历史判据与未知，绝不运行历史 shell 命令。
7. **把早期文献里的所有建议都上线**：forced answering、消融、训练、best-of、harness 搜索需额外调用或数据支持，本轮不实现付费算法的伪替代；实现它们所需的制品/验证/归档/恢复基础。

## 2. 不可越过的边界

- 执行器不接受生成器自定义判据。契约在周期开始前由宿主创建并冻结；任何编辑判据均需新周期。
- 默认仅内置本地读文件/观测判据。外部进程检查需宿主明确注册绝对可执行文件与 argv，`shell:false`，环境变量不继承密钥，有超时与输出预算；**这是信任边界，不是通用 OS 沙箱**。宿主对获授权程序的无网络、无外部副作用负责。
- 回执绑定会话、契约、制品、轮次、宿主修订号与实际检查；旧回执不能用于新环境。不可证是阻塞，不是通过。
- 原文、失败制品无损存档，不自动进模型上下文；模型可见只含通过的回执/事实、少量适用记忆和块元信息。无原文尾巴、无抽取式替代旧稿。
- 文件仓与检查点存 `$DSH_HOME/storages/cot-form-b/evidence/` 或宿主显式路径；仓库内运行产物使用 `.cfb-runtime/`（Git 与 manifest 均忽略）。会话隔离、内容校验、0600 写入。
- DSH 已有流接口不能保证环境回滚或工具拦截，**不虚构宿主能力**。提供可运行的显式宿主执行 API/CLI 与可选侧车接线；默认不改变 DSH 消息、decision 或工具调用。

## 3. 实施与验收顺序

每步新增自测 → manifest → verify → audit → 中文小步提交：

1. **R1**：类型化程序、冻结检查契约、纯状态机、本地检查执行器、旧稿侧车编译和历史回放。
2. **R2**：有限假设模型的完整 EIG、贝叶斯更新、主动诊断预算与重复抑制。
3. **R3**：签名档案、二元逐项效果、独立周期/三切分、拒绝缓冲、退役与精确检索。
4. **R4**：无损块仓、宿主/文件检查点、失败恢复、两轮控制、错误历史隔离、生产侧车/公共类型、完整链自测与使用文档。

最后生成小体积可复现报告，记录所有分母和未执行项，不加入模型分数增益结论。付费主模型、评委、副模型调用均为 0。

## 4. 主动检查的实际协议（R2）

`freezeDiagnosticModel({prior, probes}, contract)` 由宿主在失败前注册有限假设与每个检查的 `P(pass|H)` / `P(fail|H)`；只能引用角色为 diagnostic 的冻结检查。`expectedEvidenceGain` 计算完整 `H(H)−ΣP(y)H(H|y)`，不是输出熵。在检查/抽象成本双预算内选 EIG 最大者，同增益选低成本再按 ID 排序；成本不是钱。

`createDiagnosticController` → `runActiveEvidenceChecks` → 宿主 HMAC 回执 → 贝叶斯更新。未知、不新鲜、条件不符只消耗预算，不建立任务事实；不可能观测停止并要求宿主重建假设模型。同修订/同检查不重复，环境修订改变可重新检查（仍受原预算）；跨会话/制品/轮次拒绝复用。所有诊断的结果都不能推进 R1 的验收闸。

似然是可错的宿主建模，不冒充已经测得的信息收益。不能在未知时凭借“最高后验假设”改代码。无有信息的可授权检查则停，不把停止变成成功。R2 自测 11/0；截至 R2 全量 662/0/1，N1–N7 仍全零。

## 5. 签名档案与留出接受门（R3）

`createMemoryCandidate` 固定 kind（rule/fact/vaccine）、body、来源、精确任务族/环境/契约版本指纹、触发谓词与可选有效期；不会把散文一句“已排除”自动变成永久事实。内容哈希用于身份，宿主 effect cycle 的 HMAC 用于认证实际运行的比较证书。

`freezeEffectSuite` 在周期开始前固定非空 train/selection/test，**按任务族隔离**，不是同题改 sample ID。独立的人写判据只在宿主执行器可见；候选执行器仅得到输入和候选，不收到切分名、判据与参考输出。逐个候选/夹具运行裸基线与单项干预，记录 `{before, after, sign}`。训练侧不得退化；selection 必须至少一个 `+` 且没有 `-/?`；本周期全部候选选择结束后，一次性关闭盲测，test 同样要求严格提升。平局拒绝，不能按平均抵消负项。宿主必须保证 evaluator 同步、纯净、独立且不可被生成器修改；本模块不是代码执行沙箱。

`createEvidenceArchive.beginCycle` → `consider` → `finalize`；全拒绝允许关闭周期但不读盲测。已消耗的盲测族不能换 cycle ID 再搜索。通过才入 active；不过门进有界、多样性的拒绝缓冲；同适用格的新候选不因“对裸基线有提升”替换旧技能（还需要成对消融，当前拒绝）。`retrieve` 最多 **k=1**，避免未经验证的技能组合交互；指纹改变、触发缺失、过期或 `retire` 后不检索。失败/拒绝正文只留档，不回灌模型。

本轮 `test/helpers/evidence-fixtures.mjs` 是 **24 条宿主协议合成夹具（本次实现编写） / 6 族 / 8:8:8**，覆盖新鲜度、条件、落地、终止、修订和身份。仅测试留出门、泄漏防护、符号归档和拒绝机制；它不是未来 S0 的主模型任务集，也没有给 LLM 技能带来收益的证据。真实档案仍需真实的独立留出任务，不能把合成工程门当泛化证明。R3 自测 12/0；全量 674/0/1，N1–N7 全零。

## 6. 无损块仓、检查点与有界控制链（R4）

### 6.1 可寻址制品与持久签名

`createEvidenceStore({directory, sessionId})` 保存原始文本（含 Unicode/孤立 surrogate）、二进制及 JSON，不抽取、不截尾；`archiveEvidenceArtifact` 分为 RAW / EXPLANATION / STEP 块，带类型、字节/字符数和地址。`recoverEvidenceBlock` 显式按块取回完整内容；它不是自动把裸句柄塞进 reasoning。块内容 SHA-256 校验、会话命名空间隔离，并由本机 0600 私有 authority key 产生持久 HMAC。读回验证身份/签名/类型，损坏不静默修补；同内容去重，有单块/总容量上限。

`createEvidenceArchive({store}).persist()` 保存 active / reject / retired 和已消耗盲测族；`createEvidenceArchive({store, restoreRef})` 只从本机签名仓恢复，重新核对候选身份/单项符号/接受门。旧在库记忆、退役和盲测消耗不因换 JS 对象被忘掉。未关闭的搜索周期不能继续使用旧私钥证书；重新开周期仍受持久的盲测消耗约束。生成器不得持有本地仓的写入/恢复 API。

### 6.2 联合恢复，而不是 Git reset

`createFileStateAdapter` 显式列出受管**普通文件**以及同步的 `readState/writeState`（上下文也必须在此状态中）；快照保留完整字节、权限、存在性、JSON 状态和测量条件。只恢复声明路径，原本不存在的受管新文件可删除；Git、密钥、`.cfb-runtime`、目录树与仓库根目录永不成为动作目标。恢复之前比较当前修订：外部修改返回 conflict，不覆盖用户内容。

全部文件先暂存，创建即登记清理（写入/chmod/fsync/关闭失败均不遗留副本），再在宿主静止/独占边界内恢复文件和 JSON；setter 或最终核对失败则尝试撤回为恢复前状态。不能恢复的物理条件、未知状态一律报 recovery-failed，绝不伪报成功。**这是受管资源事务，不是 OS 全环境沙箱**：目录元数据、后台进程、网络、真实计时器不能凭 JSON 恢复。需要这些能力时，宿主必须提供具有同等接口与原子恢复语义的适配器。乐观哈希校验不能取代跨进程独占锁；不承诺抵抗拥有同等 OS 权限的恶意并发写者。

`createEvidenceCheckpoints` 在每轮前保存制品引用 + 宿主快照；preconditions 通过后建立安全起点，每个步骤 postconditions 通过才更新峰值。**安全起点/前提通过不等于任务已修好**（kind 单列）。失败回到最近验证步骤的峰值；没有峰值时只恢复宿主提供的轮前状态，不声称其症状已消失。检查点有会话、契约和资源范围绑定；跨 root、契约、会话、哈希损坏均拒绝。

### 6.3 控制器与错误历史隔离

`createEvidenceRuntime` 每个 episode 至多 3 轮、2 轮修复，第 3 轮只能 observe/验证；总检查数上限，轮次绝对截止 + AbortSignal，进程检查有独立超时/输出限额；结果返回后再次核对截止，迟到 pass 不推进。不能抢占同步 I/O，恢复/持久化/清理仍需完成；观察器必须只读并遵守 AbortSignal，动作/状态回调同步且不安排后台写入。并发轮次、重复 round ID、漂移程序不执行。每个阶段只消费对应角色的签名回执。失败后在同一预算内做 R2 诊断，再恢复，另选冻结契约中已经批准的分支；不调用模型再生稿，不用诊断绿灯替代验收。

说明稿/原文/失败回执完整留仓；`modelView` 只返回状态、通过检查点的引用、诊断二元状态与最多一条适用记忆，**不含失败说明稿**。冲突/验证器源码漂移不给记忆。用户上下文是否真正回滚，取决于宿主适配器是否纳入它——本地演示有真实的上下文恢复，DSH 侧车不假装接管 session 内部状态。

独立检查器及其依赖可用 `protectEvidenceContract(def, {root, paths})` 固定 SHA-256，纯契约也接受宿主提供的 `protectedFiles`；动作不得修改这些路径，每次检查/动作前后发现漂移则 unknown。外部检查程序的完整依赖必须由宿主登记或放进不受任务编辑的独立工作区，不能仅固定命令文字就宣称测试未被改弱。默认本地 DSL 没有生成器可编辑的脚本。

## 7. 可运行接口与启用/回退

### 零成本复现（不加载钥匙）

```sh
node tools/replay-evidence.mjs
node tools/evidence-demo.mjs
node verify.mjs evidence-program active-checks effect-archive evidence-runtime
node tools/audit-noninferiority.mjs
node manifest.mjs --check
# 等价快捷命令：npm run evidence:replay / npm run evidence:demo
```

演示在专用临时工作区进行真实文件编辑与联合恢复，最后删除**演示自己的临时目录**；不改当前仓库文件或 Git。`--out .cfb-runtime/demo.json` 可留报告（忽略目录），没有在线模式。

### 宿主调用（完整执行链）

```js
import {
  freezeEvidenceContract, createEvidenceProgram, createEvidenceRuntime,
  createEvidenceStore, createFileStateAdapter,
} from '@dsh-external/dsh-cot-form-b'

// 独立的宿主配置，不从模型散文里提取判据。
const contract = freezeEvidenceContract({
  task: 'config-change', version: '1',
  checks: [
    { id: 'before', kind: 'file', role: 'precondition', path: 'config.txt',
      predicate: { op: 'equals', field: 'text', value: 'old\n' } },
    { id: 'landed', kind: 'file', role: 'acceptance', path: 'config.txt',
      predicate: { op: 'equals', field: 'text', value: 'new\n' } },
    { id: 'symptom', kind: 'observation', role: 'acceptance',
      predicate: { op: 'equals', field: 'symptomGone', value: true }, conditions: { cpus: 2 } },
  ],
  actions: [{ id: 'change', type: 'replace', path: 'config.txt',
    oldText: 'old\n', newText: 'new\n', preconditions: ['before'], checks: ['landed', 'symptom'] }],
})
// hostRoot、captureContext、restoreContext、measureConditions、observeSymptom 由宿主独立提供。
const store = createEvidenceStore({ directory: hostEvidenceDirectory, sessionId })
const adapter = createFileStateAdapter({ root: hostRoot, paths: ['config.txt'],
  readState: captureContext, writeState: restoreContext, readConditions: measureConditions })
const runtime = createEvidenceRuntime({ contract, sessionId, store, adapter,
  allowEdits: true, observe: observeSymptom })
const program = createEvidenceProgram(explanation, { contract, sessionId, actionIds: ['change'] })
const result = await runtime.runRound(program, { roundId: 'round-1', raw: originalArtifact })
// observeSymptom 返回 {value, revision, roundId, conditions}，必须源于本次独立观测，不能复制 binding 冒充新鲜。
// 只有 result.ok / status=verified 可收工；其余读取 modelView，错误正文不回灌。
```

上面的宿主变量不是插件替你捏造的服务；完整、本地可直接执行的装配见 `tools/evidence-demo.mjs`。公共接口、结构与可选能力全部在 `index.d.ts`，JS 中还有运行时 schema/权限校验。本项目仍无 TypeScript 构建依赖；类型声明登记自测不代替 `tsc` 全项目类型检查。

### DSH 侧车（默认关闭）

宿主用 `createEvidenceHost(runtimeOptions)` 创建会话专属服务，并用自己的原生服务注册机制使 `ctx.get('cfbEvidenceHost', false)` 返回它。配置 `evidenceProgram: true` 才在 birth 结算处发布侧车；服务缺失/会话不匹配/归档失败只回到旧行为，说明稿和 chunks 不变。未完成、部分稿或 passthrough 只存档、不授权；同索引新制品会先撤销旧授权，归档失败也不能沿用旧候选；不产生原文尾巴的新解释器。

`host.latest()` 可查看已绑定制品；**宿主显式调用 `host.runLatest(index)` 才执行**，原文 RAW 块一起传入执行轮，不用说明稿冒充原文。现有 DSH `llm/stream` 在工具调用发出后才完整获稿，不能靠这个钩子追回已执行工具；本版本不虚构工具拦截/decision 格式、不自动改 DSH 消息或环境。因此接入真正的自主工具循环时必须由宿主在动作前路由到证据执行 API，提供独占状态/上下文适配器；**尚未生产自动接管，也没有获准付费试跑**。

回退：`evidenceProgram: false` 或不注册服务，立刻回到原 birth+compress；程序侧断开宿主调用即可。旧 `dryRun:true / mode:'off' / enabled:false` 原样有效。旧 `mode:'checkpoint' / stateMemory` 仍退役；新检查点不是恢复那些被否决的看板/抽取式路线。

## 8. 实际验收与仍待证明的部分

详见 [完整验收报告](analysis/EVIDENCE-VALIDATION-2026-09-30.md) 与 [历史回放](analysis/EVIDENCE-REPLAY-2026-09-30.md)。

- 本轮模型/评委/副模型 API 调用 **0**，费用 **0**；本地 HTTP 替身只是既有自测，不是真模型。
- R1 15、R2 11、R3 12、R4 26 项自测；加上原 636 项为 **700 通过 / 0 失败 / 1 原有宿主依赖跳过**，20 套件，manifest 271 文件无漂移。
- N1–N7 在 267 份历史稿上全零；旧路径默认与新侧车说明稿逐字相等；没有改变提示词/压稿预算。
- 合成本地控制链：2 个批准分支实际执行，第一轮失败并恢复，第二轮通过；2 轮/2 次修复/7 次检查。只说明工程控制链可用，不是 flaky 模型涨分。
- P2–P6 有工程证据支持；P1 尚未测试。合成、自写协议夹具不等于独立人写的真实留出；真实效果、S0、run5、一切模型/评委调用均待批准。

**已实现与未做的界线**：类型化接口、独立冻结判据、主动诊断、逐项档案、块仓、联合恢复、预算/循环与侧车接线已一次交付；没有做训练、forced answering、模型消融、best-of 搜索、生产自动接管或付费泛化。不把缺少宿主权限的数据伪造成“可执行通过”。


## 四轮复核补件（v13.1，本地功能，不承诺模型收益）

`contextOptions` 仍默认 `null`。宿主显式设对象（如 `{ maxTokensEst: 8192 }`）才装配新消息与义务动作闸：`runtime.modelInput()` 给固定协议/契约前缀与完整 L0，`runtime.contextView()` 给大小/年龄/当前修订/真实访问/剩余预算，`runtime.readBlock(indexRef, id)` 默认 solver 角色。失败 RAW/EXPLANATION 默认不可读；optimizer 需要构造时显式 `allowOptimizerReads: true` 且请求指定角色，不把角色字符串当认证。真正模型工具分权仍由宿主配置，不把 JS 工厂当 OS 沙箱。

每个 L0/L1/L2 都重复完整冻结契约、步骤四槽、义务/反馈/预算。L1/L2 只附加类型化解释，不摘取原稿。任何非空子集保有相同核心；管理器拒绝混周期、缺核心、伪造描述或旧修订。预算不足整帧拒绝，不送一个残缺尾巴。固定前缀不含轮次/反馈/用量，不承诺 provider 永远缓存命中。`render()` 的核心预算是装配前快照，顶层 `budget` 是交付后账本；块读收费按真实完整内容的 token **估算**，渲染收费包含前缀+各层完整文本，不含 provider 分词器/账单；`providerReportedUsage=null` 明示未知。空块也受读次数硬上限。

只有品牌验证器私有 HMAC 的新鲜前置回执能将条件义务从 armed 触发为 pending；动作仅 executed，所有绑定当前修订的验收才 fulfilled。cancelled/invalidated 不可复活，过期/外部修订/失败关闭不能补跑动作。无前置的 observe 是冻结契约允许的立即验证，不虚构新鲜触发事件。`binaryEvidenceFeedback` 丢弃伪造/错程序/错轮次/错角色证据，陈旧证据标 unknown，动作不扮演验收。逐槽审计只证结构完整，不是 QAEval/LLM 理解测验。

命名 head 以 HMAC+独占文件锁+前版本 CAS 更新，档案自动恢复；`reserveHoldout()` 在异步执行 test 之前持久预占，即使崩溃/失败也不返还任务族。恢复旧 `restoreRef` 不可跨越最新 head 的退役状态。崩溃遗留 head 锁不自动抢锁，须宿主检查后处理；这是故意保守的可用性权衡。普通主机断电的目录 fsync/故障文件系统耐久性及恶意特权宿主不在本轮证明范围。

完整覆盖台账与未实施边界见 [四轮覆盖复核](analysis/THEORY-COVERAGE-2026-09-30.md)。零 API 复现：`npm run verify:offline`（Linux/unshare/ip 必需，隔离失败停止，不回退在线）；不读取真实 HOME/DSH_HOME/keys.env，不继承 API/代理/凭据环境，只准 loopback 测试替身。


本地搜索补件：`createEvidenceDocument`/`editEvidenceDocument` 只编辑指定文本槽，冻结头与必需槽不可删；次数/字符/总量限额先检查。`runEvidenceSearch` 将 async 真实执行结果无损签名留仓，再交 R3 同步证书内核；最多 8 个候选，固定候选且持久 reserve 后才读 test，任何扰动/观察器负项或 unknown 都 veto。拒绝缓存跨周期要求宿主提供完整源码/环境 `evaluationScope` 指纹，不把函数的字符串表示误认为 closure 环境证明；没有指纹不跳过旧失败。问题队列认证证据、去重、按复发排序、限额并持久恢复，仅供宿主，不作为 solver 失败故事。

本次 `createLocalEvidenceSuite` 只给 32 个代理自写、参考已知的真实文件/状态/本机 HTTP/子进程场景；`executeLocalEvidenceCase` 的策略空间仅 idle/unchecked/checked。它不是任意仓库代码演化或 LLM 效果评估，观察器不可判时缺失 correct 槽而不是假造 false 后赚提升。最终 746/0/1、23 套件，详细分母与边界见四轮覆盖台账。


## 零 API两轮后续（v13.1.2；不是模型效果验收）

`freezeApprovedRepairPolicy(def, contract)`冻结初始/后备/后验路由批准动作与>=0.8信心阈值、最多2修复；`createApprovedRepairEpisode({ host, contract, policy }).run()`是显式原生宿主调度入口，不是插件默认开关。它只从品牌host本次runLatest取得认证诊断，拒绝外部后验注入；unknown/恢复不完整/冲突/截止/预算满停止，诊断仍不能扮演验收。构造和调用均需宿主明确授权；断开调用即保留旧路径。

对照宿主可设 `diagnosticStrategy:'fixed', diagnosticOrder:[已批准的diagnostic检查ID]`；默认仍是 EIG（active）。固定诊断不会在熵为0时提前终止，这是强对照的既定检查成本，不偷换验收。预注册计划、18个新真实本机故障任务、四臂三切分及完整分母见 [两轮实测](analysis/LOCAL-ITERATIONS-2026-09-30.md)。静态12/18、单EIG12/18、单路由18/18、组合18/18；完成增益来自路由，诊断36→18。两轮验证只使用本机HTTP/计时器/Node进程，无模型或外网API。

`npm run evidence:repair:development`与`npm run evidence:repair:iterations`都经断网入口；签名报告保存于ignored `.cfb-runtime/repair-iterations/`。留出已持久消耗，重跑只认证回放；改变源码后不能靠删库复用。最终763/0/1、25套件、manifest291、N1–N7全零。完整外部DSH/Cordis缺依赖仍未验证；自写复现不称独立泛化，付费模型A/B与生产接管仍待批准。


### v13.1.3 增量：取消与按重试需要诊断（显式、默认旧行为）

冻结批准策略可选`diagnosticMode:'before-retry'`：只有还存在下一次批准修复机会才做失败诊断，首个unknown停止；不降低前置/验收要求。省下的诊断不会当成完成增益或评委涨分。未选模式/显式always保留旧policy摘要与每次失败诊断默认。`controller.run({signal})`、`host.runLatest(index,{signal})`、`runtime.runRound(program,{signal})`接受可选AbortSignal；预取消零预算，执行中取消等待本轮显式文件/JSON恢复、不启用下一分支，不采纳迟到检查。

底层显式round选项`diagnostics:false`只跳诊断，不跳验收；`stopOnUnknown:true`让诊断首个未知停止。HMAC认证与角色/轮次仍严格；固定顺序不受构造后调用方数组修改影响。取消不回退已经发生的网络等非受管副作用，也不能抢占同步I/O或强制终止不遵守signal的观察回调；宿主必须保护独占资源。详见 [增量优化/回归](analysis/REPAIR-HARDENING-2026-09-30.md)。

`npm run evidence:repair:regression`只跑6个已知开发任务，不再搜索已消费18任务留出。旧report仍保留历史；源码变化会关闭旧搜索入口，不删库规避。最终776/0/1、26套件、manifest294、N1–N7全零；外部API0、费用0。
