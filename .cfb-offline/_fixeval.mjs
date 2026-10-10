
import fs from 'node:fs';
const F = 'tools/eval-sft.mjs';
let s = fs.readFileSync(F, 'utf8');
const before = s.length;
const subs = [
  ["\u6709\u53d7\u529b\u70b9\u5b50\u96c6\uff08\u5254\u9664 G0 \u7684 %d \u6761\uff09", "\u6709\u53d7\u529b\u70b9\u5b50\u96c6\uff08gaugeable\uff0c\u5254\u9664 %d \u6761\u65e0\u53d7\u529b\u70b9\u7684\uff09"],
  ["const fc = (k) => { const m = {}; for (const r of rows) for (const f of r[k]) m[f] = (m[f] || 0) + 1; return m }",
   "const fc = (k, src) => { const m = {}; for (const r of (src || rows)) for (const f of r[k]) m[f] = (m[f] || 0) + 1; return m }"],
  ["\u5b66\u751f\u5931\u8d25\u5206\u5e03\uff1a' + fmt(report.student.failCount))",
   "\u5b66\u751f\u5931\u8d25\u5206\u5e03\uff08\u5168\u4f53\uff09\uff1a' + fmt(report.student.failCount))"],
  ["\u6559\u5e08\u5931\u8d25\u5206\u5e03\uff1a' + fmt(report.teacher.failCount))",
   "\u6559\u5e08\u5931\u8d25\u5206\u5e03\uff08\u5168\u4f53\uff09\uff1a' + fmt(report.teacher.failCount))"],
];
for (const [a, b] of subs) {
  const n = s.split(a).length - 1;
  if (n !== 1) { console.log('MISS/AMBIG', n, JSON.stringify(a.slice(0, 40))); process.exit(1); }
  s = s.replace(a, b);
}
// 失败分布改成按 gaugeable 统计（全体那两行会被下面的新行取代）
s = s.replace(
  "console.log('  \u5b66\u751f\u5931\u8d25\u5206\u5e03\uff08\u5168\u4f53\uff09\uff1a' + fmt(report.student.failCount))",
  "console.log('  \u5b66\u751f\u5931\u8d25\u5206\u5e03\uff08\u6709\u53d7\u529b\u70b9\uff09\uff1a' + fmt(fc('studentFailed', scoreable)))\nconsole.log('  \u6559\u5e08\u5931\u8d25\u5206\u5e03\uff08\u6709\u53d7\u529b\u70b9\uff09\uff1a' + fmt(fc('teacherFailed', scoreable)))");
s = s.replace(
  "console.log('  \u6559\u5e08\u5931\u8d25\u5206\u5e03\uff08\u5168\u4f53\uff09\uff1a' + fmt(report.teacher.failCount))\n",
  "");
fs.writeFileSync(F, s);
console.log('bytes', before, '->', s.length);
console.log(s.split('\n').slice(184).join('\n'));
