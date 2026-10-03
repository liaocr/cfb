# 迁移手册（MIGRATION.md）

把整个 cfb 工作台搬到新机器 / 交给下一个模型。两条路线，任选其一。

---

## 路线 A（推荐，最轻）：只搬仓库

```bash
git clone https://github.com/liaocr/cfb.git && cd cfb
git checkout arena/01a0f127-cfb            # 当前工作分支（main 落后）
node tools/cfb-cycle.mjs restore           # 从 transfer/cycle-state.json 重建 .cfb-offline（策略/计划/金标，gitignored 运行时状态）
node manifest.mjs && node tools/verify-offline.mjs   # 全量自检必须走真断网入口；需要 Node ≥ 22
```

然后手动做两件仓库里没有的事：
1. 把 `keys.env` 放到 `~/.secrets/keys.env`，`chmod 600`（密钥**从不**进 git）。
2. 把 `transfer/NEXT-MODEL-PROMPT.md` 整份粘给新模型。

> 仓库里已经包含：全部源码与自测、`transfer/` 全量实验数据（run1–run4、traj1–3、direct-*、auto-d2*、oracle-*）、四轮理论侦察文档、`docs/theory/CFB-THEORY-COMPLETE.md`、`docs/analysis/HANDOFF-2026-09-30.md`。

## 路线 B（全量，含仓库外的实验残料）：打包带走

```bash
cd /home/user/cfb
bash tools/migrate-pack.sh               # 产出 /home/user/cfb-migration-YYYYMMDD.tar.gz（不含密钥）
bash tools/migrate-pack.sh --with-secrets   # 另出 cfb-secrets-YYYYMMDD.tar.gz（单独保管！）
```

新机上恢复：

```bash
tar -xzf cfb-migration-*.tar.gz -C /home/user
cd /home/user/cfb && git status -sb && node manifest.mjs && node verify.mjs
```

> 路线 B 里 `workspace-extras` 那些文件（`direct-*`、`effect-*`、`live-*`、`mr/`、`traj*`、`tools-local/`）**大部分与仓库 `transfer/` 内的副本重复**，打进去只是保险；介意体积就只走路线 A。

---

## 恢复后必做自检（5 分钟）

| # | 命令 / 动作 | 期望 |
|---|---|---|
| 1 | `git status -sb` | 干净；分支 `arena/01a0eba2-cfb` |
| 2 | `git log --oneline -3` | 顶部为最新提交 |
| 3 | `node manifest.mjs && node verify.mjs` | 全过（允许 1 条跳过项） |
| 4 | `node tools/audit-noninferiority.mjs` | `N1–N7 = 0` |
| 5 | 读 `transfer/LIVE-MEMORY.md` | 上下文压缩后也**第一时间重读** |
| 6 | 粘 `transfer/NEXT-MODEL-PROMPT.md` 给新模型 | 它应回三句话后开工 |

## 注意事项

- **只允许快进推送**：`git push https://x-access-token:$GITHUB_PAT@github.com/liaocr/cfb.git HEAD:arena/01a0f127-cfb`；绝不 force。
- **git 身份**：`cfb-cleanup <cleanup@local>`。
- **密钥**：`.secrets/keys.env` 永不进 git、永不打印；走路线 B 时密钥包单独保管，别和仓库包混放。
- **Node**：**全量自检需要 ≥ 22**（eval-ready 有 runtime-node 闸；训练套件要求 verify-offline 的断网命名空间）。生产插件本体纯内置模块。沙盒装法：官方 tar 解到 /usr/local（`curl -fsSL https://nodejs.org/dist/v22.21.1/node-v22.21.1-linux-x64.tar.xz | sudo tar -xJ -C /usr/local --strip-components=1`），跨会话不持久需重装。
- 迁移的目标分支是 `arena/01a0f127-cfb`；`main` 落后，别误切。Arena 快照会剥离 `.git/config`：每轮先 `git remote add origin https://github.com/liaocr/cfb.git` 再 fetch。
- 若自检失败：先贴失败套件，**不要**在失败状态下开工。eval-ready / training-* 六套失败而你在 Node<22 或在线环境 ⇒ 大概率是环境不是代码（2026-10-03 实证），用上面的正确入口重验。
