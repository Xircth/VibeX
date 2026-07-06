#!/usr/bin/env python3
"""Merge i18n conversion subtrees from a workflow journal into locale JSON.

Usage: i18n_merge.py <run_id> <namespace>
Reads the workflow journal, collects each agent's {target_key, zh, en}, merges
into frontend/src/i18n/locales/{zh-CN,en}/<namespace>.json (creating if missing),
and verifies key existence + zh/en parity per subtree.
"""
import json, os, sys

run_id = sys.argv[1]
namespace = sys.argv[2]
base = '/Users/sean/Documents/Projetcs/VibeX'
jp = f'{base}/.claude-journal'  # overridden below
# locate journal
proj_journal = None
for root, dirs, files in os.walk(f'{os.path.expanduser("~")}/.claude/projects'):
    if root.endswith(run_id) and 'journal.jsonl' in files:
        proj_journal = os.path.join(root, 'journal.jsonl'); break
if not proj_journal:
    print('journal not found for', run_id); sys.exit(1)

results = []
for line in open(proj_journal):
    try: r = json.loads(line)
    except: continue
    if r.get('type') == 'result' and isinstance(r.get('result'), dict) and r['result'].get('target_key'):
        results.append(r['result'])
print('collected', len(results), 'subtrees:', [r['target_key'] for r in results])
if not results:
    sys.exit(1)

def unwrap(sub, key):
    # Agents sometimes wrap the subtree in {target_key: {...}} and sometimes not.
    if isinstance(sub, dict) and set(sub.keys()) == {key}:
        return sub[key]
    return sub

fe = f'{base}/frontend/src/i18n/locales'
for lang in ['zh-CN', 'en']:
    p = f'{fe}/{lang}/{namespace}.json'
    data = json.load(open(p)) if os.path.exists(p) else {}
    for r in results:
        data[r['target_key']] = unwrap(r['zh' if lang == 'zh-CN' else 'en'], r['target_key'])
    with open(p, 'w') as f:
        json.dump(data, f, ensure_ascii=False, indent=2); f.write('\n')
    print('merged ->', p)

# verify
zh = json.load(open(f'{fe}/zh-CN/{namespace}.json'))
def get(d, path):
    cur = d
    for part in path.split('.'):
        if not isinstance(cur, dict) or part not in cur: return None
        cur = cur[part]
    return cur
missing = [k for r in results for k in r['keys_used'] if get(zh, k) is None]
print('MISSING keys:', missing or 'none')
def leaves(d, pref, acc):
    for k, v in d.items():
        if isinstance(v, dict): leaves(v, pref + k + '.', acc)
        else: acc.add(pref + k)
for r in results:
    zk, ek = set(), set()
    leaves(unwrap(r['zh'], r['target_key']), '', zk)
    leaves(unwrap(r['en'], r['target_key']), '', ek)
    print(r['target_key'], 'parity:', 'OK' if zk == ek else f'MISMATCH {zk ^ ek}')
