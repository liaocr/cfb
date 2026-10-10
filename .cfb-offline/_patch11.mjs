
import fs from 'node:fs';
const F = 'tools/gen-ruler.mjs';
let s = fs.readFileSync(F, 'utf8');
const rep = (a, b, label) => {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.log('MISS ' + label + ' n=' + n); process.exit(1); }
  s = s.replace(a, b); console.log('ok ' + label);
};

rep("export const RULER_VERSION = 'gen-ruler/4'",
    "export const RULER_VERSION = 'gen-ruler/5'", 'version');

rep(
"// 软分（权重和为 1，全部在代码里，注释与代码对不上就是注释错）：\n" +
"//   S1 anchorsKept .28   S2 groundingDensity .18   S3 decisionCoverage .18\n" +
"//   S4 compressionGain .13   S5 tailRetention .13   S6 quoteFidelity .10\n" +
"//   S5 是**反抽取**的那一刀：抽取器只会捞开头，凡是尾部锚点整片丢失的稿子，\n" +
"//   它的语义覆盖就是假的。这一维让「删掉探索过程」这件事第一次有了代价。\n" +
"//   S4 是**压缩**唯一该待的地方（G7 下架后它独自承担这件事）。\n" +
"//\n" +
"// \u26a0 权重在 v4 **一个都没动**。这是刻意的：v9 那一轮的软分（教师 0.6957 / 学生 0.5638）\n" +
"// 必须能和 v4 之后的软分直接比，动了权重就比不出来了。\n" +
"// 「现在先软标准」要的是把压缩从硬门挪到软分，不是把软分重算一遍。",
"// 软分（七项，权重和 1.15，最后除以 1.15；全部在代码里，注释与代码对不上就是注释错）：\n" +
"//   S1 anchorsKept .28   S2 groundingDensity .18   S3 decisionCoverage .18\n" +
"//   S4 compressionGain .13   S5 tailRetention .13   S6 quoteFidelity .10\n" +
"//   S7 orderPreserved .15   \u2190 gen-ruler/5 新增\n" +
"//   S5 是**反抽取**的那一刀：抽取器只会捞开头，凡是尾部锚点整片丢失的稿子，\n" +
"//   它的语义覆盖就是假的。这一维让「删掉探索过程」这件事第一次有了代价。\n" +
"//   S4 是**压缩**唯一该待的地方（G7 下架后它独自承担这件事）。\n" +
"//   S7 是**顺序**唯一该待的地方。\n" +
"//\n" +
"// \u2500\u2500 gen-ruler/5：修两个被**退化阶梯**实测出来的缺陷 \u2500\u2500\n" +
"//\n" +
"// v4 的软分有两个洞，是拿 60 条过门教师稿做退化阶梯实测出来的（不是推演）：\n" +
"//\n" +
"//   缺陷一\u3000打乱句序**完全测不出**。L4（把稿子的句子随机打乱）60/60 全过，\n" +
"//   软分 0.6993 vs 基线 0.7006。机理已逐项确认：六个软分项**全是集合型的**，\n" +
"//   原稿 vs 打乱逐项差 0.0000 / -0.0016 / 0.0000 / +0.0016 / 0.0000 / -0.0243。\n" +
"//   对「压缩**推理**」这个任务，顺序就是含义 \u2014\u2014 打乱之后的稿子不能当思维链读。\n" +
"//   修法：S7 orderPreserved，量「稿中锚点按稿序在 raw 里的位置是否同序」（Kendall tau）。\n" +
"//   候选里它判别力最好（L0 vs L4 的 AUC 0.786，锚点位置 LNDS 0.732，句质心 LNDS 0.556）。\n" +
"//   \u26a0 它**不是**硬门，也不该是：忠实稿自己也只有 0.798（教师会合法地重排），\n" +
"//   任何阈值都会误杀好稿。程度问题就放软分 \u2014\u2014 这正是 v4 立的那条规矩。\n" +
"//\n" +
"//   缺陷二\u3000软分**奖励删内容**。L1（删掉末 25% 句）软分反而**升高** 0.7006 -> 0.7121，\n" +
"//   因为 S4 变好；L2（删掉一半）只降到 0.6898（-1.5%）。而删掉的 107 句里全是决策：\n" +
"//   「如果脚本里 500 返回 None / 空串 / []，那么 bug 坐实」「下一步是先写复现脚本跑一遍」。\n" +
"//   为什么六个维度都没抓到：被删句子的锚点数 1.72/句，保留的是 3.55/句 \u2014\u2014\n" +
"//   **决策是锚点稀疏的散文**，而六个维度里五个是锚点度量。\n" +
"//   修法：S4 改成**到 COMPRESSION_TARGET 封顶**。\n" +
"//\n" +
"//   为什么封顶是对的（而不是拍一个下限）：raw 是英文、稿子是中文，跨语言的散文比对\n" +
"//   从根上不可行（实测：完整稿对 raw 决策句的 4-gram 覆盖率也只有 0.307，判别 AUC 0.539\n" +
"//   \u2014\u2014 等于瞎猜）。所以「压到 0.5 以下」这件事**无法验证是不是无损**，\n" +
"//   而它有两个成因：无损凝练（好）和删内容（坏）。跨语言分不开。\n" +
"//   既然 COMPRESSION_TARGET 已经是权威数，那就**不为超发付钱**：\n" +
"//   到了 0.5 就是满分，再短不加分。这不新增任何阈值 \u2014\u2014 它用的是用户已经定下的那个数。\n" +
"//\n" +
"//   \u26a0 跨版本不可比：v4 的软分和 v5 的软分**不能直接比**（S4 换了公式、多了 S7）。\n" +
"//   要比就把两边都拿 v5 重算 \u2014\u2014 尺子是纯函数、零成本，重算不花钱。\n" +
"//   这条和 v4 那条「权重一个都没动」是同一件事的两面：**只在同版本内比**。",
'header');

