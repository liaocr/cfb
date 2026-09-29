import json
def build(name, texts):
    rows = [{'id': k, 'mode': 'v4', 'why': 'condensed', 'text': v.strip(), 'outChars': len(v.strip())} for k, v in texts.items()]
    json.dump({'rows': rows}, open(f'/home/user/oracle/{name}.json', 'w'), ensure_ascii=False, indent=1)
    for r in rows: print(name, r['id'], r['outChars'])
