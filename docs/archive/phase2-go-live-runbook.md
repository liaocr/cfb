# 阶段二上线手册（DSH Settler · checkpoint 模式）

> 2026-09-17。代码与单测已全绿并离线真机重放通过；**尚未带电**。

## 一、当前状态（已落盘）

| 项 | 值 |
|---|---|
| 新模块 | `emitter.js` / `balanced-span.js` / `headroom.js`（均在 `packages/dsh-cot-form-b/`） |
| 接线 | `index.js` 新增 `mode: 'checkpoint'` 分支 + `awaitDistilled` + 白名单放行 |
| 单测 | **347 项全绿**（204 主回归 + 33 headroom + 50 span + 60 emitter） |
| 离线真机重放 | 218 会话 / 7,792 条 assistant / **7,584 个带 tool-call 分组 / 零撕裂 / 零异常** |
| 配置 | `dryRun: true`、`mode: 'off'`（**故意保持断电**） |

## 二、为什么现在不能翻 mode

三个物理事实，缺一不可：

1. **模块热更新只对配置生效，不对代码生效。** 网关内存里仍是旧 `index.js`。
2. **旧模块的白名单不认 `'checkpoint'`**（`index.js:208`），会把它静默重置回 `'distill'`
   ⇒ 反而激活旧的 `assistant/message` + `sourceEventSeqs` 路径（`surface.js:207` 必抛）。
3. **重启网关会切断当前进行中的会话**，必须由人来选时机，不能由插件自己重启。

## 三、上线三步铁律（不可颠倒）

```
① 重启网关
      ↓
② 确认 BOOT trace 里 emitting 含 checkpoint，且 mode 仍是 off
      ↓   ← 若这一步不对，立刻停，别往下走
③ 把 cordis.patch.yml 的 mode 改成 'checkpoint'（dryRun 先保持 true）
```

第③步之后**第一轮不要动 dryRun**。跑一轮，看 trace：

```
checkpoint-skip / checkpoint-emitted    ← 链路是否走通
emit-gate { rawChars, minChars, band, pressureSource }   ← D10 是否读到真实水位
ledger-built { inlined, archived, archiveFailed }         ← D2′ 混合组装
emit-dry-run                                             ← 说明只记不换（预期）
```

## 四、翻 `dryRun: false`（真正带电）的准入条件

以下全部满足才翻：

1. `pressureSource` **不是** `'none'`（读不到水位就永远走保守档，等于没开）；
2. `emit-gate` 的 `band` 在真实会话里出现过至少两档（证明动态门槛在动）；
3. 出现 `checkpoint-skip` 的 `reason` 全部是预期内的（`no-span` / `below-threshold` / `distill-not-ready`），
   **不允许出现** `live-unavailable` / `surface-drifted` / `error`；
4. 离线重放脚本 `_emitter-replay.mjs` 仍然 0 撕裂。

## 五、红线（撞上立刻拔电并留现场）

| # | 现象 | 动作 |
|---|---|---|
| 1 | 出现任何 tool-pairing / invariant 相关报错 | `mode: 'off'` + 保留 trace |
| 2 | `tokenMeter` 或 session 抛未捕获异常 | 同上 |
| 3 | 出站 payload 丢了关键输入消息 | 同上 |
| 4 | `emit-threw` 连续出现 | 同上 |

## 六、一键回滚

```yaml
mode: 'off'      # 立刻失去全部发射能力（pre-step 直接 return decision）
dryRun: true     # 双保险
```

配置热更新即刻生效，**不需要重启**。代码层无需回滚 —— 新分支只在 `mode === 'checkpoint'` 时可达。

## 七、真机第 0 轮观察结果（2026-09-17，重启后 dryRun 实测）

重启证据：网关进程启动 `13:52:36` > `index.js` 落盘 `13:43:20` ⇒ 新代码已进内存；
`BOOT` 行 `13:52:43` 报 `mode:"checkpoint", dryRun:true` ⇒ 新白名单接受了 `checkpoint`（旧模块会静默重置回 `distill`）。

```
05:57:10  early-fired    rawChars=1097
05:57:13  emit-gate      rawChars=1097  minChars=500  band=steady-cruise  pressureSource=meter
05:57:14  early-ready    rawChars=1097
05:57:14  ledger-built   chars=342  inlined=0  archived=0
05:57:14  emit-dry-run
```

**六个结论：**

1. `pressureSource: "meter"` —— `ctx.get('tokenMeter')` 在本插件 realm **确实可达**（原本最不确定的一条，结案）。
2. D10 动态门槛在真机上读到真实水位并定出 `minChars=500`（30–70% 档），`band` 字段可用。
3. 平衡区间、`rawOf`、`awaitDistilled`、`buildLedger` 全部走通，每一步的 `rawChars` 都是同一个 1097。
4. D4′ 宽限机制真机现形：early-fired `05:57:10` → pre-step `05:57:13` 未就绪 → 等约 1s → `05:57:14` 收网。
   **后台白吃 4 秒，用户感知只等 1 秒。**
5. 翻转后的第一轮必然 `distill-not-ready`（`early` 表因 mode 为 off 时没有 early-fire 而是空的），冷启动一次属正常。
6. `ledger-built` 的 `inlined=0 archived=0` —— 默认区间是「最后一条 assistant」，多为纯文本步，不含工具结果。

## 八、剩余未验证项

1. ~~tokenMeter 可达性~~ —— **已结案**（见第七节第 1 条）。
2. **`compaction/summary` 事件类型是否需要注册** —— 不需要则发射时被 try/catch 吞掉，只损失溯源记录，不影响发射。
3. **`agent/pre-step` 是否确实在 payload 组装之前** —— 由官方 `dsh-compaction-basic/README.zh.md:112` 佐证
   （官方 auto 压力检查就挂在这个钩子上），但同样以第③步 trace 为准。
