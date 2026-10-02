// tools/helpers/aci.mjs —— v14.13（DSH 合并 P1）：主模型的「工具面」（Agent–Computer Interface）成为可控变量。
//   cfb       = 本仓库轨迹器一直在用的面：中文系统提示 + bash / read_file / edit_file（一行中文描述）。
//   rl-native = DeepSeek 官方 harness（@deepseek-ai/dsh）B 版预设的面：系统提示只有一句 RL 训练句
//               `You are a helpful software engineer assistant.`，工具只有 bash + str_replace_editor，
//               两个工具的 name / description / parameters **逐字**取自 npm 上的官方包
//               @deepseek-ai/dsh-tool-bash@0.1.0-rc.6 与 @deepseek-ai/dsh-tool-str-replace-editor@0.1.0-rc.6（BSD-3-Clause；
//               原文件已存 docs/reference/dsh-tools/）。bash 取「无后台、无沙箱升级」形态（与本轨迹器沙箱一致）。
//   为什么：DSH 的 SESSION-NOTES 纪元 I 记录同一 flash 从 25 工具全目录（91 分）换成这两个工具当场收敛到 98/99；
//   SWE-agent 的 ACI 研究同一结论；而 cfb 的 29+ 条轨迹从未控制过这个变量，系统提示里还明写「一次可以发多个独立调用」
//   （Overthinking 论文里的 Rogue Actions）。本文件只定义面与 str_replace_editor 的执行语义，不含任何引导文本。
import fs from 'node:fs'
import path from 'node:path'

export const RL_PERSONA = 'You are a helpful software engineer assistant.'
/** 假仓库在模型眼里的绝对路径（GENERIC `pwd` 一直这么答）；rl-native 的 str_replace_editor 要求绝对路径，这里做双向映射。 */
export const DISPLAY_ROOT = '/home/u/work/repo'

export const DSH_TOOLS_PROVENANCE = {
  bash: '@deepseek-ai/dsh-tool-bash@0.1.0-rc.6 (npm, BSD-3-Clause) — bashDescription(backgroundEnabled=false, escalationModes=[])',
  str_replace_editor: '@deepseek-ai/dsh-tool-str-replace-editor@0.1.0-rc.6 (npm, BSD-3-Clause) — DEFAULT_DESCRIPTION + parameters',
  fetchedAt: '2026-10-02',
  note: 'DSH_ENV_PREFIX = "DSH_"（@deepseek-ai/dsh-subprocess）；本沙箱对 `env` 的 canned 输出已含 DSH_HOME',
}

// —— 逐字：dsh-tool-bash bashDescription(false, []) ——
export const BASH_DESCRIPTION_DSH = 'Execute a bash command (`bash -c`) and return its stdout/stderr. Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — pass `workdir` instead of using `cd`. Non-zero exits are reported as `[exit code: N]`. Current harness environment facts are exposed through managed `$DSH_*` variables; inspect them when needed. Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way. Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. Background execution is not available; long-running commands must finish within the timeout.'

// —— 逐字：dsh-tool-str-replace-editor DEFAULT_DESCRIPTION ——
export const STR_REPLACE_EDITOR_DESCRIPTION_DSH = [
  'Custom editing tool for viewing, creating and editing files',
  '* State is persistent across command calls and discussions with the user',
  '* If `path` is a file, `view` displays the result of applying `cat -n`. If `path` is a directory, `view` lists non-hidden files and directories up to 2 levels deep',
  '* The `create` command cannot be used if the specified `path` already exists as a file',
  '* If a `command` generates a long output, it will be truncated and marked with `<response clipped>`',
  '',
  'Notes for using the `str_replace` command:',
  '* The `old_str` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!',
  '* If the `old_str` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in `old_str` to make it unique',
  '* The `new_str` parameter should contain the edited lines that should replace the `old_str`',
].join('\n')

