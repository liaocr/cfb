
import fs from 'node:fs';
const PART = '是的和与在把被对为了或而就也都还又再才即如若则由从向给让使以及跟同';
const ORPHAN_RX = new RegExp('(?:^|[，。；、：,;:!?！？\\s])\\s*[' + PART + ']?\\s*(?=[，。；、:;:,])', 'g');
const cnt = t => (String(t).match(ORPHAN_RX)||[]).length;
const dev = fs.readFileSync('.cfb-offline/sft/dev.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const full = fs.readFileSync('.cfb-offline/teacher/v4-full.jsonl','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const dist = (arr,label) => { const d={}; for(const x of arr){const c=cnt(x); d[c]=(d[c]||0)+1;} console.log(label, JSON.stringify(d)); };
dist(dev.map(d=>d.assistant), 'dev 教师稿 孤儿分布 ');
dist(full.map(o=>o.draft),  '全量722教师稿 孤儿分布');
dist(dev.map(d=>d.raw),     'dev raw   孤儿分布 ');
const mx = Math.max(...full.map(o=>cnt(o.draft)));
console.log('722 教师稿孤儿最大值 =', mx);
