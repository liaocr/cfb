
import fs from 'node:fs';
const F = 'tools/gen-ruler.mjs';
let s = fs.readFileSync(F, 'utf8');
const rep = (a, b, label) => {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.log('MISS ' + label + ' n=' + n); process.exit(1); }
  s = s.replace(a, b); console.log('ok ' + label);
};

rep(
"  // gen-ruler/5：到 COMPRESSION_TARGET **封顶**，见文件头「缺陷二」。\n" +
"  // 旧公式 (1 - tokRatio - 0.10) / 0.75 单调奖励「更短」，而变短可以是压缩、也可以是删内容。\n" +
"  // 跨语言（raw 英文 / 稿中文）无法区分这两者，所以不为超发付钱：\n" +
"  // 到 target 就是满分，再短不加分。用的是用户已定的那个数，没有新阈值。\n" +
"  const gain = COMPRESSION_TARGET < 1\n" +
"    ? Math.max(0, Math.min(1, (1 - tokRatio) / (1 - COMPRESSION_TARGET)))\n" +
"    : Math.max(0, Math.min(1, (1 - tokRatio - 0.10) / 0.75))",
"  // gen-ruler/5：压缩收益 = 到 target 封顶的压缩量 x **锚点保留率**。见文件头「缺陷二」。\n" +
"  //\n" +
"  // 两处都必要，实测各修一半：\n" +
"  //   只封顶（gain = (1-tokRatio)/(1-target)，到 target 满分）不够 \u2014\u2014\n" +
"  //     教师逐条的 tokRatio 在 0.5 上下浮动，删句子把更多行推到 0.5 以下，S4 照样涨，\n" +
"  //     L1 仍以 0.7451 > 0.7379 高于 L0。\n" +
"  //   再乘保留率才够 \u2014\u2014 「靠删内容换来的空间不算收益」。\n" +
"  //\n" +
"  // 为什么乘 S1（锚点保留率）而不是别的：它是**唯一跨语言可用**的覆盖度量。\n" +
"  // raw 是英文、稿子是中文，散文级比对不可行（实测完整稿对 raw 决策句的 4-gram 覆盖率\n" +
"  // 也只有 0.307，判别 AUC 0.539 = 瞎猜）。锚点是跨语言不变量，所以只能用它。\n" +
"  // 这里不新增任何阈值 \u2014\u2014 用的是用户已定的 COMPRESSION_TARGET 和已有的 S1。\n" +
"  const anchorsKept = retention(rawAnchors, draft)\n" +
"  const gain = (COMPRESSION_TARGET < 1\n" +
"    ? Math.max(0, Math.min(1, (1 - tokRatio) / (1 - COMPRESSION_TARGET)))\n" +
"    : Math.max(0, Math.min(1, (1 - tokRatio - 0.10) / 0.75))) * anchorsKept",
'gain2');

rep("    S1_anchorsKept: +retention(rawAnchors, draft).toFixed(4),",
    "    S1_anchorsKept: +anchorsKept.toFixed(4),", 's1');

fs.writeFileSync(F, s);
console.log('bytes', s.length);
