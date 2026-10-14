# 2026-10-14 审计整改记录

基于分支 `repair/audit-2026-10-11` 的已审快照实施；整改只覆盖 `/home/user/cfb` 当前工作树，未提交、未推送。

## 整改项

### F-01｜`traj-run` Bash 注入

- 移除 `bash -c` 执行路径；命令被拆成受限语法后，只能映射到固定绝对路径的只读二进制与 argv，不做 shell 展开、变量展开、通配符展开或重定向。
- 拒绝 LF、CRLF、NUL、未闭合引号、未知操作符/参数；不开放 `awk`、shell、解释器或可执行 `find`/`sed` 脚本。
- `find` 默认物理遍历；递归 `grep` 遇到符号链接或超过扫描限额即拒绝；工具文件与编辑路径同时检查物理路径，不能借仓库内 symlink 读写仓库外文件。
- 保留了必要的只读管道与 fixture canned 输出。**这是一组命令/路径限制，不是通用 OS 沙箱**：不要把任意不可信程序加入 allowlist；高风险任务仍需容器/独立用户/最小挂载等系统隔离。

### F-02 / F-03｜Reader smoke 的预算、超时与隐私

- `tools/run-reader-smoke.mjs` 默认仅打印本地计划；必须显式 `--execute` 才能触网。付费模式要求 API key、最大请求数、最大美元额、费率、费率来源 URL 和核价日期均显式配置。
- 每个 dispatch（包括每次重试）先检查并预留请求数和最坏情况成本，再 fsync 预留记录，之后才发请求；增加 `max_tokens`、输入 token 上限、响应体上限、超时和禁止重定向。没有 usage、usage 越过预留或调用失败时停止，不把未知成本记成零。
- 本地费用上限是按操作员提供的费率、UTF-8 字节输入上界加协议余量和 `max_tokens` 计算的**单次运行本地预留上限**，不是服务商保证或实际账单；要形成真实账单上限，还须配置服务商侧 spending cap。跨多次独立运行的累计额度不在此脚本内。
- 输出改至 `.cfb-runtime/reader-smoke/`，目录/文件权限分别为 `0700`/`0600`；审计事件字段白名单只保存请求/响应 hash、状态、usage、延迟、字符数、预算及费率来源等必要运行元数据，不保存 prompt、响应正文、provider 标识或 reasoning。旧 `transfer/program-2026-10-12/reader-smoke-*.jsonl` 文件模式加入 `.gitignore`。

### F-04｜SFT 学生评测覆盖和去重

- 新增严格输入配对器：冻结 dev 与生成文件必须 ID 一一对应；重复 dev ID、重复生成 ID、未知/缺失 ID、无效行，以及 raw/ctx 不精确匹配都会在评分前失败。
- 评分分母固定为完整 dev 集；仅完整配对成功后才生成 `cfb.eval-sft/2` 报告，并标记 `coverage.complete / oneToOne / rawCtxVerified`。

### F-05｜旧 Kaggle 启动器

- `deploy/kaggle/start.py` 与直接执行的 `deploy/kaggle/train_gen.py` 均已替换成无副作用 tombstone：不安装依赖、不读取凭据、不联网、不克隆、不训练或推送；`start.py --execute` 明确失败关闭，`train_gen.py` 无兼容重开选项并以非零状态退出。
- 旧 Qwen/QLoRA 手册已移除可复制的远端 `curl | python` 单元并标为历史记录；旧 Kaggle notebook 的安装/训练 code cells 已移除；README 和历史提炼/交接文档均注明旧入口已退役。
- **边界**：不可变旧 Git commit/raw URL 上的旧脚本无法由这次未推送的工作树补丁撤回；当前文档明确告诫不得下载运行。

## 回归与边界

新增 `test/audit-remediations.selftest.mjs` 覆盖换行/CRLF 命令注入、危险子语言、symlink 逃逸、预算预占/重试/超时/缺 usage、响应正文不落盘、SFT 重复/缺失/未知/不匹配和旧 Kaggle launcher 关闭。`test/manifest-ignore.selftest.mjs` 同时检查旧 smoke 文件名忽略规则。

## 验证结果

- `node tools/doc-watermark.mjs --record`：online 48/48 suites，1440 passed / 0 failed / 2 skipped；isolated 48/48 suites，1441 passed / 0 failed / 1 skipped；两条 lane 均为 PASS。
- `node manifest.mjs --check` 与 `node tools/doc-watermark.mjs --check` 均通过；`git diff --check` 无空白错误。
- `test/audit-remediations.selftest.mjs`：8/8 通过；完整 `closed-loop-v4` 套件在上述全库验证中通过（45 tests）。
- `node tools/run-reader-smoke.mjs` 仅输出 3 cases / 9 slots 的 plan；一次 `--execute` 检查因未提供必需的 `MAX_REQUESTS` 在配置校验阶段退出，没有 API/网络请求。

本整改没有运行付费 API、模型推理、训练、GPU、Kaggle push 或真实服务商链路。测试通过不证明实际账单、模型读回、语义质量或系统级隔离；`reader-smoke` 也仍不是正式 original-reader study。
