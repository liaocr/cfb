import { headroomOf, minRawCharsFor, bandNameFor, DEFAULT_BANDS, CONSERVATIVE_MIN_CHARS } from './headroom.js'

let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++ } else { fail++; console.log('  ✗ ' + name) } }
const eq = (name, got, want) => { if (got === want) { pass++ } else { fail++; console.log('  ✗ ' + name + '  got=' + got + ' want=' + want) } }

const W = 262144

// ── 1. 三档主干 ────────────────────────────────────────────
eq('新开局（0 占用）⇒ 350', minRawCharsFor(0, W), 350)
eq('占用 10%（剩 90%）⇒ 350', minRawCharsFor(W * 0.10, W), 350)
eq('剩 70.1% ⇒ 350', minRawCharsFor(W * 0.299, W), 350)
eq('边界：剩 70% 恰好 ⇒ 500（规格 30%~70% 含端点）', minRawCharsFor(300, 1000), 500)
eq('剩 69.9% ⇒ 500', minRawCharsFor(W * 0.301, W), 500)
eq('占用 50% ⇒ 500', minRawCharsFor(W * 0.50, W), 500)
eq('边界：剩 30% 恰好 ⇒ 500', minRawCharsFor(700, 1000), 500)
eq('剩 29.9% ⇒ 800', minRawCharsFor(W * 0.701, W), 800)
eq('占用 85%（剩 15%）⇒ 800', minRawCharsFor(W * 0.85, W), 800)

// ── 2. 锯齿自愈：压缩前后同一函数、不同读数 ────────────────
eq('压缩前夕 step50（占 85%）⇒ 800', minRawCharsFor(222822, W), 800)
eq('压缩之后 step52（占 20%）⇒ 350', minRawCharsFor(52428, W), 350)
ok('回弹由物理读数驱动，与步数无关', minRawCharsFor(52428, W) !== minRawCharsFor(222822, W))

// ── 3. 跨窗口免疫 ──────────────────────────────────────────
eq('128k 窗口 50% ⇒ 500', minRawCharsFor(128e3 * 0.5, 128e3), 500)
eq('1M 窗口 50% ⇒ 500', minRawCharsFor(1e6 * 0.5, 1e6), 500)
ok('同比例不同窗口必同档', minRawCharsFor(64e3, 128e3) === minRawCharsFor(512e3, 1e6))

// ── 4. 读数缺失/异常 ⇒ 一律保守 ───────────────────────────
eq('窗口 undefined ⇒ 保守', minRawCharsFor(1000, undefined), CONSERVATIVE_MIN_CHARS)
eq('占用 undefined ⇒ 保守', minRawCharsFor(undefined, W), CONSERVATIVE_MIN_CHARS)
eq('窗口 0 ⇒ 保守（除零防护）', minRawCharsFor(1000, 0), CONSERVATIVE_MIN_CHARS)
eq('窗口负数 ⇒ 保守', minRawCharsFor(1000, -1), CONSERVATIVE_MIN_CHARS)
eq('占用 > 窗口（负剩余）⇒ 保守', minRawCharsFor(W * 1.2, W), CONSERVATIVE_MIN_CHARS)
eq('NaN ⇒ 保守', minRawCharsFor(NaN, W), CONSERVATIVE_MIN_CHARS)
eq('字符串数字 ⇒ 保守（不做隐式转换）', minRawCharsFor('1000', W), CONSERVATIVE_MIN_CHARS)
ok('headroomOf 非法输入返回 undefined', headroomOf(1, 0) === undefined)

// ── 5. 静态覆盖逃生门 ──────────────────────────────────────
eq('staticMinRawChars 完全接管', minRawCharsFor(0, W, { staticMinRawChars: 500 }), 500)
eq('staticMinRawChars=0 也生效', minRawCharsFor(W, W, { staticMinRawChars: 0 }), 0)
eq('非数字则忽略，回落动态档', minRawCharsFor(0, W, { staticMinRawChars: null }), 350)

// ── 6. 自定义档位 ──────────────────────────────────────────
const custom = [{ minHeadroom: 0.5, inclusive: true, minRawChars: 111 }, { minHeadroom: Number.NEGATIVE_INFINITY, inclusive: true, minRawChars: 222 }]
eq('自定义：剩 90% ⇒ 111', minRawCharsFor(0, W, { bands: custom }), 111)
eq('自定义：剩 10% ⇒ 222', minRawCharsFor(W * 0.9, W, { bands: custom }), 222)
ok('默认档位未被污染', DEFAULT_BANDS.length === 3 && DEFAULT_BANDS[0].minRawChars === 350)
ok('末档必须能必然命中（inclusive + -Infinity）', DEFAULT_BANDS[2].inclusive === true && DEFAULT_BANDS[2].minHeadroom === Number.NEGATIVE_INFINITY)

// ── 7. bandName 仅用于 trace ───────────────────────────────
eq('350 ⇒ wide-runway', bandNameFor(350), 'wide-runway')
eq('500 ⇒ steady-cruise', bandNameFor(500), 'steady-cruise')
eq('800 ⇒ near-compaction', bandNameFor(800), 'near-compaction')

console.log('headroom.js 自测：' + pass + ' 通过 / ' + fail + ' 失败')
if (fail > 0) process.exit(1)