# 操作手册 · 阶段 0（从零开始，一步一步）

> 配套 [`DECISION-2026-09-27.md`](DECISION-2026-09-27.md)。本手册只讲**怎么敲**，不讲为什么。
> 每一步都有「你应该看到什么」和「没看到怎么办」。按顺序做，不要跳步。
> 命令以 **Windows PowerShell** 为准（仓库历史上的部署机是 Windows）；macOS / Linux 的差异见文末附录。
> 全程**不需要**懂代码。遇到任何一步和描述不符，停下来，把屏幕上的完整输出发给我。

---

## 总览：你要做的只有 5 件事

| 步 | 做什么 | 耗时 | 风险 |
|---|---|---|---|
| 1 | 把补丁套进你的仓库，跑自检 | 15 分钟 | 零（只动仓库，不动线上） |
| 2 | 让 DSH 用上新代码（重装副本 → 体检 → 重启） | 10 分钟 | 零（配置保持 dryRun） |
| 3 | 阶段 0a：正常用 DSH 2–3 天，每天跑一次报告 | 2–3 天 | 零（插件不介入主流） |
| 4 | 阶段 0b：改一行配置进入「包装态」，再用 3–5 天 | 3–5 天 | 极低（插件在路径里，但不归档、不调副模型、不改写） |
| 5 | 把报告发给我，进阶段 1 | 5 分钟 | — |

---

## 第 0 步 · 准备（5 分钟）

1. 打开 PowerShell：按 `Win + X`，选「终端」或「Windows PowerShell」。
2. 逐条输入，确认版本：

```powershell
node -v        # 应显示 v20.x 或更高（例如 v22.x）
git --version  # 应显示 git version 2.x
pnpm -v        # 应显示一个版本号（例如 9.x / 10.x）
```

> 任一条报「不是内部或外部命令」⇒ 对应软件没装或不在 PATH。先告诉我是哪一条。

3. 找到你的 cfb 仓库目录（就是 DSH 里登记为 `file:` 依赖的那个 checkout）：

```powershell
Get-Content "$HOME\.dsh\profiles\web\package.json"
```

在输出里找这一行：`"@dsh-external/dsh-cot-form-b": "file:......"`，`file:` 后面就是目录。下文用 `<CFB>` 代表它。

> 找不到这一行 ⇒ 插件根本没装进 profile。停下，告诉我，我们先按 `INSTALL.md` 装。
> 你的 profile 不叫 `web`（比如 `tui`）⇒ 把本文所有 `profiles\web` 换成你的名字。

4. 把本次的补丁文件 **`cfb-2026-09-27.patch`** 从对话工作区下载到 `下载` 文件夹（PowerShell 里是 `$HOME\Downloads`）。

---

## 第 1 步 · 套补丁 + 自检（15 分钟）

```powershell
cd <CFB>
git status
```

**应该看到**：`nothing to commit, working tree clean`。
**如果有改动**：先 `git stash`（把改动暂存起来，之后 `git stash pop` 可取回）。

```powershell
git fetch origin
git checkout main
git pull --ff-only
git log --oneline -1
```

**应该看到**最后一行以 `e7d01e1` 开头（这是我审计的基线）。
**如果不是**：说明 main 之后又有新提交。继续往下做，补丁多半仍能套上；套不上时看下面的「套不上」。

```powershell
git checkout -b audit-2026-09-27
git am --3way "$HOME\Downloads\cfb-2026-09-27.patch"
```

**应该看到**三行 `Applying: ...`（审计修复 / 路线决议 / 阶段 0 工具），没有 `error` 字样。

> **套不上**（出现 `Patch failed` / `error: patch does not apply`）：
> ```powershell
> git am --abort
> git apply --3way --whitespace=nowarn "$HOME\Downloads\cfb-2026-09-27.patch"
> ```
> 若仍报错，把完整输出发给我，**不要**手工改文件。

自检：

```powershell
node verify.mjs
node manifest.mjs --check
```

**应该看到**：
- `合计: 1388 通过 / 0 失败 / 1 跳过   (27/27 套件通过)`（那 1 项跳过是固定的，需要宿主兄弟包）
- `文件 148 个；漂移/新增 0；缺失 0`

两条都对 ⇒ 合并进 main 并推到 GitHub：

```powershell
git checkout main
git merge --ff-only audit-2026-09-27
git push origin main
```

> `git push` 要是问用户名密码/要 token，按你平时推代码的方式来；推不上去也**不影响**后面的步骤（线上用的是本地目录）。

---

## 第 2 步 · 让 DSH 用上新代码（10 分钟）

这一步是历史上出过事故的地方（源码改了、DSH 却还在跑旧副本）。四个动作一个都不能省。

### 2.1 删旧副本、重装

