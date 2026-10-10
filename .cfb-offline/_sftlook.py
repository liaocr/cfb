import io, json
p = r'D:\cfb\.cfb-offline\sft-test\train.jsonl'
o = json.loads(io.open(p, encoding='utf-8').readline())
OUT = io.open(r'D:\cfb\.cfb-offline\_sftlook.txt','w',encoding='utf-8')
OUT.write('字段: %s\n\n' % sorted(o.keys()))
OUT.write('=== system（学生训练时看到的指令）===\n' + o['system'][:700] + '\n\n')
OUT.write('=== user 前 400 字 ===\n' + o['user'][:400] + '\n\n')
OUT.write('=== assistant（学生要学的输出）===\n' + o['assistant'][:600] + '\n')
OUT.close(); print('ok')