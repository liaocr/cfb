
import fs from 'node:fs';
const F = 'tools/eval-sft.mjs';
let s = fs.readFileSync(F, 'utf8');
const rep = (a, b, label) => {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.log('MISS ' + label + ' n=' + n); process.exit(1); }
  s = s.replace(a, b); console.log('ok ' + label);
};

// 统计
rep("const tOver = scoreable.filter((r) => r.teacherTokRatio > 1.0).length\n" +
    "const sOver = scoreable.filter((r) => r.studentTokRatio > 1.0).length",
    "const tOver = scoreable.filter((r) => r.teacherTokRatio > 1.0).length\n" +
    "const sOver = scoreable.filter((r) => r.studentTokRatio > 1.0).length\n" +
    "// 后处理门：过门数 + **有没有把本来过门的稿子弄坏**（那一项必须为 0，不为 0 就是门有 bug）\n" +
    "const gPass = scoreable.filter((r) => r.guardedPass).length\n" +
    "const gBroke = rows.filter((r) => r.studentPass && !r.guardedPass).length\n" +
    "const gFixed = rows.filter((r) => !r.studentPass && r.guardedPass).length\n" +
    "const gHit = rows.filter((r) => r.guardHits > 0).length\n" +
    "const gReverted = rows.filter((r) => r.guardReverted).length\n" +
    "const gOrphans = rows.reduce((a, r) => a + r.guardOrphans, 0)\n" +
    "const gScore = scoreable.map((r) => r.guardedScore)",
    'guard-stats');

// report
rep("  paired: { bothPass: both, studentOnly: sOnly, teacherOnly: tOnly, neither },",
    "  // 后处理门：把学生稿过一遍 G1 闸之后的成绩。\n" +
    "  // 「不劣于原稿」在这里是可验证的：brokePass 必须是 0。\n" +
    "  guard: { mode: GUARD, hits: gHit, fixed: gFixed, brokePass: gBroke, reverted: gReverted,\n" +
    "    orphanClauses: gOrphans,\n" +
    "    studentPass: gPass, studentRate: rate2(gPass, sn), studentMeanScore: mean(gScore),\n" +
    "    note: '摘掉引号里的凭空锚点。不修不编，只摘；最坏退回原稿，所以不可能变差' },\n" +
    "  paired: { bothPass: both, studentOnly: sOnly, teacherOnly: tOnly, neither },",
    'guard-report');

// console
rep("  console.log('  学生失败分布（有受力点）：' + fmt(fc('studentFailed', scoreable)))",
    "  console.log('  ── 过 G1 后处理门（' + GUARD + '）后 ──')\n" +
    "  console.log('  学生 %d/%d = %s（命中 %d 条，修好 %d 条，弄坏 %d 条，退回 %d 条，孤儿小句 %d）',\n" +
    "    gPass, sn, pc(rate2(gPass, sn)), gHit, gFixed, gBroke, gReverted, gOrphans)\n" +
    "  console.log('  软分（过门后）：教师 %s · 学生 %s', report.softScore.teacherMean, mean(gScore))\n" +
    "  if (gBroke) console.error('  FATAL: 后处理门把 ' + gBroke + ' 条本来过门的稿子弄坏了 —— 门有 bug')\n" +
    "  console.log('  学生失败分布（有受力点，未过门）：' + fmt(fc('studentFailed', scoreable)))",
    'guard-console');

fs.writeFileSync(F, s);
console.log('bytes', s.length);
