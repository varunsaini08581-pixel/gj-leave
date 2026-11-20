# Developer helper: test, build, commit, push, and make the backup zip for Drive.
# Usage: python3 tools/ship.py "commit message" "progress log entry (markdown, optional)"
import subprocess, sys, os, datetime, hashlib, glob
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
os.chdir(root)
msg = sys.argv[1]
entry = sys.argv[2] if len(sys.argv) > 2 else ''
subprocess.run(['node', 'tools/build.js'], check=True, stdout=subprocess.DEVNULL)
t = subprocess.run(['node', '--test'], capture_output=True, text=True)
summary = [l for l in t.stdout.splitlines() if l.startswith('# pass') or l.startswith('# fail')]
print(' '.join(summary))
if t.returncode != 0:
    print('TESTS FAILED - not shipping'); sys.exit(1)
if entry:
    s = open('PROGRESS.md').read()
    a = s.index('## Assumptions made in code')
    stamp = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=5.5)).strftime('%d %b %Y, %H:%M')
    s = s[:a] + '### ' + stamp + ' IST\n' + entry.strip() + '\n\n' + s[a:]
    open('PROGRESS.md', 'w').write(s)
subprocess.run(['git', 'add', '-A'], check=True)
full = msg + '\n\nCo-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_012NwDCQ9UhbM8XGtBZSEt6c'
subprocess.run(['git', '-c', 'user.name=Claude', '-c', 'user.email=noreply@anthropic.com', 'commit', '-q', '-m', full], check=True)
p = subprocess.run(['git', '-c', 'push.negotiate=true', 'push', '-q', 'origin', 'main'], capture_output=True, text=True)
st = subprocess.run(['git', 'status', '-sb'], capture_output=True, text=True).stdout.splitlines()[0]
print(st)
n = len(glob.glob('/home/claude/gj-leave-*.zip')) + 1
day = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=5.5)).strftime('%Y-%m-%d')
z = '/home/claude/gj-leave-%s-%02d.zip' % (day, n)
subprocess.run(['git', 'archive', '--format=zip', '-o', z, 'HEAD'], check=True)
print('ZIP', z, hashlib.sha256(open(z, 'rb').read()).hexdigest(), 'GJ-Leave_source_%s_%02d.zip' % (day, n))
