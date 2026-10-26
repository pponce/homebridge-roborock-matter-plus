import json
import os
from pathlib import Path
import subprocess

files = [
    'README.md', 'src/matter_vacuum_accessory.ts',
    'docs/water-tank-warnings.md',
    '__tests__/a-refill-dock-only-blocks-when-both-water-supplies-are-empty.test.js',
    '__tests__/a-full-dirty-water-tank-reaches-the-home-app.test.js',
    '__tests__/a-quiet-robot-does-not-withdraw-a-standing-tank-fault.test.js',
    '__tests__/a-quiet-tank-is-not-a-refilled-tank.test.js',
    '__tests__/a-restart-does-not-repeat-a-standing-tank-warning.test.js',
    '__tests__/housekeeping-at-an-idle-dock-does-not-repeat-a-tank-warning.test.js',
    '.github/workflows/validate-water-tanks.yml',
]
checks = [
    ('format', ['npx', 'prettier', '--write', *files]),
    ('typecheck', ['npm', 'run', 'typecheck']),
    ('build', ['npm', 'run', 'build']),
    ('jest', ['npm', 'test', '--', '--runInBand', '--json', '--outputFile=/tmp/water-tanks-jest.json']),
]
if list(Path('tests').glob('*.test.cjs')):
    checks.append(('node', ['bash', '-c', 'node --test tests/*.test.cjs']))
if list(Path('tests').glob('test_*.py')):
    checks.append(('python', ['python3', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py']))
checks.append(('lint', ['npm', 'run', 'lint']))
results = []
for name, args in checks:
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    tail = result.stdout[-14000:]
    print(f'{name}: exit {result.returncode}\n{tail}', flush=True)
    results.append({'name': name, 'exit': result.returncode, 'tail': tail})
out = {'source_sha': os.environ['GITHUB_SHA'], 'ref': os.environ['GITHUB_REF_NAME'], 'checks': results}
jest = Path('/tmp/water-tanks-jest.json')
if jest.exists():
    data = json.loads(jest.read_text())
    out['jest'] = {k: v for k, v in data.items() if k.startswith('num') or k == 'success'}
    out['failures'] = [
        {'name': t['name'], 'message': t.get('message', '')}
        for t in data.get('testResults', []) if t['status'] != 'passed'
    ]
Path('.validation').mkdir(exist_ok=True)
Path('.validation/water-tanks.json').write_text(json.dumps(out, indent=2) + '\n')
raise SystemExit(1 if any(c['exit'] for c in results) else 0)
