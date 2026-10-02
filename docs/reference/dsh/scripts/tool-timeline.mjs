import fs from 'node:fs';
const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const calls = [];
for (const line of lines) {
  let e; try { e = JSON.parse(line); } catch { continue; }
  if (e.type === 'tool/call' && e.data?.name) {
    const args = e.data.arguments || '';
    calls.push({ step: e.data.step, time: e.data.time, name: e.data.name, args: args.slice(0, 180) });
  }
}
for (const c of calls) {
  const t = c.time ? new Date(c.time).toISOString().slice(11, 19) : '';
  console.log(`step ${String(c.step).padStart(3)} ${t} ${c.name.padEnd(20)} ${c.args.replace(/\n/g, ' ')}`);
}
