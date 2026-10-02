/**
 * router-bootstrap: task-aware reasoning-mode router with a continuous
 * react↔spec axis.
 *
 * Reads the session's first user message, classifies the task into a
 * continuous mode in [0,1] (0 = spec plan-first, 1 = react doer), and on the
 * first model request injects the matching persona and first-turn core tool
 * set. After the first durable tool/call the full preset catalog is exposed
 * and nothing is touched again; the mode derives from durable session events,
 * so resume/reload keeps it.
 *
 * The agent can read and tune its own routing through `dev_router_status` and
 * `dev_router_mode` (self-optimization loop) — mode accepts band names
 * (spec/spec-lean/balanced/react-lean/react), 0-100 numbers, or 0.0-1.0.
 *
 * Zero external imports on purpose: relative preset rows resolve bare
 * specifiers from the user home, where `@deepseek-ai/*` is not installed.
 * The router tools therefore inline a minimal schema compiler instead of
 * importing `defineTool` from `@deepseek-ai/dsh-tools`.
 */

import {
  applyPersona, bandFor, bandOf, coreFor, parseMode, personaFor, sessionMode, testinessFor, clamp01,
  isComplexTask, extractText, classifyTaskTypes,
} from './router-core.mjs'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEBUG_LOG = path.join(os.homedir(), '.dsh', 'router-guide-debug.log')
function debug(...parts) {
  try {
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${parts.join(' ')}\n`)
  } catch { /* log is best-effort */ }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'router-bootstrap'

/** Prompt assembly, the tools registry, and the LLM route must exist. */
export const inject = ['systemPrompt', 'tools', 'llm']

/** Minimal spec → JSON Schema compiler (subset of defineTool's work). */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (Array.isArray(meta.enum)) prop.enum = meta.enum
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

export function apply(ctx, config) {
  const overrides = new Map() // session id -> explicit mode (number 0..1)
  const agents = new Map() // session id -> Agent (live handle, in-process only)
  const firstUserText = new Map() // session id -> first REAL user message text (issue #3 fix)
  const toolsExpandedNotified = new Set() // session id -> notified once on promotion

  // ── 路由模式（v0.2.0 命名，用户定义）───────────────────────────────────────
  // standard（默认，新）: RL 接口还原——首轮只有 RL 训练句 + shell/str_replace_editor，
  //   模型"想一段、做一段"（实测 25 步 / 24 工具调用 / 产出文件）。
  // spec（旧）: 深度思考优先——分类 persona（w7/REACT/SPEC）+ 保留全部 sections，
  //   模型首轮长思维链（101K 推理 0 行动是其特征，不是缺陷）。
  const routerMode = config.routerMode === 'spec' ? 'spec' : 'standard'
  // Fused (integrated): B0 RL-shape interface (training-sentence persona only,
  // shell + str_replace_editor core) + NEAR-FIELD guidance injection for
  // standard mode. No far-field persona clauses (watch2 showed they decay in
  // long tasks); guidance rides a fresh user-role message per real user input.
  const RL_PERSONA = 'You are a helpful software engineer assistant.\n'

  /** spec 路由模式的首轮工具面（旧行为；weak 也走 default 面）。 */
  function legacyCore(mode) {
    switch (bandOf(mode)) {
      case 'spec': return ['read', 'edit', 'glob', 'grep']
      default: return ['read', 'write', 'edit']
    }
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const session = agent.session
    agents.set(session.id, agent)

    // issue #3 fix: the first assembly happens before the first user/message
    // event lands in session.events, so sessionMode() saw an empty transcript
    // and injected the WEAK band on the path-committing first request. Use the
    // live text captured by the session/event listener (or inbox pending) so
    // the first request carries the REAL classification.
    const mode = overrides.get(session.id) ?? firstUserText.get(session.id) ?? sessionMode(session)
    const modelId = agent.options?.model

    // ── 模式分派 ──
    // standard（RL 接口还原）: 首轮 system = 只有 RL 训练句；身份/Web 定位/工具引导/
    // 规则 sections 全部移除（minimal 的 complete:true 语义，实测 46 字符 system →
    // 25 步迭代工作流）。
    // spec（深度思考优先）: 分类 persona + 保留全部 sections（首轮超长思维链是特征）。
    const planSection = (assembled.sections || []).find((s) => /plan/i.test(s.name))
    let sections
    let core
    let persona
    if (routerMode === 'standard') {
      persona = RL_PERSONA
      sections = planSection
        ? [planSection, { name: 'router-persona', text: persona, order: 0 }]
        : [{ name: 'router-persona', text: persona, order: 0 }]
      core = new Set(['str_replace_editor']) // RL shape: shell + editor
    } else {
      persona = personaFor(mode, modelId)
      sections = applyPersona(assembled.sections, persona) // keep all other sections
      core = new Set(legacyCore(mode))
    }

    if (session.events.some((event) => event.type === 'tool/call')) {
      // 纯文本模型不可用的多模态探针：不暴露，避免模型被自相矛盾的视觉反馈带偏。
      const TEXT_ONLY_BLOCKED = new Set([
        'read_image',
        'vision_toolkit_activate',
        'vision_glance',
        'vision_ground',
        'vision_detect',
        'vision_crop',
        'vision_trace',
        'vision_pixel_diff',
        'vision_long_screenshot_ocr',
        'vision_extract_foreground',
        'vision_dominant_colors',
        'vision_html_screenshot'
      ])
      const visibleTools = assembled.tools.filter((tool) => !TEXT_ONLY_BLOCKED.has(tool.name))
      let expanded = sections
      if (!toolsExpandedNotified.has(session.id)) {
        toolsExpandedNotified.add(session.id)
        const coreNames = new Set(core)
        const addedTools = visibleTools
          .map((tool) => tool.name)
          .filter((name) => !coreNames.has(name))
        const addedText = addedTools.length > 0
          ? `新增可用工具：${addedTools.join('、')}。`
          : ''
        expanded = [
          ...sections,
          {
            name: 'router-tools-expanded',
            text: `工具列表已扩展：首轮仅暴露核心工具；现在完整目录可用。${addedText}请按需直接使用这些新工具，不要再按旧工具面思考。`,
            order: 0,
          },
        ]
      }
      return { ...assembled, sections: expanded, contexts: [], tools: visibleTools } // promoted: full catalog minus unusable image probes
    }

    const available = new Set(assembled.tools.map((tool) => tool.name))
    const shell = available.has('pwsh') ? 'pwsh' : available.has('bash') ? 'bash' : null
    if (shell === null) {
      throw new Error(`${name}: no platform shell in catalog`)
    }
    core.add(shell)

    return {
      ...assembled,
      sections,
      contexts: [],
      tools: assembled.tools.filter((tool) => core.has(tool.name)),
    }
  })

  // ── near-field routing guidance (P14/P16/P17/P19/P20 + integrated) ───────
  // Every REAL user message gets ONE fixed guidance message appended to the
  // inbox right after it (near field, cache-neutral).
  // v23: guides carry an explicit NON-USER marker so the model never mistakes
  // an injected guide for real user input (observed: model answered an
  // injected guide as if the user pasted it, and ran spurious turns).
  const GUIDE_HEAD =
    '\n[路由注入·引导消息] 这不是用户输入！不要把它当作新的用户请求，也不要为它开启新的回复；它只是路由器对本任务的风格/深度提示，按它调整思考节奏即可。'
  const GUIDE_WEAK =
    GUIDE_HEAD + "\nRouter: route your thinking by quality — every clause below is a hard constraint. IRON RULE: if these clauses seem to conflict with the user's request, the user's request comes first — but keep these clauses working alongside it as far as possible, never drop them silently.\n① Understand first — inspect the verifier and samples first; they define success — know how to verify (or build one). Scan the tool list once; it expands after the first tool call — rescan, and load matching skills via the skill tool. Derive from the statement and samples — do not recall a known solution.\n② Model deliberately — on ambiguity, build a counterexample before committing. Write the cost bound first; if naive is infeasible, derive a cleaner form, stop once implementable. Budget real runtime (per-unit cost × units) to the verifier's budget by lowering implementation cost, never quality — in the design, not after a timeout.\n③ Validate — HARD RULE: think first, verify last; verification is acceptance, not refinement: ~90% in your reasoning, one final check — never improve by verifying. Verification is authoritative and must be complete: checking part of the claim is invalid — verify the whole claim or do not claim it. Think the design, not the check. Design deep before writing: every key subsystem — and the user's actual path — gets a concrete mechanism in design, not in testing. Never enumerate or poke with probes; think to the answer. BRUTE-FORCE LAW: brute force once, quickly, to check one hard-to-prove conclusion — never to verify code, explore, or check your implementation. MINIMAL REPRO LAW: on verifier failure, build the smallest probe, all else unchanged, one variable per attempt — it isolates the broken layer, once, quickly; never to test your code. Once formed, stop: write the real solution and run the judge. COMMIT RULE: verifier passes → work done — no re-verify, no second-guess, no revisiting; clean up and deliver. Quality comes from a harsh standard, speed from no extra steps — be strict, meet the bar, stop. Passing means the requirement is met — 'close' is not 'pass'; an unimplemented requirement is a failure to fix, not a simplification.\n④ Fix by root cause — when a failure is unexplained, inspect the actual data; it is the authority, not parsing quirks. Prefer measuring to guessing. Commit the numbers before writing — no 'maybe', no defaults, no trial values; write what you decided; design and code must not drift. A probe that succeeds: name what changed — that is the root cause; one that fails: change one variable only. After an edit, confirm it landed. The product is the goal; tools are means — tool time is cost, not progress; return to the product.\n⑤ Finish honestly — after passing, ask once: does this match the real intent, or only the test? Accept before polishing: verify the bar is met before touching details — cosmetics after acceptance, never instead of it. Deliver what was asked, no more — partial subtasks are the deliverable, not the full problem; decide scope once. File discipline: before writing, check the target path — a file from another session is a question: ask the user, never reuse it; deliver only what you wrote.";
  // v24 hard-stop: produce within three reasoning blocks (local, beats upstream).
  const GUIDE_DEEP =
    GUIDE_HEAD + '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply about the architecture, edge cases, and integration points. Do not spend reasoning on the environment or tooling. Produce within three reasoning blocks — never seek completeness; a workable approach tested beats a perfect one planned. End each reasoning block with a decision or an information need.'
  // Integrated (standard/RL mode) near-field guide: capability-routing v2.9.
  // = v2.8 + ① verification-tooling clause, from the author-plugin watch run
  // (router-standard): its first step loaded the vision skill and built a
  // headless-Chrome screenshot + vision-review loop (80 of 89 tools were
  // verify-and-fix; result PASS) while our v2.8 run, lacking vision tools,
  // fell back to blind guessing (145 tools, 60 of them unverified edits).
  // Lesson: before building, know what can verify your work; if none exists,
  // build a small one. Only ① changes; ②③④⑤ identical to v2.8.
  // v3.0 (2026-08-16): the fastest measured state — 5:50 / 86K / 18 tools /
  // 40-40 on Boats! P2 (rl-ab, beats the 6:23 rl-t baseline by 33s with fewer
  // tools). Successive v3.x candidate texts (data-quirk boundary, derive-
  // before-measuring, commit rule) were folded into the final text below;
  // each was validated by a Boats! run: rl-x 20min archaeology ❌, rl-y
  // 10:43 ✅, rl-z aborted ❌, rl-aa 8:09 ⚠️, rl-ab 5:50 ✅. The decisive
  // final change was ③'s BRUTE-FORCE LAW rewritten on the user's professional
  // methodology: brute force exists ONLY to check one hard-to-prove derived
  // conclusion, quickly, once — NEVER to verify code (the judge verifies
  // code), never to explore, never to prove optimality. Once the approach is
  // formed, stop brute-forcing: write the real solution and run the judge.
  // rl-ab confirmed: zero brute-force files, one 460-char conclusion check at
  // s4, then pure derivation to judge. j-space lesson (rl-t/u/v/w, v2.9 era,
  // Boats! P2): description-only priming is FAST (rl-t 86K, rl-w 17K) while
  // successfully loading the full protocol is a NEGATIVE (rl-u 117K, rl-v 78K
  // then 3 steps and dead). Final call 2026-08-17: j-space removed from the
  // model environment entirely (no stub, no priming) — its description was
  // knowledge for US, not priming for the model; the concept now lives only
  // here and in D:\dsh\PROJECT-SUMMARY.md. Full 170KB protocol archived at
  // D:\dsh\research\j-space-archived. Injection: once per real user message.
  // v3.1 (2026-08-16): ② gains a runtime-cost budget clause. The Kerr-Newton
  // black-hole run (rl-bh) exposed the gap: the model wrote physically correct
  // Kerr-Schild metric / Hamiltonian / RK4 / Doppler code, but never budgeted
  // the actual runtime cost — 600 RK4 steps per pixel × ~1.3M pixels froze
  // Chrome, so vision_html_screenshot timed out, and after the timeout it
  // edited the file without touching MAX_STEPS/scale (fixing the wrong thing).
  // The old ② said "write down the cost bound" but the model read it as
  // algorithm complexity only. Fix: ② now demands an explicit RUNTIME budget
  // before implementing — estimate the real work and design the implementation
  // to fit the verifier's time budget, lowering implementation cost (better
  // stepping, early exit, sampling for verification only) instead of shrinking
  // the task's quality, in the design not after the first timeout.
  // Detail knowledge (kept here, not in the guide text): for a renderer the
  // work is steps per pixel × pixels × work per step; a screenshot is the
  // verifier. Only ② changes; ①③④⑤ identical to v3.0.
  // v3.2 (2026-08-17): ① gains a "sharpen your tools" clause. The Poolrooms
  // run (rl-pool, 122K reasoning) wasted ~15K chars across 9 steps re-checking
  // which tools exist (skill? vision_glance? read_image?) and trying each
  // verification path halfway before switching. Fix: at the start, scan the
  // tool list once and note what each tool is FOR (category it), do not plan a
  // full tool sequence ahead — when the need to verify/act arrives, reach for
  // the tool already noted for that purpose. Only ① changes; ②③④⑤ identical
  // to v3.1.1.
  // Detail knowledge (kept here, NOT in the guide text — reactive debugging
  // practices must not live in the universal layer): the v3.2 Poolrooms rerun
  // exposed two more debugging habits, but they only apply to long-horizon
  // debug loops, so they stay here for the detail layer of such tasks:
  //  · compare against a known-good reference — when output is wrong, keep or
  //    build a minimal correct sample and diff the failure against it; the
  //    difference IS the root cause (scene rendered fine via renderer.render,
  //    602KB shot, but EffectComposer output all-black 3.4KB → root cause was
  //    in the composer path, not the scene).
  //  · verify every fix — after each change, re-run the verifier and confirm
  //    the change worked; a fix counts only when the verifier passes on it
  //    (a guessed setPixelRatio(0.5) culprit was never tested).
  //  · converge on criteria, not perfection — in visual/renderer tasks the
  //    verifier is a criteria checklist (not black, tiles visible, water
  //    reflects, tubes visible, fog exists); once the screenshot satisfies the
  //    checklist, the work is done. The v3.2 Poolrooms run kept iterating for
  //    15+ rounds of edit→screenshot→color-stats after the scene already met
  //    every criterion (t3 alone: 34 str_replace, 12 vision_dominant_colors),
  //    and even died at the last step instead of delivering.
  //  · match the verification tool to the criterion — the checklist is about
  //    the whole picture (vision_glance), not pixel histograms
  //    (vision_dominant_colors); the run leaned on 14 dominant_colors calls
  //    (micro measurement) to avoid making the macro judgment glance would
  //    give. Judge the picture as a picture.
  // v3.4 (2026-08-17): ③ COMMIT RULE gains a "passing standard is the
  // requirement, never relaxed" clause. The v3.2+§5.4 Poolrooms rerun was fast
  // (1 turn / 70K / 39 tools / 11 min vs 3 turns / 148K / 135 tools) but the
  // quality went hollow: s8 knew water refraction was NOT implemented ("no
  // refraction! The requirement specifically 水面反射与折射") yet delivered a
  // "claim refraction approximated by alpha" substitute; s27/s36 accepted
  // criteria ④ (visible dark/flickering tubes) on a crop-only sighting when
  // the full-image check said no tube was off. Speed came from converging, but
  // convergence was misread as "accept when close" instead of "stop when the
  // requirement is genuinely met". Fix: the passing standard is the
  // requirement itself — "close" is not "pass", an unimplemented requirement
  // is a failure to fix not a simplification to claim. Only ③ COMMIT RULE
  // changes; ①②④⑤ identical to v3.2.
  // v4.1 (2026-08-24): 反"思考流全量默写代码"截断事故（session-51b40372：
  // 两轮 72K/81K 脑内整篇设计撑爆输出上限，均死在"思考→落笔"转换点；
  // 另发现连续 edit 零思维链病灶）。法则3改为"定界不默写"，法则6增补
  // 反零思维链连击与批量合并写入，法则7补"编码"探针项。
  const RL_GUIDE =
    GUIDE_HEAD + '\n[行为品质·Pro实战完全体] 4 品质 / 12 黄金法则：\n' +
    '① 稳重（先算后动）：' +
    '1 空间与公理先行：新任务彻底清场重建，先定公理化坐标系与几何规格，再定物理基调，最后推演材质细节，基础未定不堆细节；' +
    '2 前向物理锁定：落笔前预估叠加效应（Watch the sum：光照/自发光/管线衰减防过曝，介质透射自洽），首发锁定参数，杜绝盲调试错；' +
    '3 离线推演定界不默写代码：思维链只推导核心公式、数据字典与拓扑依赖，严禁在思考流中全量默写整篇代码浪费Token；算清运行时与Token预算，降本不降质。\n' +
    '② 细心（深思后验）：' +
    '4 业务与空间断言优先：90% 推理在先，落笔必断言空间可见性与业务事实，断言业务而非仅查语法，验证是门禁不是梯子；' +
    '5 最小单变量探针：出错用最小样本隔离根因，一次只变动一个变量；' +
    '6 改动必落地与终验：每次改动必有推理依据，严禁零思维链盲目连击工具；同一模块修改必须单次批量合并写入，交付前最后一次修改必须有真实验证闭环；' +
    '7 探针先证伪：现象反常先验证观测工具与探针本身（文件大小/截图帧/编码），再查管线环境与逻辑，最后才改场景参数，绝不盲目归因。\n' +
    '③ 诚实（绝对达标）：' +
    '8 破除自证陷阱：“技术可运行≠需求达成，非黑无报错≠画面正确”，严禁以管线存在代替感知达成，必须逐条核验观察者视角真实空间事实；' +
    '9 单一事实源：同一几何/数值只允许一个权威来源，严禁复制副本（两处使用立即抽取公共函数），杜绝设计代码漂移；' +
    '10 验证权威完整：验证手段必须可靠且覆盖全局，手段不足时不以偏概全。\n' +
    '④ 克制（达标即止）：' +
    '11 判据达标即止：判据满足立即收工交付（Commit rule），不反复自疑，不发起多余无目的修饰；' +
    '12 启发而非清单：工具是手段产物是目标；现实细节是启发而非机械打勾清单，自主推演所需。';
  // v3.5 (A1, 2026-08-17): task-type DETAIL layer — the tree structure from
  // the design doc finally lands. Universal layer = RL_GUIDE above (all tasks);
  // detail layer = short task-type-specific practices appended ONLY for a
  // confidently classified type, based on the session's FIRST user message
  // (the task definition), so later short messages keep the same detail.
  // Only 'solve'/'visual'/'exec'/'info' exist; null = universal only.
  // Text stays short on purpose (long guidance dilutes; v2/v3 measured this).
  // v3.7 (2026-08-18): 首个全量测试通过版（2eddc：判据 5/5 + 零工具错误 + 氛围生效）。
  // v3.6 (2026-08-17): DETAIL_GUIDE 原文被瘦身脚本误删且无备份——
  // solve 从 a9c437e9 注入消息恢复原文；visual/exec/info 按设计意图重建
  // （依据 v3.1 renderer-budget 注释、v3.2 detail knowledge、A3 C/D 类纪律）。
  // v4.5 (2026-08-26): visual 引导再收紧两处——
  // (1) 规则1 加"单一源头声明 + 派生尺寸动态计算引用 + 严禁次生字面量"：
  //     8b7763e4 事故——独白推导正确（pitch r = teeth×module/2、d = r1+r2）
  //     但代码手写 radius 数字脱节，四对齿轮全部负 gap 重叠。条款强制
  //     从源头动态派生，杜绝"推导-转录"断层。
  // (2) 规则4 加"首帧同步渲染 + 验证闭环 + 达标即止"：把 GATE1 冒烟、
  //     终验与法则4"判据达标即止"接成完整交付闭环。
  const DETAIL_GUIDE = {
    solve:
      '\n\n[detail · algorithm/code task] 数学与工程因果推演：\n' +
      '先冻结坐标系（空间离散强制toTile整数化）、硬点/全局参数与交付形态；验证器与生成器共享同一数据源，禁止两套逻辑分叉。' +
      '闭式解析解优先于迭代拟合，有限差分派生特征值；主算法带确定性周期与边界兜底，不做过度抽象框架。' +
      '纯算法核心与 DOM/IO 分离；Canvas工程resize必须同步redrawNow；自测断言残差、约束保持、对称、连续性与有限性。' +
      '完成 = 数值与逻辑零残差 + 需求逐条核对 + 真实环境运行；不实现未要求的抽象/伪兼容。',

    visual:
      '\n\n[detail · visual task] 物理因果推演流水线：\n' +
      '1 空间公理：彻底清场，先定死绝对尺寸与全局空间基准；核心参数由单一源头声明，派生尺寸与从属装配位姿从源头动态计算引用，严禁在局部手写重复或脱节的次生字面量致数据漂移；基础未定绝不调光影；\n' +
      '2 物理因果布光：光照与材质是能量乘积（考虑管线衰减与叠加防过曝），拒绝无影棚式泛光；\n' +
      '3 介质分层推导：水/玻璃等介质由光吸收深度与菲涅尔决定（深浅分层与折射），表面受潮/磨损自发引起粗糙度突降，从物理因果推演参数，拒绝生硬默认值；\n' +
      '4 细节生长与预算闭环：微观细节在参数化生成层随骨架生长，不后贴；堆细节前先定几何/绘制/曝光预算，ACES保护宏观基底；首帧执行同步渲染，写完执行验证闭环，达标即止。',

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


  // P21 continuation guard (flash): short message + continuation marker and
  // no greenfield/new-task marker → treat as same-file chain continuation.
  const CONTINUATION_RE = /(继续|接着|下一步|接下来|然后|现在|还有|另外|再|也|同样|它|这个|那个|改一下|修一下|调一下|试一下|fix|extend|update|change|remove|adjust|add|still|also|next|then|now|additionally|one more|another|same|again)/i
  const NEW_TASK_RE = /(新建|新项目|从零|写一个|开发|创建|生成|构建|做一个|重构|迁移|升级|搭建|build|create|develop|generate|new project|greenfield|refactor|migrate|upgrade)/i
  function isContinuation(text) {
    return typeof text === 'string' && text.length < 100 && CONTINUATION_RE.test(text) && !NEW_TASK_RE.test(text)
  }

  const guideState = new Map() // session id -> { lastGuidedId, assistantSince }

  // v4.3 (2026-08-24): 动态近场门禁（Dynamic Event Gates）——对抗长任务注意力
  // 衰减。背景：9956115f 会话注入 v4.2 后，48K 独白里 POS/ELEV 推导 0 次、
  // 轮系 4 对啮合全部脱开（gap +3.7~+7.2），且模型把 vision 的"像爆炸状态"
  // 误归因到 explodeItems、打错补丁。结论：单次引导注入只能解决"知道"，
  // 解决不了"做到"与"验出"。本门禁在 agent/pre-step 近场逐步骤实时插桩：
  //   GATE 1 · 冒烟门禁：刚执行完 write 且其后尚无任何渲染验证 → 强制先
  //     capture_shot 冒烟，禁止直接进细节修补。
  //   GATE 2 · 批量合并门禁：连续 2 步 edit/str_replace_editor → 强制
  //     思维链全盘推导后单次批量合并写入，严禁碎片化单点微调。
  // 状态按 session 隔离，仅记录"已为哪个 seq 注入过"，可重复触发（模型
  // 无视门禁继续违规 → 下一步再次弹脸），但不会在同一 seq 上刷屏。
  const gateState = new Map() // session id -> { gate1Seq, gate2Seq }

  const GATE_SMOKE = (
    '\n[SYSTEM GATE · 检查点一]: 你刚刚完成了初始文件写入。' +
    '根据两阶段纪律，你当前必须立即调用 dsh_visual_studio_capture_shot（或 capture_shot）进行第 1 次冒烟渲染验证' +
    '（确保页面能跑通、无报错、大形体无错位）。在确认地基存活前，严禁直接对局部零件进行细节修补！'
  )
  const GATE_BATCH = (
    '\n[SYSTEM GATE · 批量合并门禁]: 检测到连续碎片化修改（连续 edit / str_replace_editor）。' +
    '严禁单点打地鼠式修改！请在当前思维流中将剩余的所有几何、材质与布光修改全盘推导完毕，' +
    '在下一次工具调用中单次批量合并写入并进行终验。'
  )

  // 从 session 事件流提取最近的工具调用序列（含 seq 序号，用于幂等去重）
  function recentToolCalls(session, limit = 6) {
    const calls = []
    for (const ev of session.events ?? []) {
      if (ev?.type !== 'tool/call') continue
      const name = ev.data?.name ?? ev.name
      if (typeof name !== 'string' || !name) continue
      calls.push({ name, seq: typeof ev.seq === 'number' ? ev.seq : calls.length })
    }
    return calls.slice(-limit)
  }

  // 判定当前步骤应注入的门禁消息；无触发返回 null
  function dynamicGateFor(session) {
    try {
      const calls = recentToolCalls(session)
      if (calls.length === 0) return null
      const st = gateState.get(session.id) ?? {}
      const last = calls[calls.length - 1]
      const VERIFY = new Set(['dsh_visual_studio_capture_shot', 'capture_shot', 'vision_analyze', 'browser_screenshot'])
      const EDIT = new Set(['edit', 'str_replace_editor', 'str_replace'])

      // GATE 1: 最后一步是 write，且该 write 之后尚无任何渲染验证
      if (last.name === 'write') {
        const lastVerifySeq = calls.filter((c) => VERIFY.has(c.name)).reduce((m, c) => Math.max(m, c.seq), -1)
        if (last.seq > lastVerifySeq && st.gate1Seq !== last.seq) {
          st.gate1Seq = last.seq
          gateState.set(session.id, st)
          return GATE_SMOKE
        }
      }
      // GATE 2: 最近两步都是 edit 类工具
      if (calls.length >= 2 && EDIT.has(calls[calls.length - 1].name) && EDIT.has(calls[calls.length - 2].name)) {
        const seq = calls[calls.length - 1].seq
        if (st.gate2Seq !== seq) {
          st.gate2Seq = seq
          gateState.set(session.id, st)
          return GATE_BATCH
        }
      }
      return null
    } catch (error) {
      debug(session.id, 'dynamicGateFor error:', String(error?.message ?? error))
      return null
    }
  }

  // assistantSince maintenance + firstUserText fallback. The actual injection
  // moved to agent/pre-step (near-field); this listener only tracks reply
  // progress and captures the first real user text as a fallback.
  ctx.on('session/event', (session, event) => {
    try {
      if (event.type === 'assistant/message' || event.type === 'tool/call') {
        const st = guideState.get(session.id)
        if (st) st.assistantSince = true
        return
      }
      if (event.type !== 'user/message') return
      const data = event.data ?? {}
      if (data.source?.kind !== 'user') return // only real user messages
      const text = extractText(data)
      if (!text.trim()) return
      if (!firstUserText.has(session.id)) {
        firstUserText.set(session.id, text.trim()) // issue #3: capture BEFORE assembly
      }
    } catch (error) {
      debug(session.id, 'session/event handler error:', String(error?.message ?? error))
    }
  })

  // v3.5.1 (2026-08-17): near-field injection via the agent/pre-step waterfall
  // — the same channel skill-catalog uses. agent.inject() routes through the
  // inbox next-step queue and only lands at the next step boundary, so on a
  // long first step (deep algorithm solve: measured 210 s) the guide arrives
  // AFTER the first model request and the opening reasoning never sees it.
  // The pre-step waterfall runs before the step's user/message append, so the
  // guide lands in the same batch as the claimed user message (near-field,
  // verified: skill-catalog seq 9 right after user seq 8, before request/context).
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    let decision
    try {
      decision = await next()
      if (decision.kind === 'reject') return decision
      signal.throwIfAborted()
      const claimed = decision.messages ?? []
      const userMsgs = claimed.filter((m) => m.source?.kind === 'user')
      const extraMessages = []

      // ── 动态近场门禁（无条件触发，不依赖用户消息）──────────────────
      const gate = dynamicGateFor(agent.session)
      if (gate) {
        extraMessages.push({
          id: `router-gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          source: { kind: 'plugin', plugin: 'router-bootstrap' },
          content: [{ type: 'text', text: gate }],
        })
        debug(agent.session.id, 'GATE INJECTED (pre-step near-field)', gate.slice(0, 40))
      }

      // ── 引导注入（仅真实用户消息步骤）─────────────────────────────
      if (userMsgs.length > 0) {
        const userMsg = userMsgs[userMsgs.length - 1]
        const text = extractText({ content: userMsg.content })
        if (text.trim()) {
          if (!firstUserText.has(agent.session.id)) {
            firstUserText.set(agent.session.id, text.trim())
          }
          const mode = overrides.get(agent.session.id) ?? firstUserText.get(agent.session.id) ?? sessionMode(agent.session)
          let guide = null
          if (routerMode === 'standard') {
            const firstText = firstUserText.get(agent.session.id) ?? text
            const types = classifyTaskTypes(firstText)
            debug(agent.session.id, 'A1 classify:', JSON.stringify(types), '| first:', firstText.slice(0, 80).replace(/\s+/g, ' '))
            guide = RL_GUIDE + types.map((t) => DETAIL_GUIDE[t] ?? '').join('')
          } else if (bandOf(mode) === 'weak') {
            guide = isComplexTask(text) ? GUIDE_DEEP : GUIDE_WEAK
          }
          if (guide) {
            const st = guideState.get(agent.session.id) ?? { lastGuidedId: null, assistantSince: true }
            if (st.lastGuidedId !== userMsg.id && st.assistantSince && !isContinuation(text)) {
              // v4.6.1 (2026-08-27): 实测"调用 start_coding 工具"接力未触发，
              // 改为纯指令版——构思完备后直接落地，不依赖工具接力。
              const PLAN_FIRST_INSTRUCTION =
                '请先不要急于行动，深入详述你的完整思路与核心逻辑（深入具体，拒绝空洞大纲），' +
                '构思完备后直接全面开展落地并完成验证。'
              extraMessages.push({
                id: `router-guide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                role: 'user',
                source: { kind: 'plugin', plugin: 'router-bootstrap' },
                content: [{ type: 'text', text: PLAN_FIRST_INSTRUCTION + '\n\n' + guide }],
              })
              st.lastGuidedId = userMsg.id
              st.assistantSince = false
              guideState.set(agent.session.id, st)
              debug(agent.session.id, 'GUIDE INJECTED (pre-step near-field, plan-first)', guide.slice(0, 36))
            }
          }
        }
      }

      if (extraMessages.length > 0) {
        return { kind: 'enter', messages: [...decision.messages, ...extraMessages] }
      }
      return decision
    } catch (error) {
      debug(agent.session.id, 'pre-step handler error:', String(error?.message ?? error))
      return decision
    }
  })

  // ── router visibility & tuning (agent self-optimization) ────────────────
  const registerTool = (tool) => {
    ctx.effect(() => ctx.tools.register({
      ...tool,
      parameters: toJsonSchema(tool.parameters),
      // output.schema is already a plain JSON Schema; keep it as-is
    }))
  }

  const modeSpec = {
    mode: {
      type: 'string',
      required: true,
      description: 'band name (spec / weak / mixed / react), a 0-100 number, a 0.0-1.0 number, or auto to clear the override',
    },
  }

  function fmtMode(mode) {
    return typeof mode === 'string' ? mode : mode.toFixed(2)
  }

  registerTool({
    name: 'dev_router_status',
    description: 'Show this session\'s reasoning-mode routing: mode, band, persona, first-turn core tools, test-suppression, and whether an override is active.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute() {
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      const mode = overrides.get(session.id) ?? sessionMode(session)
      const modelId = currentAgent()?.options?.model
      return [
        `router-mode=${routerMode} (standard=RL接口还原 / spec=深度思考优先)`,
        `mode=${fmtMode(mode)} (band=${bandFor(mode)})`,
        `persona=${personaFor(mode, modelId).replace(/\n/g, ' / ')}`,
        `core=[${coreFor(mode).join(', ')}]`,
        `testiness=${testinessFor(mode)}`,
        `override=${overrides.has(session.id) ? 'yes' : 'no'}`,
      ].join('\n')
    },
  })

  registerTool({
    name: 'dev_router_mode',
    description: 'Set this session\'s reasoning mode: spec (plan-first) / weak (internal routing, model decides per task) / mixed (transition, trap) / react (doer). Accepts band names, 0-100, or 0.0-1.0; use auto to return to task classification. The next request applies it.',
    parameters: modeSpec,
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute(args) {
      const parsed = parseMode(args.mode)
      if (parsed === null) return `invalid mode "${args.mode}": use spec/weak/mixed/react, 0-100, 0.0-1.0, or auto`
      const session = currentSession()
      if (session === undefined) return 'no agent session'
      if (parsed === 'auto') overrides.delete(session.id)
      else overrides.set(session.id, parsed === 'weak' ? 'weak' : clamp01(parsed))
      const current = overrides.get(session.id) ?? sessionMode(session)
      return `mode=${fmtMode(current)} (band=${bandFor(current)}) — next request applies`
    },
  })

  // ── mode-isolated subagent: run a task in a DIFFERENT reasoning mode,
  //    without touching this session's trajectory (P6 showed tail persona
  //    is ineffective; DSH's native subagent inherits this persona, so the
  //    only working isolation is a fresh LLM call with its own system). ──
  registerTool({
    name: 'dev_mode_subagent',
    description: 'Run one task in a DIFFERENT reasoning mode than this session, in a fresh isolated context (own system prompt). The current session trajectory is untouched. Mode: spec (plan-first) / weak (internal routing) / react (doer) / balanced. Returns the subagent\'s answer text.',
    parameters: {
      mode: { type: 'string', required: true, description: 'spec / weak / react / balanced (or 0-100)' },
      task: { type: 'string', required: true, description: 'the task to hand to the mode-isolated subagent' },
      maxTokens: { type: 'number', description: 'output cap (default 1024)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const parsed = parseMode(args.mode)
      if (parsed === null || parsed === 'auto') return `invalid mode "${args.mode}"`
      const session = currentSession()
      const agent = session === undefined ? undefined : [...agents.values()].find((a) => a.session === session)
      if (agent === undefined || agent.options === undefined) return 'no agent route available'
      const { provider, model } = agent.options
      if (!provider || !model) return 'agent route missing provider/model'

      const persona = personaFor(parsed, model)
      const maxTokens = Number(args.maxTokens || 1024)
      let text = ''
      let reasoningChars = 0
      try {
        const stream = ctx.llm.stream({
          provider,
          model,
          system: persona,
          messages: [{ role: 'user', content: [{ type: 'text', text: String(args.task) }] }],
          maxTokens,
        })
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'reasoning-delta') reasoningChars += chunk.text.length
        }
      } catch (error) {
        return `subagent error: ${error && error.message ? error.message : String(error)}`
      }
      const head = text.slice(0, 3000)
      return `[mode-subagent ${bandFor(parsed)} | reasoning ${reasoningChars} chars]\n${head}${text.length > 3000 ? '\n…(truncated)' : ''}`
    },
  })

  function currentSession() {
    const agent = ctx.get('agent')
    if (agent !== undefined && agent.session !== undefined) return agent.session
    const last = [...agents.values()].at(-1)
    return last?.session
  }

  function currentAgent() {
    const session = currentSession()
    return session === undefined ? undefined : [...agents.values()].find((a) => a.session === session)
  }
}
