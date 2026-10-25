import json
import os
from pathlib import Path
import subprocess
import urllib.request

REPO = 'pponce/homebridge-roborock-matter-plus'
UPSTREAM = 'mathiashornbek/homebridge-roborock-matter'
headers = {'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json'}

def api(route):
    req = urllib.request.Request('https://api.github.com' + route, headers=headers)
    with urllib.request.urlopen(req) as response:
        return json.load(response)

def pages(route):
    result = []
    for page in range(1, 20):
        chunk = api(route + ('&' if '?' in route else '?') + f'per_page=100&page={page}')
        result.extend(chunk)
        if len(chunk) < 100:
            return result
    raise RuntimeError('pagination incomplete')

def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()

subprocess.run(['git', 'fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*'], check=True)
subprocess.run(['git', 'fetch', 'https://github.com/' + UPSTREAM + '.git', 'main:refs/remotes/upstream/main'], check=True)
branches = pages('/repos/' + REPO + '/branches')
by_name = {b['name']: b for b in branches}
preserve = {
    'main', 'MQTT_ACCOUNT_SESSION_RECOVERY', 'SCHEDULE_PAUSE_DELAY',
    'upstream_plus_SCHEDULE_PAUSE_DELAY', 'SCHEDULE_PROTOCOL_CAPTURE',
    'local-server-fast-refresh', os.environ['GITHUB_REF_NAME'],
    'review-delay/local-server-fast-refresh-combined',
    'review-delay/local-server-fast-refresh-minimal',
    'review-delay/local-server-fast-refresh-pr',
}
pulls = []
for repo in [REPO, UPSTREAM]:
    for pr in pages('/repos/' + repo + '/pulls?state=open'):
        head_repo = (pr['head'].get('repo') or {}).get('full_name')
        if head_repo == REPO:
            preserve.add(pr['head']['ref'])
            pulls.append({'url': pr['html_url'], 'branch': pr['head']['ref'], 'sha': pr['head']['sha']})
        if repo == REPO:
            preserve.add(pr['base']['ref'])
preserve.update(b['name'] for b in branches if b.get('protected'))

anchors = []
for name in sorted(preserve):
    if name in by_name and not name.startswith('review-delay/'):
        anchors.append({'name': name, 'sha': by_name[name]['commit']['sha'], 'repo': REPO})
anchors.append({'name': 'upstream/main', 'sha': git('rev-parse', 'refs/remotes/upstream/main'), 'repo': UPSTREAM})
tree_history = {}
for anchor in anchors:
    for line in git('log', '--format=%T %H', anchor['sha']).splitlines():
        tree, commit = line.split(' ', 1)
        tree_history.setdefault(tree, {**anchor, 'retained_commit': commit})

safe = []
keep = []
for branch in branches:
    name, sha = branch['name'], branch['commit']['sha']
    if name in preserve or name.startswith('delete/'):
        keep.append({'name': name, 'sha': sha, 'reason': 'active, protected, already labeled, or used by an open PR'})
        continue
    proof = None
    for anchor in anchors:
        if subprocess.run(['git', 'merge-base', '--is-ancestor', sha, anchor['sha']]).returncode == 0:
            proof = {'reason': 'all commits reachable from retained branch', 'retained_by': anchor}
            break
    if proof is None:
        tree = git('rev-parse', sha + '^{tree}')
        if tree in tree_history:
            proof = {'reason': 'entire file tree matches a commit retained in branch history', 'tree': tree, 'retained_by': tree_history[tree]}
    if proof:
        safe.append({'name': name, 'new_name': 'delete/' + name, 'sha': sha, **proof})
    else:
        keep.append({'name': name, 'sha': sha, 'reason': 'unique history or file tree; not proved redundant'})

result = {'repository': REPO, 'branch_count': len(branches), 'open_prs': pulls, 'anchors': anchors, 'safe': safe, 'keep': keep}
Path('.validation').mkdir(exist_ok=True)
Path('.validation/branch-audit.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'total': len(branches), 'safe': len(safe), 'keep': len(keep)}))
