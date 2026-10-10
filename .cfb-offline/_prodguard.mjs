
import fs from 'node:fs';
import { guardDraft, g1Spans, orphanCount } from '../tools/g1-guard.mjs';
import { estimateTokens } from '../src/tokens.js';

// 生产闸（src/birth.js birthAccept）在发明的标识符上是**整份拒稿 -> 原文放行**：
//   if (invented.length) return { ok:false, why:'invented-identifier' }
// 这里量：改成"摘掉那处引用"之后，有多少单元从"原文放行"变成"能压缩"。
//
// 用 722 条教师稿当代理 —— 它们就是大模型在这个任务上的产出，与生产里的 candidate 同源。
const full = fs.readFileSync('.cfb-offline/teacher/v4-full.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const MIN_SAVED = 50;          // cfg.birthMinSavedChars 缺省 50
const MIN_SAVED_TOK = 0;       // 这里只算字符闸，token 闸另说

let n=0, g1Rows=0, rejectBefore=0, condensedAfter=0, rescued=0;
let strippedChars=0, stillTooSmall=0, orphanTotal=0;
const ex=[];
for (const o of full) {
  const raw = String(o.raw||''), ctx = String(o.ctx||''), draft = String(o.draft||'').trim();
  if (!raw || !draft) continue;
  n++;
  const g = g1Spans(raw, ctx, draft);
  const hitsG1 = g.detected.length > 0;
  if (!hitsG1) continue;
  g1Rows++;
  // 生产当前行为：命中 => 拒稿 => 原文放行（等于零压缩）
  rejectBefore++;
  // 新行为：摘掉引号（保留内容）
  const r = guardDraft(raw, ctx, draft, { mode: 'strip' });
  if (r.reverted) { stillTooSmall++; continue; }
  const saved = raw.length - r.draft.length;
  const savedTok = estimateTokens(raw) - estimateTokens(r.draft);
  strippedChars += r.removedChars;
  orphanTotal += orphanCount(r.draft);
  if (saved >= MIN_SAVED && savedTok >= MIN_SAVED_TOK) {
    condensedAfter++; rescued++;
  } else stillTooSmall++;
  if (ex.length < 4) ex.push({id:o.id, rawLen:raw.length, draftLen:draft.length, afterLen:r.draft.length,
    saved, hits:r.hits, invented:r.invented.slice(0,3), orphans:orphanCount(r.draft)});
}
console.log(JSON.stringify({
  教师稿总数: n,
  命中G1的: g1Rows,
  命中率: +(g1Rows/n).toFixed(4),
  生产现状_整份拒稿: rejectBefore,
  摘除后能压缩: condensedAfter,
  摘除后仍不达标: stillTooSmall,
  救回比例: +(rescued/Math.max(1,g1Rows)).toFixed(4),
  摘除总字符: strippedChars,
  摘除后孤儿小句合计: orphanTotal,
}, null, 1));
console.log(JSON.stringify(ex, null, 1));
