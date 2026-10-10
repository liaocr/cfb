import io
exec(open(r'D:\cfb\.cfb-offline\_stage0.py', encoding='utf-8').read().split('TK = RWKV_TOKENIZER')[0])
TK = RWKV_TOKENIZER(r'D:\cfb\.cfb-offline\rwkv7\rwkv_vocab_v20230424.txt')
OUT = io.open(r'D:\cfb\.cfb-offline\_eos.txt','w',encoding='utf-8')
OUT.write('vocab ids: min=%d max=%d count=%d\n' % (min(TK.idx2token), max(TK.idx2token), len(TK.idx2token)))
for i in [0, 1, 65529, 65530, 65535]:
    OUT.write('  id %-6d -> %r\n' % (i, TK.idx2token.get(i)))
for s in ['<|rwkv_tokenizer_end_of_text|>', '### 压缩稿', '### 题面', '### 思考过程']:
    OUT.write('  %-32r -> %d tokens %s\n' % (s, len(TK.encode(s)), TK.encode(s)))
OUT.close(); print('ok')