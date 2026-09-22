# 安装 DSH 外部插件（CMB / boundary / B / degeneration-guard）

> 一页装完。插件按 **npm 包名**注册，**没有任何绝对路径**。

## 前提

- Node.js **≥ 20**（实测 v22）
- 已装 DSH，`dsh` 在 PATH 上
- 本项目 checkout 在**任意**目录、**任意**盘符都可以，不必是 `D:\dsh`

## 三步

```bash
# 1. 拿到代码
git clone <本项目地址> dsh-plugins
cd dsh-plugins

# 2. 体检：确认 5 个插件包完整、profile 注册正确。【不写任何文件】
node deploy/onboard.mjs

# 3. 装进 profile（把包链接进 profile 的 node_modules）
dsh plugin --profile web install

# 4. 启动
dsh
```

第 2 步应当以这样一行收尾：

```
  插件 5 个；bundle 形态 5；遗留路径形态 0；不通 0
  ✓ 全部注册正确，无需改动。
```

## 注册机制：为什么没有绝对路径

插件是 **npm 包**，每个包**自带**一层 patch：

```json
// packages/dsh-cot-form-b/package.json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

```yaml
# packages/dsh-cot-form-b/cordis.patch.yml
- insert:
    - id: cot-form-b
      name: '@dsh-external/dsh-cot-form-b'   # ← 包名，不是路径
```

官方契约（`dsh-app-boot/lib/index.js:295-299`）：bundle 是 npm 包，各自携带 patch 层，
按 `dsh.profile.bundles` 的顺序叠加。而 `anchorInsertedPluginNames`（`:1169-1173`）
把**相对路径按 patch 文件所在目录**解析 —— 写包名则完全交给 Node，
**于是跨机器、跨盘符、跨 checkout 都能装。**

profile 侧只需两步（`~/.dsh/profiles/web/`）：

```json
// package.json
"dependencies": { "@dsh-external/dsh-cot-form-b": "file:D:/dsh/packages/dsh-cot-form-b" },
"dsh": { "profile": { "bundles": [ ..., "@dsh-external/dsh-cot-form-b" ] } }
```

> `file:` 依赖可以换成任意 npm 源 / git 地址 / tarball —— 只要包名对得上。

## ★ 形态铁律（踩过，会直接启动失败）

| 层 | 写法 | 作用 |
|---|---|---|
| 插件包的 `cordis.patch.yml` | `- insert:` | **插入**插件到组合树 |
| profile 的 `cordis.patch.yml` | **顶层 `- id: X`** | **覆盖**它的 config |

**两层都用 `insert` 会报 `duplicate loader entry id` 并启动失败**
（`cordis-plugin-loader/lib/index.js:91`）。

而且 patch 的 `config` 是**整体替换**、不是深合并（`cordis-plugin-include/lib/index.js:100-103`）——
所以 profile 层必须**重述要保留的每个字段**；包内默认值看各插件代码里的 `DEFAULTS`。

## `$DSH_HOME` 在哪里

所有插件的 home 解析都遵循官方 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()`：

```
显式 config  >  $DSH_HOME（空 / 纯空白 = 未设）  >  ~/.dsh
```

```powershell
$env:DSH_HOME = "D:\my-dsh-home"     # 或 export DSH_HOME=...
```

## 跑测试（可选，全部离线、零 API 成本）

```bash
node packages/dsh-degeneration-guard/selftest-degeneration-guard.mjs   # 期望 PASS=18 FAIL=0
node packages/dsh-degeneration-guard/mount-smoke.mjs                   # 期望 PASS=7  FAIL=0

# CMB：23 套件。★ 必须用隔离 DSH_HOME，否则会写进真实 store 与日志
cd packages/dsh-context-memory-bundle
DSH_HOME=$(mktemp -d) node run-all.mjs     # Windows: $env:DSH_HOME = Join-Path $env:TEMP (New-Guid)
```

> CMB 的默认 store root 跟随 `$DSH_HOME`，**一条环境变量即可完全隔离**。
> 这不是洁癖：历史上 mock 实验曾直接写生产日志，用 100 次夹具探针把真实的
> `inspect-miss=1` 顶到 101（**虚高 101 倍**），足以让一次检索审计得出相反结论。