export const TOOLS_RL_NATIVE = [
  { type: 'function', function: { name: 'bash', description: BASH_DESCRIPTION_DSH, parameters: { type: 'object', properties: {
    command: { type: 'string', description: 'The bash command to execute.' },
    description: { type: 'string', description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; "git status" → "Show working tree status"; "npm test" → "Run the test suite".' },
    timeoutMs: { type: 'number', description: 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.' },
    workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.' },
  }, required: ['command', 'description'], additionalProperties: false } } },
  { type: 'function', function: { name: 'str_replace_editor', description: STR_REPLACE_EDITOR_DESCRIPTION_DSH, parameters: { type: 'object', properties: {
    command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert'], description: 'The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.' },
    path: { type: 'string', description: 'Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.' },
    file_text: { type: 'string', description: 'Required parameter of `create` command, with the content of the file to be created.' },
    insert_line: { type: 'integer', description: 'Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.' },
    new_str: { type: 'string', description: 'Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.' },
    old_str: { type: 'string', description: 'Required parameter of `str_replace` command containing the string in `path` to replace.' },
    view_range: { type: 'array', items: { type: 'integer' }, description: 'Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.' },
  }, required: ['command', 'path'], additionalProperties: false } } },
]

export const ACI_IDS = ['cfb', 'rl-native']
export const TOOL_PROTOCOLS = ['text', 'native']

/** 调用是不是「编辑」（两种面统一口径；修好率 / edits / reEdit 旗标都靠它）。 */
export function isEditCall(name, args) {
  if (name === 'edit_file') return true
  if (name === 'str_replace_editor') { const c = args && typeof args === 'object' ? args.command : null; return c === 'str_replace' || c === 'insert' || c === 'create' }
  return false
}
/** 编辑结果是否成功（cfb 的 `ok（…）` / DSH 的 `has been edited successfully` / `created successfully`）。 */
export function editOk(out) { return /^ok|has been edited successfully|created successfully/.test(String(out || '')) }
/** 调用是不是「读」（view / read_file / 只读 bash 不算 —— bash 另按命令算）。 */
export function isReadCall(name, args) { return name === 'read_file' || (name === 'str_replace_editor' && args && args.command === 'view') }

const TRUNCATED_MESSAGE = '<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>'
const maybeTruncate = (s, max) => (s.length <= max ? s : s.slice(0, max) + TRUNCATED_MESSAGE)

/** 模型给的路径 → 假仓库里的真实路径；越界 ⇒ null。接受 DISPLAY_ROOT 绝对路径、相对路径、以及 `./`。 */
export function resolveRepoPath(repo, p) {
  let s = String(p || '')
  if (s === DISPLAY_ROOT || s.startsWith(DISPLAY_ROOT + '/')) s = s.slice(DISPLAY_ROOT.length).replace(/^\/+/, '') || '.'
  if (s.startsWith('/')) return null   // 其它绝对路径：不在仓库里
  const r = path.resolve(repo, s)
  return r === repo || r.startsWith(repo + path.sep) ? r : null
}
const display = (repo, real) => DISPLAY_ROOT + (real === repo ? '' : '/' + path.relative(repo, real).split(path.sep).join('/'))

/** str_replace_editor 的执行语义与回文，尽量与官方包一致（view 带行号、目录两层、create 不覆盖、str_replace 必须唯一、insert 在第 N 行后）。 */
export function execStrReplaceEditor(repo, a, { maxOutputChars = 16000 } = {}) {
  const cmd = a && a.command
  const real = resolveRepoPath(repo, a && a.path)
  const shown = String((a && a.path) || '')
  if (!['view', 'create', 'str_replace', 'insert'].includes(cmd)) return `Unrecognized command ${cmd}. The allowed commands for the str_replace_editor tool are: view, create, str_replace, insert`
  if (!real) return `The path ${shown} does not exist. Please provide a valid path.`
  const exists = fs.existsSync(real)
  if (cmd === 'create') {
    if (a.file_text === undefined) return 'Parameter `file_text` is required for command: create'
    if (exists) return `File already exists at: ${display(repo, real)}. Cannot overwrite files using command \`create\`.`
    fs.mkdirSync(path.dirname(real), { recursive: true }); fs.writeFileSync(real, String(a.file_text))
    return `New file created successfully at: ${display(repo, real)}`
  }
  if (!exists) return `The path ${shown} does not exist. Please provide a valid path.`
  const isDir = fs.statSync(real).isDirectory()
  if (cmd === 'view') {
    if (isDir) {
      if (a.view_range !== undefined) return 'The `view_range` parameter is not allowed when `path` points to a directory.'
      const rows = ['d\t' + display(repo, real)]
      const visit = (dir, depth) => { for (const e of fs.readdirSync(dir, { withFileTypes: true }).filter((x) => !x.name.startsWith('.') && x.name !== 'node_modules' && x.name !== '__pycache__')) { const full = path.join(dir, e.name); rows.push((e.isDirectory() ? 'd' : e.isFile() ? 'f' : '?') + '\t' + display(repo, full)); if (e.isDirectory() && depth < 2) visit(full, depth + 1) } }
      visit(real, 1)
      const head = rows[0]; const rest = rows.slice(1).sort((l, r) => (l.slice(2) < r.slice(2) ? -1 : l.slice(2) > r.slice(2) ? 1 : 0))
      return `Here're the files and directories up to 2 levels deep in ${display(repo, real)}, excluding hidden items, node_modules, and Python cache directories:\n${maybeTruncate([head, ...rest].join('\n') + '\n', maxOutputChars)}\n`
    }
    const content = fs.readFileSync(real, 'utf8'); const all = content.split('\n')
    let lines = all, initial = 1, prompt = `Here's the content of ${display(repo, real)} with line numbers (which has a total of ${all.length} lines)`
    if (a.view_range !== undefined) {
      const vr = a.view_range
      if (!Array.isArray(vr) || vr.length !== 2 || !vr.every(Number.isInteger)) return 'Invalid `view_range`. It should be a list of two integers.'
      const [i0, i1] = vr
      if (i0 < 1 || i0 > all.length) return `Invalid \`view_range\`: [${vr.join(', ')}]. Its first element \`${i0}\` should be within the range of lines of the file: [1, ${all.length}]`
      if (i1 > all.length) return `Invalid \`view_range\`: [${vr.join(', ')}]. Its second element \`${i1}\` should be smaller than the number of lines in the file: \`${all.length}\``
      if (i1 !== -1 && i1 < i0) return `Invalid \`view_range\`: [${vr.join(', ')}]. Its second element \`${i1}\` should be larger or equal than its first \`${i0}\``
      initial = i0; lines = i1 === -1 ? all.slice(i0 - 1) : all.slice(i0 - 1, i1); prompt += ` with view_range=[${i0}, ${i1}]`
    }
    return maybeTruncate(`${prompt}:\n${lines.map((l, i) => String(initial + i).padStart(6, ' ') + '  ' + l).join('\n')}\n`, maxOutputChars)
  }
  if (isDir) return `The path ${display(repo, real)} is a directory and only the \`view\` command can be used on directories`
  if (cmd === 'str_replace') {
    const oldStr = a.old_str
    if (oldStr === undefined) return 'Parameter `old_str` is required for command: str_replace'
    if (String(oldStr).length === 0) return 'Parameter `old_str` is empty for command: str_replace'
    const before = fs.readFileSync(real, 'utf8'); const offsets = []
    for (let i = before.indexOf(oldStr); i >= 0; i = before.indexOf(oldStr, i + 1)) offsets.push(i)
    if (!offsets.length) return `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${display(repo, real)}.`
    if (offsets.length > 1) return `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines [${offsets.map((o) => before.slice(0, o).split('\n').length).join(', ')}]. Please ensure it is unique`
    fs.writeFileSync(real, before.slice(0, offsets[0]) + String(a.new_str ?? '') + before.slice(offsets[0] + String(oldStr).length))
    return `The file ${display(repo, real)} has been edited successfully.`
  }
  // insert
  if (a.insert_line === undefined) return 'Parameter `insert_line` is required for command: insert'
  if (a.new_str === undefined) return 'Parameter `new_str` is required for command: insert'
  const before = fs.readFileSync(real, 'utf8'); const lines = before.split('\n'); const n = a.insert_line
  if (!Number.isInteger(n) || n < 0 || n > lines.length) return `Invalid \`insert_line\` parameter: ${n}. It should be within the range of lines of the file: [0, ${lines.length}]`
  const ins = String(a.new_str).split('\n')
  fs.writeFileSync(real, [...lines.slice(0, n), ...ins, ...lines.slice(n)].join('\n'))
  return `The file ${display(repo, real)} has been edited successfully.`
}

/** 解析运行参数里的面：{ id, system, tools }；textTools 只对 cfb 面有意义（rl-native 必须走函数调用）。 */
export function resolveAci(id, { SYSTEM, SYSTEM_TEXT_TOOLS, TOOLS, textTools = false }) {
  if (!ACI_IDS.includes(id)) throw new Error('unknown-aci:' + id)
  if (id === 'rl-native') { if (textTools) throw new Error('aci rl-native 不支持 --text-tools（官方面就是函数调用）'); return { id, system: RL_PERSONA, tools: TOOLS_RL_NATIVE } }
  return { id, system: textTools ? SYSTEM_TEXT_TOOLS : SYSTEM, tools: TOOLS }
}
