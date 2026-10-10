
import fs from 'node:fs';
import { judge } from '../tools/gen-ruler.mjs';
import { guardDraft } from '../tools/g1-guard.mjs';
import { estimateTokens } from '../src/tokens.js';

const rd = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const dev = rd('.cfb-offline/sft/dev.jsonl');
const byId = new Map(dev.map((r) => [r.id, r]));

// 产品口径：闸门过 -> 用压缩稿；闸门不过 -> 回退原文（100% 无损）
// 净省 = Σ_过门 (raw_tok - draft_tok) / Σ_全部 raw_tok
function deploy(rows, getDraft, label) {
  let rawAll = 0, saved = 0, pass = 0, n = 0, sumRaw = 0, sumDraft = 0;
  for (const d of dev) {
    const rawTok = estimateTokens(d.raw);
    rawAll += rawTok;
    n++;
    const dr = getDraft(d);
    if (dr == null) continue;
    const g = guardDraft(d.raw, d.ctx, String(dr), { mode: 'strip' });
    const j = judge({ raw: d.raw, ctx: d.ctx, draft: g.draft });
    if (!j.gaugeable) continue;
    if (j.pass) {
      pass++;
      const dt = estimateTokens(g.draft);
      if (dt < rawTok) saved += rawTok - dt;
      sumRaw += rawTok; sumDraft += dt;
    }
  }
  console.log(label.padEnd(18) + '过门 ' + String(pass).padStart(2) + '/' + n +
    ' (' + (100 * pass / n).toFixed(0) + '%)'.padEnd(6) +
    '  净省 ' + (100 * saved / rawAll).toFixed(1) + '%' +
    '  过门稿平均压缩比 ' + (sumRaw ? (sumDraft / sumRaw).toFixed(3) : '-'));
}

console.log('=== 产品口径：闸门 + 回退原文 ===');
console.log('（净省 = 只有过门的单元换成压缩稿，其余全部回退原文）');
console.log('');
deploy(dev, (d) => d.assistant, '教师 DeepSeek');
const v9 = rd('.cfb-offline/kaggle-out/rwkv7-compressor/dev-generations.jsonl');
const v10 = rd('.cfb-offline/kaggle-out/v10/rwkv7-compressor/dev-generations.jsonl');
const v9i = new Map(v9.map((r) => [r.id, r]));
const v10i = new Map(v10.map((r) => [r.id, r]));
deploy(dev, (d) => { const r = v9i.get(d.id); return r ? r.draft : null; }, 'v9 学生 191M');
deploy(dev, (d) => { const r = v10i.get(d.id); return r ? r.draft : null; }, 'v10 学生 191M');
deploy(dev, () => null, '（全回退原文）');

console.log('');
console.log('=== 关键问题：学生"过门"的那些稿子，是不是真的能替代原文？ ===');
console.log('闸门只检查了【不许编、不许丢锚点、要有决策、要压缩】——');
console.log('它【没有】检查"这段话是否还足以让主模型解题"。');
console.log('');
console.log('对照：教师过门的稿子平均压缩比 ' +
  (() => { let a = 0, b = 0; for (const d of dev) {
    const g = guardDraft(d.raw, d.ctx, d.assistant, { mode: 'strip' });
    const j = judge({ raw: d.raw, ctx: d.ctx, draft: g.draft });
    if (j.gaugeable && j.pass) { a += estimateTokens(d.raw); b += estimateTokens(g.draft); } }
    return (b / a).toFixed(3); })());