```powershell
Remove-Item -Recurse -Force "$HOME\.dsh\profiles\web\node_modules\@dsh-external\dsh-cot-form-b"
cd "$HOME\.dsh\profiles\web"
pnpm install --ignore-scripts
```

### 2.2 体检（必须过）

```powershell
cd <CFB>
node deploy\onboard.mjs
echo $LASTEXITCODE
```

**应该看到**：报告里部署漂移一项为「与源树一致」，并且 `echo` 输出 **`0`**。
**如果输出 `4`**：副本和源树不一致 ⇒ 回到 2.1 重做一遍（大多是 `Remove-Item` 没删干净）。其它数字 ⇒ 把报告发我。

### 2.3 写阶段 0a 的配置

打开 `$HOME\.dsh\profiles\web\cordis.patch.yml`（记事本即可：`notepad "$HOME\.dsh\profiles\web\cordis.patch.yml"`）。
找到 `- id: cot-form-b` 这一段，把它**整段**改成：

```yaml
- id: cot-form-b
  config:
    mode: birth
    dryRun: true
    trace: true
```

> 三条铁律：
> ① 顶层必须是 `- id: cot-form-b`，**不要**写成 `- insert:`（那会启动失败 `duplicate loader entry id`）。
> ② `config:` 是**整体替换**：这里没写的键全部回到缺省值——阶段 0a 我们就是要缺省值。
> ③ 先把原来那一段**复制一份存到别处**（比如 `cordis.patch.yml.bak-0927`），第 4 步之后还要改回去。

### 2.4 重启 DSH，确认上岗

关掉正在运行的 DSH（它所在的窗口按 `Ctrl + C`，或按你平时的方式停掉），再启动：

```powershell
dsh
```

另开一个 PowerShell 窗口，看 BOOT 行：

```powershell
Get-Content "$HOME\.dsh\storages\cot-form-b\trace.log" | Select-String "\[BOOT\]" | Select-Object -Last 1
```

**应该看到**一行很长的 JSON，里面含 `"mode":"birth"`、`"dryRun":true`，并且有 `"selfId":"<数字>@<数字>"`。

确认 selfId 的第一个数字 = 已安装副本里 `src\plugin.js` 的文件大小（这就是「跑的确实是新代码」的证据）：

```powershell
(Get-Item "$HOME\.dsh\profiles\web\node_modules\@dsh-external\dsh-cot-form-b\src\plugin.js").Length
```

两个数一致 ⇒ 上岗成功。不一致 ⇒ DSH 没真正重启，或 2.1 没做对；重做 2.1–2.4。

> BOOT 行里如果出现 `"unknownOptions":[...]` 且括号里不为空 ⇒ 配置有拼错的键，把那行发我。

---

## 第 3 步 · 阶段 0a：正常使用 2–3 天（零风险）

什么都不用改，像平时一样用 DSH 干活。插件此时**不介入主流**，只记 trace。

每天（或每干完一个大任务后）跑一次报告：

```powershell
cd <CFB>
node tools\phase0-report.mjs "$HOME\.dsh\storages\cot-form-b\trace.log"
```

> 如果同目录下出现了 `trace.log.1`（轮转产生），两个一起给：
> `node tools\phase0-report.mjs "$HOME\.dsh\storages\cot-form-b\trace.log.1" "$HOME\.dsh\storages\cot-form-b\trace.log"`

报告长这样（每个数字后面已经写好了决策表的判定，你不用解释它）：

```
组 #1  BOOT ... dryRun=true ...
N1  历史 reasoning 跨 user 轮保留？   是 ⇒ 全路线成立
N2  reasoning 块长度分布   来源：近似（...阶段 0b 后会变成精确值）
N3  免费窗口 ...   无数据（需要阶段 0b）
N5  宿主模型   单一模型 deepseek-xxx
N6  基线（粗粒度）   会话 12；每会话请求 p50 ...
健康  全绿
```

**阶段 0a 结束条件**（满足就进第 4 步）：
- 报告里 `llm-stream` 次数 ≥ **100**；
- N1 的判定不是「样本不足」；
- 「健康」一行为全绿。

把这份报告原样贴给我。

---

## 第 4 步 · 阶段 0b：包装态 3–5 天（极低风险）

现在把插件放进主流的路径里，但用一个**不可能达到的门槛**让它对每一块都「原样放行」——不归档、不调副模型、不改写。目的有两个：拿到 N2 的精确分布与 N3/N4 的窗口数据；同时证明「插件在路径里」这件事本身对宿主无害。

### 4.1 改配置

`notepad "$HOME\.dsh\profiles\web\cordis.patch.yml"`，把那一段改成：

```yaml
- id: cot-form-b
  config:
    mode: birth
    dryRun: false
    birth:
      minChars: 100000000
    trace: true
```

