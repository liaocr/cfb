# 安装 dsh-cot-form-b

> 插件按 **npm 包名**注册，**没有任何绝对路径**：换机器、换盘符、换 checkout 目录都不用改配置。
> （本文件原为姊妹 monorepo 的多插件安装页；v11.8 起只讲本包。多插件版本见 git 历史。）

## 前提

- Node.js **≥ 20**（实测 v22）
- 已装 DSH，`dsh` 在 PATH 上
- 本仓库 checkout 在任意目录都可以

## 四步

```bash
# 1. 拿到代码并自检（全部离线、零 API 成本）
git clone <本仓库地址> dsh-cot-form-b && cd dsh-cot-form-b
npm test                      # 期望：全部套件通过（1 项需要宿主兄弟包的断言会 SKIP）
npm run manifest:check        # 期望：全部一致

# 2. 在 profile 里登记依赖与 bundle（~/.dsh/profiles/web/package.json，见下）

# 3. 装进 profile
cd ~/.dsh/profiles/web && pnpm install --ignore-scripts

# 4. 体检后启动
cd <checkout> && npm run onboard    # 期望：与源树一致、全部注册正确
dsh
```

## 注册机制：为什么没有绝对路径

插件包**自带**一层 patch（`package.json` → `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`）：

```yaml
# 本仓库的 cordis.patch.yml
- insert:
    - id: cot-form-b
      name: '@dsh-external/dsh-cot-form-b'   # ← 包名，不是路径
```

官方契约（`dsh-app-boot/lib/index.js:295-299`）：bundle 是 npm 包，各自携带 patch 层，按 `dsh.profile.bundles` 的顺序叠加。
写包名则完全交给 Node 的包解析，于是跨机器、跨盘符、跨 checkout 都能装。

profile 侧（`~/.dsh/profiles/web/package.json`）：

```json
{
  "dependencies": { "@dsh-external/dsh-cot-form-b": "file:<checkout 的绝对或相对路径>" },
  "dsh": { "profile": { "bundles": ["...", "@dsh-external/dsh-cot-form-b"] } }
}
```

> `file:` 依赖可以换成任意 npm 源 / git 地址 / tarball —— 只要包名对得上。

## 配置：两层 patch 的形态铁律（踩过，会直接启动失败）

| 层 | 写法 | 作用 |
|---|---|---|
| 插件包的 `cordis.patch.yml` | `- insert:` | **插入**插件到组合树（本仓库已写好，不带 config） |
| profile 的 `cordis.patch.yml` | **顶层 `- id: cot-form-b`** + `config:` | **覆盖**它的 config |

- **两层都用 `insert`** 会报 `duplicate loader entry id` 并启动失败（`cordis-plugin-loader/lib/index.js:91`）。
- patch 的 `config` 是**整体替换**、不是深合并（`cordis-plugin-include/lib/index.js:100-103`）：profile 层要写全你想要的每个非缺省值。
  缺省值见 `src/config.js` 的 `DEFAULTS`；推荐起步配置见根目录 README「配置」。
- 写错的键不会报错，但会出现在 BOOT 的 `unknownOptions` 里；退役的键/模式出现在 `retiredOptions` / `retiredMode`。**合闸前看一眼 BOOT。**

## `$DSH_HOME` 在哪里

与官方 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()` 同一契约：

```
显式 config  >  $DSH_HOME（空 / 纯空白 = 未设）  >  ~/.dsh
```

插件的 trace、快照、证据账本都在 `$DSH_HOME/storages/cot-form-b/` 下。

## 改完源码，怎么让它生效（**必读**）

`file:` 依赖装进 profile 的 `node_modules` 时是**复制**，不是软链（实测 `lstat().isSymbolicLink() === false`）。
而 pnpm 锁文件对 `file:` 依赖**只记目录、不记内容哈希** ⇒ 改完源码后 `pnpm install` 会认为「已最新」而**什么都不做**。

```powershell
# 1. 删掉已安装的副本（不删就不会重装）
Remove-Item -Recurse -Force "$HOME\.dsh\profiles\web\node_modules\@dsh-external\dsh-cot-form-b"
# 2. 重新安装
cd "$HOME\.dsh\profiles\web"; pnpm install --ignore-scripts
# 3. 确认副本与源树逐文件一致（不一致就别重启，重启也没用）
cd <checkout>; node deploy\onboard.mjs      # [2b] 部署漂移必须「与源树一致」，否则退出码 4
# 4. 重启 DSH —— ESM 模块在进程启动时缓存，改盘不影响运行中的进程
```

重启后在 trace 里找新的 `BOOT` 行：`selfId`（`src/plugin.js` 的 `size@mtimeMs`）与 `deps`（包入口 + `src/` 全部模块）
应当与已安装副本的磁盘现值一致。旧模块在内存里没有这段代码，所以这是可证伪的上岗判据。

> 为什么这条必须写：2026-09-20 实测事故 —— 源树已改、已安装副本却停在两天前；两次「重启验证」都被误判成功，
> 因为启动日志照常打印，**真正该变的那一行没有变**。`onboard.mjs` 的 `[2b]` 逐文件比哈希，就是补这个关联。

## 排错

| 症状 | 原因 | 处理 |
|---|---|---|
| `duplicate loader entry id: cot-form-b` | 两层都用了 `insert` | 见「形态铁律」 |
| `Cannot find package '@dsh-external/dsh-cot-form-b'` | 包没装进 profile | 检查 profile 的 `dependencies`，重装 |
| 插件静默不生效 | 未列入 `dsh.profile.bundles` | `npm run onboard` 看报告 |
| BOOT 里 `mode: 'off'` | 配置写了退役模式（`retiredMode`）或拼错（`invalidMode`） | 改成 `birth` / `checkpoint` |
| trace 只有 `birth-dry-run-stream`，从不压缩 | `dryRun` 缺省为 `true` | 金丝雀观察无误后在 profile 显式 `dryRun: false` |
| **改了源码、重启了，行为却没变** | pnpm 不刷新 `file:` 依赖的副本 | 见「改完源码，怎么让它生效」；`onboard` 会报退出码 4 |
| `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` | 某个 git 依赖需要 build script | `pnpm install --ignore-scripts` |
| 想确认插件真进了组合树 | —— | `dsh --profile web --dump-config` |

## 遗留路径形态（仍支持，但不推荐）

老 profile 里可能写着 `name: 'file:///D:/dsh/packages/dsh-cot-form-b/index.js'`（包入口一直是根目录 `index.js`，v11.8 的目录重组不影响它）。
绝对路径跨不了卷，换机器就失效。`onboard.mjs` 仍能修：

```bash
node deploy/onboard.mjs            # 体检，会标出 [legacy] 项
node deploy/onboard.mjs --apply    # 改写路径（先备份，注释零丢失）
node deploy/onboard.mjs --revert   # 从最近一次备份还原
```

**建议迁到 bundle 形态** —— 迁完之后这两个命令就再也用不上了。
