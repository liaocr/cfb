// Extract readable content from the exported DSH session JSONL.
// Usage: node extract.mjs <session.jsonl> <outDir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';

const [, , sessionPath, outDir] = process.argv;
mkdirSync(outDir, { recursive: true });

const out = {
  user: [],        // user/message texts
  assistant: [],   // assistant/message text blocks
  toolCalls: [],   // tool/call summaries
  toolResults: [], // tool/result summaries
  turns: [],       // turn/start + turn/end
  steps: [],       // step/start + step/end
  misc: [],
};

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b.type === 'text') return b.text;
        if (b.type === 'tool_use') return `[tool_use:${b.name}]`;
        if (b.type === 'reasoning' && Array.isArray(b.summary)) return `[reasoning-summary:${b.summary.length}]`;
        return `[block:${b.type}]`;
      })
      .join('\n');
  }
  return JSON.stringify(content);
}

function truncate(s, n = 1200) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `…[+${s.length - n} chars]` : s;
}

const rl = createInterface({ input: createReadStream(sessionPath, 'utf8'), crlfDelay: Infinity });
let lineNo = 0;
for await (const line of rl) {
  lineNo++;
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  const seq = o.seq ?? lineNo;
  const rec = { seq, time: o.time, ...o.data };
  switch (o.type) {
    case 'session/title':
      out.misc.push(`[title] ${JSON.stringify(o.data)}`);
      break;
    case 'user/message':
      out.user.push(`\n===== USER ${seq} (t=${o.time}) =====\n${textOf(o.data.content)}`);
      break;
    case 'assistant/message': {
      const m = o.data?.message;
      const c = m?.content ?? m;
      const textParts = Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text) : [];
      const toolUses = Array.isArray(c) ? c.filter((b) => b.type === 'tool_use').map((b) => `[tool_use:${b.name}]`) : [];
      const final = [...textParts, ...toolUses].join('\n');
      if (final.trim()) out.assistant.push(`\n===== ASSISTANT ${seq} (t=${o.time}) =====\n${final}`);
      break;
    }
    case 'tool/call': {
      const args = JSON.stringify(o.data?.arguments ?? {});
      out.toolCalls.push(`[${seq}] ${o.data?.name} ${truncate(args, 600)}`);
      break;
    }
    case 'tool/result': {
      const c = o.data?.content;
      const s = typeof c === 'string' ? c : JSON.stringify(c ?? {});
      out.toolResults.push(`[${seq}] ${o.data?.name ?? ''} -> ${truncate(s, 400)}`);
      break;
    }
    case 'turn/start':
      out.turns.push(`[${seq}] TURN START t=${o.time}`);
      break;
    case 'turn/end':
      out.turns.push(`[${seq}] TURN END t=${o.time} dur=${o.data?.durationMs ?? o.data?.duration ?? ''}`);
      break;
    case 'step/start':
    case 'step/end':
      out.steps.push(`[${seq}] ${o.type} ${o.data ? JSON.stringify(o.data) : ''}`);
      break;
    case 'compaction/start':
    case 'compaction/end':
    case 'compaction/prune':
      out.misc.push(`[${seq}] ${o.type} ${o.data ? JSON.stringify(o.data).slice(0, 300) : ''}`);
      break;
    default:
      break;
  }
}

for (const [k, v] of Object.entries(out)) {
  if (v.length) writeFileSync(`${outDir}/${k}.txt`, v.join('\n'), 'utf8');
  console.log(`${k}: ${v.length}`);
}
console.log('lines:', lineNo);