rep(
"export function retention(anchors, hay) {\n" +
"  const list = [...new Set(anchors)]\n" +
"  if (!list.length) return 1\n" +
"  let k = 0\n" +
"  for (const a of list) if (hasAnchor(hay, a)) k++\n" +
"  return k / list.length\n" +
"}",
"export function retention(anchors, hay) {\n" +
"  const list = [...new Set(anchors)]\n" +
"  if (!list.length) return 1\n" +
"  let k = 0\n" +
"  for (const a of list) if (hasAnchor(hay, a)) k++\n" +
"  return k / list.length\n" +
"}\n" +
"\n" +
"/**\n" +
" * 顺序保持度 \u2014\u2014 稿中的锚点，按**稿序**看，在 raw 里的位置是不是也同序。\n" +
" *\n" +
" * 为什么需要它（gen-ruler/5）：退化阶梯实测出打乱句序**完全测不出**（L4 60/60 全过，\n" +
" * 软分 0.6993 vs 基线 0.7006）。六个软分项全是集合型的，没有一项看顺序。\n" +
" * 而对「压缩推理」这个任务，顺序就是含义：打乱之后的稿子不能当思维链读。\n" +
" *\n" +
" * 为什么用 Kendall tau 而不是 LNDS：实测判别力 tau 更好\n" +
" * （L0 vs L4 的 AUC 0.786，锚点位置 LNDS 0.732，句质心 LNDS 0.556）。\n" +
" * 映射到 [0,1] 便于当权重项：tau 1 -> 1，tau 0 -> 0.5，tau -1 -> 0。\n" +
" *\n" +
" * 为什么**不是**硬门：忠实稿自己也只有 0.798 \u2014\u2014 教师会合法地重排\n" +
" * （先给结论再补依据、把落点提前）。任何阈值都会误杀好稿。程度问题放软分。\n" +
" *\n" +
" * 位置取 raw 里的**首次**出现。锚点在 raw 里出现多次时首现未必是稿子指的那一次，\n" +
" * 会引入少量噪声；这是已知的、可接受的 \u2014\u2014 它只进软分，不进判决。\n" +
" */\n" +
"export function orderPreserved(raw, draft) {\n" +
"  const nr = norm(raw)\n" +
"  const seen = new Set()\n" +
"  const pos = []\n" +
"  for (const { a } of anchorsWithPos(draft)) {\n" +
"    if (seen.has(a)) continue\n" +
"    seen.add(a)\n" +
"    let at = nr.indexOf(a)\n" +
"    if (at < 0 && a.includes('/')) { const b = base(a); if (b) at = nr.indexOf(b) }\n" +
"    if (at >= 0) pos.push(at)\n" +
"    if (pos.length >= 200) break\n" +
"  }\n" +
"  if (pos.length < 3) return 1\n" +
"  let con = 0, dis = 0\n" +
"  for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) {\n" +
"    if (pos[i] < pos[j]) con++\n" +
"    else if (pos[i] > pos[j]) dis++\n" +
"  }\n" +
"  const tot = (pos.length * (pos.length - 1)) / 2\n" +
"  return tot ? (con - dis) / tot / 2 + 0.5 : 1\n" +
"}",
'orderPreserved');