## 改完源码，怎么让它生效（**必读**）

`file:` 依赖把包装进 profile 的 `node_modules` 时是**复制**，不是软链
（实测 `lstat().isSymbolicLink() === false`）。而 pnpm 的锁文件对 `file:` 依赖
**只记目录、不记内容哈希**：

```yaml
'@dsh-external/dsh-cot-form-b@file:D:/dsh/packages/dsh-cot-form-b': {}
resolution: {directory: D:/dsh/packages/dsh-cot-form-b, type: directory}
```

因此改完源码后 `pnpm install` 会认为"已最新"而**什么都不做**。第一次安装是对的，
之后每次都静默失效。

### 正确流程

```powershell
# 1. 删掉要刷新的包（不删就不会重装）
Remove-Item -Recurse -Force "$HOME\.dsh\profiles\web\node_modules\@dsh-external\dsh-context-memory-bundle"
# 2. 重新安装
cd "$HOME\.dsh\profiles\web"; pnpm install --ignore-scripts
# 3. 确认副本已与源树一致（不通过就别重启，重启也没用）
cd D:\dsh; node deploy\onboard.mjs
# 4. 重启 DSH —— ESM 模块在进程启动时缓存，改盘不影响运行中的进程
```

### 为什么这条必须写在这里

2026-09-20 实测事故：源树里 9 个文件（含两处关键修复）已改，5 个包的已安装副本
却全部停在 09-18。期间做过两次"重启验证"，都被判成功 —— 因为 `mounted`、
`writer-takeover` 这些启动日志照常打印，而**真正该变的那一行没有变**。

教训不是"忘了重启"，而是 **"源树绿灯" 与 "线上生效" 之间没有任何机器可查的关联**。
`onboard.mjs` 的 `[2b] 部署漂移` 就是补这个关联：它逐文件比哈希，不一致即退出码 4。

> 顺带：`pnpm install` 对**已存在**的目录不刷新，但删掉后会重新复制 —— 这一点已实测
> （删 `degeneration-guard` 后 install，`added 1`，副本与源树哈希立即一致）。

## 排错

| 症状 | 原因 | 处理 |
|---|---|---|
| `duplicate loader entry id: X` | 两层都用了 `insert` | 见上面「形态铁律」 |
| `Cannot find package 'X'` | 包没装进 profile | `dsh plugin --profile web install` |
| 插件静默不生效 | 未列入 `dsh.profile.bundles` | `node deploy/onboard.mjs` 看报告 |
| **改了源码、重启了，行为却没变** | `pnpm install` 不刷新 `file:` 依赖的副本 | 见上面「改完源码，怎么让它生效」；`onboard.mjs` 的 `[2b]` 会报 exit 4 |
| `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` | 某个 git 依赖需要 build script 但不在 `allowBuilds` | `pnpm install --ignore-scripts`，或把该包加进 `pnpm-workspace.yaml` 的 `allowBuilds` |
| 想确认插件真进了组合树 | —— | `dsh --profile web --dump-config` |
| 换机器/换盘符 | —— | **不用做任何事**（包名注册天然可移植） |

## 遗留路径形态（仍支持，但不推荐）

老 profile 里可能写着 `name: 'file:///D:/dsh/packages/.../index.js'`。
绝对路径**跨不了卷**，换机器就失效。`onboard.mjs` 仍能修：

```bash
node deploy/onboard.mjs            # 体检，会标出 [legacy] 项
node deploy/onboard.mjs --apply    # 改写路径（先备份，注释零丢失）
node deploy/onboard.mjs --revert   # 从最近一次备份还原
```

**建议迁到 bundle 形态** —— 迁完之后这两个命令就再也用不上了。

## 参考

- 就绪评估与全部实测证据：`docs/go-live-readiness.md`
- 融合设计（含官方契约逐条核实）：`docs/plugin-fusion-design.md`
- 检索审计：`docs/missed-retrieval-report.md`
