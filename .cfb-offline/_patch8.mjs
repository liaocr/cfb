
import fs from 'node:fs';
const F = 'tools/eval-sft.mjs';
let s = fs.readFileSync(F, 'utf8');
const rep = (a, b, label) => {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.log('MISS ' + label + ' n=' + n); process.exit(1); }
  s = s.replace(a, b); console.log('ok ' + label);
};

rep("import { judge, RULER_VERSION, COMPRESSION_TARGET, COMPRESSION_HARD_MAX } from './gen-ruler.mjs'",
    "import { judge, RULER_VERSION, COMPRESSION_TARGET, COMPRESSION_HARD_MAX } from './gen-ruler.mjs'\n" +
    "// G1 的确定性后处理门。判据与尺子的 G1 **同源**（同一个 quoteSpans/anchorsOf/hasAnchor），\n" +
    "// 两边各写一份就会漂移，而漂移不会报错，只会让「门说修好了、尺子说没有」这种\n" +
    "// 谁也看不懂的现象发生。所以这里只 import，绝不复制。\n" +
    "import { guardDraft, orphanCount } from './g1-guard.mjs'",
    'import');

rep("const OUT = path.resolve(ROOT, arg('--out', path.join(path.dirname(GENP), 'eval-sft.json')))",
    "const OUT = path.resolve(ROOT, arg('--out', path.join(path.dirname(GENP), 'eval-sft.json')))\n" +
    "// 默认开 strip。理由在 g1-guard.mjs 里：strip 与 off 一样干净（孤儿小句 0），\n" +
    "// 却把 dev 从 25/73 抬到 45/73；drop 多挣 1 条但留下 60 处残骸。\n" +
    "// --guard off 用来复现「没有这道门」的对照。\n" +
    "const GUARD = arg('--guard', 'strip')",
    'guard-arg');

rep("  const tj = judge({ raw: t.raw, ctx: t.ctx, draft: t.draft })\n" +
    "  const sj = judge({ raw: t.raw, ctx: t.ctx, draft: sd })",
    "  const tj = judge({ raw: t.raw, ctx: t.ctx, draft: t.draft })\n" +
    "  const sj = judge({ raw: t.raw, ctx: t.ctx, draft: sd })\n" +
    "  // 后处理门：稿子 -> 摘掉凭空引用 -> 再判。\n" +
    "  // 它**不可能让结果变差**：最坏情况是修复被安全阀退回、结果与不过门时一样，\n" +
    "  // 而不过门的稿子本来就走 raw 兜底（100% 无损）。所以这是纯增益的一步。\n" +
    "  const gd = guardDraft(t.raw, t.ctx, sd, { mode: GUARD })\n" +
    "  const gj = GUARD === 'off' ? sj : judge({ raw: t.raw, ctx: t.ctx, draft: gd.draft })",
    'guard-call');

rep("    teacherGaugeable: tj.gaugeable, studentGaugeable: sj.gaugeable,",
    "    teacherGaugeable: tj.gaugeable, studentGaugeable: sj.gaugeable,\n" +
    "    guardedPass: gj.pass, guardedFailed: gj.failed, guardedScore: gj.score,\n" +
    "    guardedChars: gd.draft.length, guardHits: gd.hits, guardChanged: gd.changed,\n" +
    "    guardReverted: !!gd.reverted, guardInvented: gd.invented || [],\n" +
    "    guardOrphans: GUARD === 'off' ? 0 : orphanCount(gd.draft),",
    'guard-row');

fs.writeFileSync(F, s);
console.log('bytes', s.length);