rep(
"  const gain = Math.max(0, Math.min(1, (1 - tokRatio - 0.10) / 0.75))",
"  // gen-ruler/5：到 COMPRESSION_TARGET **封顶**，见文件头「缺陷二」。\n" +
"  // 旧公式 (1 - tokRatio - 0.10) / 0.75 单调奖励「更短」，而变短可以是压缩、也可以是删内容。\n" +
"  // 跨语言（raw 英文 / 稿中文）无法区分这两者，所以不为超发付钱：\n" +
"  // 到 target 就是满分，再短不加分。用的是用户已定的那个数，没有新阈值。\n" +
"  const gain = COMPRESSION_TARGET < 1\n" +
"    ? Math.max(0, Math.min(1, (1 - tokRatio) / (1 - COMPRESSION_TARGET)))\n" +
"    : Math.max(0, Math.min(1, (1 - tokRatio - 0.10) / 0.75))",
'gain');

rep(
"  const sub = {\n" +
"    S1_anchorsKept: +retention(rawAnchors, draft).toFixed(4),\n" +
"    S2_groundingDensity: +grounded.toFixed(4),\n" +
"    S3_decisionCoverage: +decCov.toFixed(4),\n" +
"    S4_compressionGain: +gain.toFixed(4),\n" +
"    S5_tailRetention: +retention(tailAnchors, draft).toFixed(4),\n" +
"    S6_quoteFidelity: detail.quotes.fidelity,\n" +
"  }\n" +
"  const W = { S1: 0.28, S2: 0.18, S3: 0.18, S4: 0.13, S5: 0.13, S6: 0.10 }\n" +
"  const score = +(sub.S1_anchorsKept * W.S1 + sub.S2_groundingDensity * W.S2 + sub.S3_decisionCoverage * W.S3 + sub.S4_compressionGain * W.S4 + sub.S5_tailRetention * W.S5 + sub.S6_quoteFidelity * W.S6).toFixed(4)",
"  // S7 的判据只读 (raw, draft)，与 S1~S6 一样是纯函数。\n" +
"  const order = orderPreserved(raw, draft)\n" +
"  detail.order = { preserved: +order.toFixed(4), note: 'Kendall tau \u6620\u5c04\u5230 [0,1]\uff1b\u5fe0\u5b9e\u7a3f\u81ea\u5df1\u4e5f\u53ea\u6709 ~0.80' }\n" +
"  const sub = {\n" +
"    S1_anchorsKept: +retention(rawAnchors, draft).toFixed(4),\n" +
"    S2_groundingDensity: +grounded.toFixed(4),\n" +
"    S3_decisionCoverage: +decCov.toFixed(4),\n" +
"    S4_compressionGain: +gain.toFixed(4),\n" +
"    S5_tailRetention: +retention(tailAnchors, draft).toFixed(4),\n" +
"    S6_quoteFidelity: detail.quotes.fidelity,\n" +
"    S7_orderPreserved: +order.toFixed(4),\n" +
"  }\n" +
"  // 权重：原有六项**逐字不动**（.28/.18/.18/.13/.13/.10），新增 S7 = .15，\n" +
"  // 最后除以 1.15 归一。这样做是为了审计方便 \u2014\u2014 老六项的数字在代码里没被改过，\n" +
"  // 谁都看得出「只加了一项」，而不是「把权重重调了一遍」。\n" +
"  const W = { S1: 0.28, S2: 0.18, S3: 0.18, S4: 0.13, S5: 0.13, S6: 0.10, S7: 0.15 }\n" +
"  const WSUM = W.S1 + W.S2 + W.S3 + W.S4 + W.S5 + W.S6 + W.S7\n" +
"  const score = +((sub.S1_anchorsKept * W.S1 + sub.S2_groundingDensity * W.S2 + sub.S3_decisionCoverage * W.S3 + sub.S4_compressionGain * W.S4 + sub.S5_tailRetention * W.S5 + sub.S6_quoteFidelity * W.S6 + sub.S7_orderPreserved * W.S7) / WSUM).toFixed(4)",
'weights');

fs.writeFileSync(F, s);
console.log('bytes', s.length);
