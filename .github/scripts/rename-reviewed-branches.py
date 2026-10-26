import json
import os
from pathlib import Path
import subprocess
import urllib.error
import urllib.parse
import urllib.request

REPO = 'pponce/homebridge-roborock-matter-plus'
UPSTREAM = 'mathiashornbek/homebridge-roborock-matter'
headers = {'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json'}

def api(route, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request('https://api.github.com' + route, headers=headers, data=data)
    with urllib.request.urlopen(request) as response:
        return json.load(response)

def pages(route):
    out = []
    for page in range(1, 20):
        rows = api(route + ('&' if '?' in route else '?') + f'per_page=100&page={page}')
        out.extend(rows)
        if len(rows) < 100: return out
    raise RuntimeError('pagination incomplete')

def branch(repo, name):
    return api('/repos/' + repo + '/branches/' + urllib.parse.quote(name, safe=''))

subprocess.run(['git', 'fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*'], check=True)
subprocess.run(['git', 'fetch', 'https://github.com/' + UPSTREAM + '.git', 'main:refs/remotes/upstream/main'], check=True)
preserve = {'main', 'MQTT_ACCOUNT_SESSION_RECOVERY', 'SCHEDULE_PAUSE_DELAY', 'upstream_plus_SCHEDULE_PAUSE_DELAY', 'SCHEDULE_PROTOCOL_CAPTURE', 'local-server-fast-refresh', os.environ['GITHUB_REF_NAME']}
for repo in [REPO, UPSTREAM]:
    for pr in pages('/repos/' + repo + '/pulls?state=open'):
        if (pr['head'].get('repo') or {}).get('full_name') == REPO:
            preserve.add(pr['head']['ref'])
        if repo == REPO: preserve.add(pr['base']['ref'])

manifest = json.loads(Path('.validation/branch-rename-manifest.json').read_text())
results_path = Path(".validation/branch-rename-results.json")
results = json.loads(results_path.read_text()) if results_path.exists() else []
for item in manifest:
    name, target, sha = item['name'], item['new_name'], item['sha']
    result = {'name': name, 'new_name': target, 'expected_sha': sha}
    try:
        if name in preserve or name.startswith('delete/') or target != 'delete/' + name:
            raise RuntimeError('branch is reserved or rename target is unexpected')
        current = branch(REPO, name)
        if current['name'] != name or current['commit']['sha'] != sha or current.get('protected'):
            raise RuntimeError('source branch changed, was renamed, or is protected')
        try:
            branch(REPO, target)
        except urllib.error.HTTPError as error:
            if error.code != 404: raise
        else:
            raise RuntimeError('target branch already exists')
        anchor = item['retained_by']
        anchor_name = 'main' if anchor['repo'] == UPSTREAM else anchor['name']
        retained = branch(anchor['repo'], anchor_name)['commit']['sha']
        if item['reason'] == 'completed validation workspace; feature source retained':
            def source_tree(ref):
                rows = subprocess.check_output(['git', 'ls-tree', '-r', ref], text=True).splitlines()
                excluded = {'.github/workflows/validate-local-refresh.yml', '.github/scripts/validate-local-refresh.py', '.github/workflows/validate-water-tanks.yml', '.github/scripts/validate-water-tanks.py'}
                return {line.split('\t', 1)[1]: line.split('\t', 1)[0] for line in rows
                        if not line.split('\t', 1)[1].startswith(('dist/', '.validation/'))
                        and line.split('\t', 1)[1] not in excluded}
            if source_tree(sha) != source_tree(retained):
                raise RuntimeError('validation source differs from its retained target')
        elif item['reason'] == 'all commits reachable from retained branch':
            subprocess.run(['git', 'merge-base', '--is-ancestor', sha, retained], check=True)
        else:
            tree = subprocess.check_output(['git', 'rev-parse', sha + '^{tree}'], text=True).strip()
            kept_trees = subprocess.check_output(['git', 'log', '--format=%T', retained], text=True).splitlines()
            if tree != item['tree'] or tree not in kept_trees:
                raise RuntimeError('retained file tree no longer verified')
        renamed = api('/repos/' + REPO + '/branches/' + urllib.parse.quote(name, safe='') + '/rename', {'new_name': target})
        verified = branch(REPO, target)
        if renamed['name'] != target or verified['commit']['sha'] != sha:
            raise RuntimeError('rename response or resulting head differed')
        result.update(status='renamed', sha=verified['commit']['sha'])
    except Exception as error:
        result.update(status='skipped_or_failed', reason=str(error))
    results.append(result)
    print(json.dumps(result), flush=True)
    Path('.validation/branch-rename-results.json').write_text(json.dumps(results, indent=2) + '\n')
raise SystemExit(1 if any(r['status'] != 'renamed' for r in results) else 0)
