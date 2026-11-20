# Round 19 phone-app check (python3 + Playwright, demo mode on 127.0.0.1 only). Prints one JSON object. Writes nothing in the repo.
import subprocess, time, datetime, sys, json
from playwright.sync_api import sync_playwright
DOCS = '/home/claude/gj-leave/docs'; PORT = 8879
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1', '--directory', DOCS], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2); out = {}
try:
  with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True)
    ctx.route('**/*', lambda r: r.continue_() if '127.0.0.1' in r.request.url else r.abort())
    pg = ctx.new_page(); pg.set_default_timeout(8000); pg.clock.install(time=datetime.datetime(2026, 11, 20, 10, 0, tzinfo=IST))
    pg.goto('http://127.0.0.1:%d/index.html?demo=1' % PORT)
    pg.wait_for_selector('#who option', state='attached'); pg.select_option('#who', 'neha'); pg.fill('#pin', '1234'); pg.click('button:has-text("Sign in")')
    pg.wait_for_selector('button:has-text("Demo only"), h1:has-text("Hello,")')
    if pg.locator('text=Demo only: approve this phone').count(): pg.click('text=Demo only: approve this phone'); pg.click('button:has-text("Sign in")')
    pg.wait_for_selector('text=Hello,')
    tok = pg.evaluate("()=>JSON.stringify(Object.keys(localStorage))"); out['ls'] = tok
    # three own requests sent from this phone (through the app's own api)
    for d in ['2026-12-01', '2026-12-02', '2026-12-03']:
      out['send_' + d] = pg.evaluate("d=>GJApp.api('submitLeave',{kind:'full',dates:[d],reasonCode:'Personal work',reasonText:'Bank work'}).then(r=>r.status,e=>'ERR '+e.message)", d)
    pg.evaluate("()=>{[].slice.call(document.querySelectorAll('#tabs button')).filter(b=>b.firstChild.textContent==='Apply')[0].click()}"); pg.wait_for_timeout(600)
    pg.fill('input[type=date] >> nth=0', '2026-12-09'); pg.dispatch_event('input[type=date] >> nth=0', 'change')
    pg.select_option('select', 'Personal work'); pg.fill('textarea', 'Bank work'); pg.wait_for_timeout(1200)
    red = pg.locator('.warn.red')
    out['applyRed'] = red.count() and red.first.inner_text()
    out['applyRedBg'] = red.count() and red.first.evaluate("e=>getComputedStyle(e).backgroundColor")
    out['applyResult'] = pg.inner_text('.result')
    pg.screenshot(path='/tmp/r19ui/apply.png', full_page=True)
    b.close()
except Exception as e: out['error'] = str(e)[:400]
finally: srv.terminate()
print(json.dumps(out))
