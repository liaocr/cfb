
import { guardDraft, orphanCount } from '../tools/g1-guard.mjs';
console.log('orphan smoke:', orphanCount('a 是 ，b 和 ，c 的 ，d'));
console.log('orphan normal:', orphanCount('这是正常的句子，没有任何问题。'));
const r = guardDraft('raw has alpha_beta here', 'ctx', 'draft says 「gamma_delta」 and 「alpha_beta」 ok');
console.log(JSON.stringify(r));
