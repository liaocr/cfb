
import fs from 'node:fs';
const F = 'tools/eval-sft.mjs';
let s = fs.readFileSync(F, 'utf8');
const A = "console.log('  \u8f6f\u5206\u9010\u6761\u80dc\u8d1f\uff1a\u5b66\u751f\u8d62 %d \u00b7 \u8f93 %d \u00b7 \u5e73 %d', scoreWins, scoreLoss, scoreTie)";
if (s.split(A).length - 1 !== 1) { console.log('MISS A'); process.exit(1); }
const B = A + "\n" +
"console.log('  \u8f6f\u6807\u51c6\uff08\u8fc7\u95e8 + \u538b\u7f29 <= %s\uff0c**\u8981\u8bad\u7ec3\u5230\u7684\u76ee\u6807\uff0c\u4e0d\u662f\u53ca\u683c\u7ebf**\uff09\uff1a\u6559\u5e08 %d/%d = %s \u00b7 \u5b66\u751f %d/%d = %s',\n" +
"  COMPRESSION_TARGET, tTarget, sn, pc(rate2(tTarget, sn)), sTarget, sn, pc(rate2(sTarget, sn)))\n" +
"if (COMPRESSION_HARD_MAX == null) console.log('  \u538b\u7f29\u786c\u95e8\uff1a\u672a\u88c5\uff08COMPRESSION_HARD_MAX = null\uff09\u2014\u2014 gen-ruler/4 \u8d77\u6539\u4e3a\u8f6f\u6807\u51c6')\n" +
"else console.log('  \u538b\u7f29\u786c\u95e8\uff1atoken \u6bd4 <= %s', COMPRESSION_HARD_MAX)\n" +
"if (tOver || sOver) console.log('  \u26a0 \u6bd4\u539f\u6587\u8fd8\u957f\uff08token \u6bd4 > 1.0\uff09\uff1a\u6559\u5e08 %d \u00b7 \u5b66\u751f %d', tOver, sOver)";
s = s.replace(A, B);

// report 里补 softStandard 块
const C = "  paired: { bothPass: both, studentOnly: sOnly, teacherOnly: tOnly, neither },";
if (s.split(C).length - 1 !== 1) { console.log('MISS C'); process.exit(1); }
const D = "  // \u8f6f\u6807\u51c6\u5c31\u662f\u8fd9\u4e00\u5757\uff1a\u5b83\u4e0d\u62e6\u7a3f\uff0c\u53ea\u8bb0\u8d26\u3002\u5b83\u662f\u4e3b\u6307\u6807\uff0c\u56e0\u4e3a\u786c\u95e8\u53ea\u80fd\u56de\u7b54\u300c\u80fd\u4e0d\u80fd\u7528\u300d\uff0c\n" +
"  // \u56de\u7b54\u4e0d\u4e86\u300c\u597d\u4e0d\u597d\u300d\u3002\n" +
"  softStandard: {\n" +
"    compressionTarget: COMPRESSION_TARGET,\n" +
"    teacher: { pass: tTarget, rate: rate2(tTarget, sn), overRaw: tOver },\n" +
"    student: { pass: sTarget, rate: rate2(sTarget, sn), overRaw: sOver },\n" +
"    note: '\u8fc7\u95e8 + token \u6bd4 <= ' + COMPRESSION_TARGET + '\uff1b\u8fd9\u662f\u8981\u8bad\u7ec3\u5230\u7684\u76ee\u6807\uff0c\u4e0d\u662f\u53ca\u683c\u7ebf',\n" +
"  },\n" +
"  paired: { bothPass: both, studentOnly: sOnly, teacherOnly: tOnly, neither },";
s = s.replace(C, D);
fs.writeFileSync(F, s);
console.log('ok bytes', s.length);
