import io, json
o = json.loads(io.open(r'D:\cfb\.cfb-offline\sft-test\train.jsonl', encoding='utf-8').readline())
print('system 前 200 字:'); print(o['system'][:200]); print(); print('system 行数:', o['system'].count(chr(10))+1)