只比 0a 多了 `dryRun: false` 和 `minChars: 100000000`（一亿字符，任何块都到不了）。

### 4.2 重启，确认

重启 DSH（同 2.4），然后：

```powershell
Get-Content "$HOME\.dsh\storages\cot-form-b\trace.log" | Select-String "\[BOOT\]" | Select-Object -Last 1
```

**应该看到** `"dryRun":false`。

随便和 DSH 聊一轮需要它思考的问题，再看：

```powershell
Get-Content "$HOME\.dsh\storages\cot-form-b\trace.log" | Select-String "birth-below-floor|birth-window-probe|birth-fired" | Select-Object -Last 5
```

**应该看到**：有 `birth-below-floor`（每个 reasoning 块一行）和 `birth-window-probe`（每次回复一行）；**绝不能**出现 `birth-fired`（出现 = 门槛没生效，立刻停，发我）。

### 4.3 安全阀（背下来）

任何时候觉得不对劲（DSH 报错、回复卡住、内容异常）：
1. 把 `dryRun: false` 改回 `dryRun: true`；
2. 重启 DSH；
3. 把 `trace.log` 最后 200 行发我：`Get-Content "$HOME\.dsh\storages\cot-form-b\trace.log" -Tail 200`。

这就是一行回滚，回到阶段 0a 的状态。

### 4.4 每天跑报告

命令同第 3 步。**阶段 0b 结束条件**：
- N2 来源变成「精确」，块数 ≥ **300**；
- N3 有数据，流数 ≥ **100**；
- 「健康」全绿（尤其不能有 `birth-start-error` / `birth-settle-error`）。

---

## 第 5 步 · 交报告，进阶段 1

把 0a 和 0b 的两份最终报告贴给我。我会把 N1–N6 填进 `DECISION-2026-09-27.md` §5 的表，并给你阶段 1 的手把手（离线评测）。

阶段 1 之前请你顺手准备三样东西（不急，边观测边准备）：

1. **一个真实会话的日志文件**（DSH 自己保存的会话记录，任意一个，路径告诉我即可）—— 我据此给你写「会话 → cf-eval fixture」的转换器；
2. **确认一个候选的小副模型名**（同一个 provider 下更便宜/更快的那档，比如 `deepseek-chat` 之类；N5 报告会告诉我们宿主现在用的是哪个）；
3. **离线评测的预算上限**（30–50 个 fixture × 4 个变体 × 3 次采样 ≈ 数百次主模型调用；先定一个你能接受的金额，我按它裁样本数）。

---

## 绝对不要做的事（阶段 0 期间）

- 不要把 `dryRun: false` 和一个**真实的**门槛（比如 3100）一起打开——那是阶段 2 的事，前面还有阶段 1 的闸门。
- 不要改 `src\` 下任何文件；不要跑 `node deploy\onboard.mjs --apply`（那是修老式路径注册用的）。
- 不要删 `trace.log`。它就是我们要的数据。
- 不要同时开 `stateMemory` / `checkpoint` / `birthDeferredClaim` —— 已冻结。

## 遇到问题速查

| 现象 | 处理 |
|---|---|
| `git am` 报错 | 第 1 步「套不上」的两条命令；仍不行发我输出 |
| `verify.mjs` 有 FAIL | 不要继续，发我 FAIL 那几行 |
| `onboard.mjs` 退出码 4 | 重做 2.1 |
| BOOT 行 selfId 与文件大小不一致 | DSH 没真正重启；彻底关掉再开 |
| BOOT 里 `unknownOptions` 非空 | 配置键拼错，发我那行 |
| DSH 启动报 `duplicate loader entry id` | profile 里写成了 `- insert:`，改回 `- id: cot-form-b` |
| 4.2 看到 `birth-fired` | 立刻回滚（4.3），发我 |
| 报告说「没有解析到任何 trace 记录」 | 路径不对，或 `$DSH_HOME` 被设成别处：`echo $env:DSH_HOME` 看一眼 |

---

## 附录 · macOS / Linux 命令对照

| Windows PowerShell | macOS / Linux（bash/zsh） |
|---|---|
| `$HOME\.dsh\profiles\web\...` | `~/.dsh/profiles/web/...` |
| `Get-Content 文件` | `cat 文件` |
| `Get-Content 文件 \| Select-String "x"` | `grep "x" 文件` |
| `Get-Content 文件 -Tail 200` | `tail -n 200 文件` |
| `Remove-Item -Recurse -Force 目录` | `rm -rf 目录` |
| `echo $LASTEXITCODE` | `echo $?` |
| `(Get-Item 文件).Length` | `stat -f %z 文件`（mac）/ `stat -c %s 文件`（Linux） |
| `notepad 文件` | `nano 文件` 或任意编辑器 |
| `node deploy\onboard.mjs` | `node deploy/onboard.mjs` |
