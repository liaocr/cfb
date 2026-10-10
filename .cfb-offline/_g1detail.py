import io, json
r=json.load(io.open(r'D:\cfb\.cfb-offline\ruler\report-teacher20.json',encoding='utf-8'))
OUT=io.open(r'D:\cfb\.cfb-offline\_g1detail.txt','w',encoding='utf-8')
for row in r['rows']:
    if row['pass']: continue
    OUT.write(row['id']+' failed='+str(row['failed'])+'\n')
    OUT.write('   detail='+json.dumps(row, ensure_ascii=False)[:1200]+'\n\n')
OUT.close(); print('ok')