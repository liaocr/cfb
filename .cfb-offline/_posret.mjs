
import fs from 'node:fs';
import { anchorsOf, hasAnchor, norm } from '../tools/gen-ruler.mjs';
const rd = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const dev = rd('.cfb-offline/sft/dev.jsonl');
const byId = new Map(dev.map((r) => [r.id, r]));

function retentionByPos(getDraft) {
  // 4 个位置桶：锚点首次出现在 raw 的前 25% / 25-50% / 50-75% / 后 25%
  const tot = [0, 0, 0, 0];
  const hit = [0, 0, 0, 0];
  for (const d of dev) {
    const draft = getDraft(d);
    if (draft == null) continue;
    const anchors = anchorsOf(d.raw);
    const seen = new Set();
    for (const a of anchors) {
      if (seen.has(a)) continue;
      seen.add(a);
      const p = d.raw.indexOf(a);
      if (p < 0) continue;
      let b = Math.floor((p / Math.max(1, d.raw.length)) * 4);
      if (b > 3) b = 3;
      if (b < 0) b = 0;
      tot[b]++;
      if (hasAnchor(draft, a)) hit[b]++;
    }
  }
  return { tot, hit, rate: tot.map((t, i) => (t ? hit[i] / t : 0)) };
}

const teacher = retentionByPos((d) => d.assistant);
const v10 = rd('.cfb-offline/kaggle-out/v10/rwkv7-compressor/dev-generations.jsonl');
const v10ById = new Map(v10.map((r) => [r.id, r]));
const student = retentionByPos((d) => { const r = v10ById.get(d.id); return r ? r.draft : null; });

console.log('=== 锚点保留率 按其在 raw 中的位置分桶 ===');
console.log('（若学生随位置靠后而保留率骤降，说明输入被压进定长状态时把早先内容挤掉了）');
console.log('');
console.log('位置桶'.padEnd(22) + '教师保留'.padEnd(20) + '学生保留'.padEnd(20) + '锚点数(教师/学生)');
const names = ['前 25%', '25-50%', '50-75%', '后 25%'];
for (let i = 0; i < 4; i++) {
  console.log(names[i].padEnd(22) +
    (100 * teacher.rate[i]).toFixed(1).padStart(5) + '%  (' + teacher.hit[i] + '/' + teacher.tot[i] + ')'.padEnd(8) +
    (100 * student.rate[i]).toFixed(1).padStart(5) + '%  (' + student.hit[i] + '/' + student.tot[i] + ')'.padEnd(8) +
    '  ' + teacher.tot[i] + '/' + student.tot[i]);
}
console.log('');
console.log('教师 首尾差: ' + ((teacher.rate[3] - teacher.rate[0]) * 100).toFixed(1) + ' 点');
console.log('学生 首尾差: ' + ((student.rate[3] - student.rate[0]) * 100).toFixed(1) + ' 点');

// 全局锚点保留
let tt = 0, th = 0, st = 0, sh = 0;
for (const d of dev) {
  const anchors = anchorsOf(d.raw);
  const uniq = [...new Set(anchors)];
  for (const a of uniq) {
    tt++; if (hasAnchor(d.assistant, a)) th++;
    const r = v10ById.get(d.id); if (r) { st++; if (hasAnchor(r.draft, a)) sh++; }
  }
}
console.log('');
console.log('=== 全局锚点保留率 ===');
console.log('  教师 ' + th + '/' + tt + ' = ' + (100 * th / tt).toFixed(1) + '%');
console.log('  学生 ' + sh + '/' + st + ' = ' + (100 * sh / st).toFixed(1) + '%');
