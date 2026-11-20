# Round 12 phone-app reproducers (python3 + Playwright, demo mode on 127.0.0.1 only, nothing outside is contacted).
# Prints one JSON object. Used by repro-round12.test.js; can be run alone: python3 repro-round12-ui.py
import subprocess, time, datetime, sys, json
try:
    from playwright.sync_api import sync_playwright
except Exception:
    print(json.dumps({'skip': 'playwright is not installed'})); sys.exit(0)
DOCS = '/home/claude/gj-leave/docs'
PORT = 8842
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1', '--directory', DOCS], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)
out = {}
SLOW = "()=>{var o=GJMock.handle;GJMock.handle=function(b){var r=o(b);return new Promise(function(ok){setTimeout(function(){ok(r)}, 2500)})}}"   # the real server answers a screen in about 2.3 s (PROGRESS, 17:45)

def page(p, w=390, h=844, poll=True):
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': w, 'height': h}, has_touch=True, is_mobile=True)
    ctx.route('**/*', lambda r: r.continue_() if '127.0.0.1' in r.request.url else r.abort())
    pg = ctx.new_page(); pg.set_default_timeout(8000)
    pg.clock.install(time=datetime.datetime(2026, 11, 20, 10, 0, tzinfo=IST))
    return b, pg, 'http://127.0.0.1:%d/index.html?demo=1%s' % (PORT, '&poll=1' if poll else '')
def login(pg, url, who, goto=True):
    if goto: pg.goto(url)
    pg.wait_for_selector('#who option', state='attached')
    pg.select_option('#who', who); pg.fill('#pin', '1234'); pg.click('button:has-text("Sign in")')
    pg.wait_for_selector('button:has-text("Demo only"), h1:has-text("Hello,")')
    if pg.locator('text=Demo only: approve this phone').count():
        pg.click('text=Demo only: approve this phone'); pg.click('button:has-text("Sign in")')
    pg.wait_for_selector('text=Hello,')
def tab(pg, name):
    pg.evaluate("n=>{[].slice.call(document.querySelectorAll('#tabs button')).filter(b=>b.firstChild.textContent===n)[0].click()}", name); pg.wait_for_timeout(400)
def other(pg, who, action, args=None):
    # another person, on another (approved) phone
    return pg.evaluate("""([who,a,b])=>{var r=GJMock.handle({action:'login',args:{personId:who,pin:'1234',deviceToken:window['__t_'+who]||null,deviceLabel:'other phone'},clientVersion:1});
      if(r.data&&r.data.deviceToken) window['__t_'+who]=r.data.deviceToken; GJMock.approveDevices();
      return GJMock.handle({action:a,args:b||{},clientVersion:1,personId:who,deviceToken:window['__t_'+who]})}""", [who, action, args or {}])
def case(name, fn):
    try:
        with sync_playwright() as p: fn(p)
    except Exception as e:
        out[name + '_error'] = str(e)[:300]

# ---- UA: the owner signs in as a staff member on his own phone, then as himself again ----
def ua(p):
    b, pg, url = page(p, poll=False)
    login(pg, url, 'varun')                                   # the owner's first phone: approved by the bootstrap rule
    tab(pg, 'More'); pg.click('button:has-text("Sign out")'); pg.wait_for_selector('#who option', state='attached')
    pg.select_option('#who', 'neha'); pg.fill('#pin', '1234'); pg.click('button:has-text("Sign in")'); pg.wait_for_timeout(600)   # he knows the PIN: he made it
    pg.select_option('#who', 'varun'); pg.fill('#pin', '1234'); pg.click('button:has-text("Sign in")'); pg.wait_for_timeout(800)
    out['UA_screen'] = pg.inner_text('#app')[-130:]
    out['UA_signedIn'] = pg.locator('h1:has-text("Hello, Varun")').count() == 1
    out['UA_ownerDevices'] = pg.evaluate("()=>GJMock.data.Devices.filter(d=>d.personId==='varun').map(d=>d.status)")
    b.close()
case('UA', ua)

# ---- UB: the 30-second refresh is already on its way when the person starts to type ----
def ub(p):
    b, pg, url = page(p)
    login(pg, url, 'vikas')
    pg.evaluate(SLOW)
    card = '.card:has-text("Late or leaving early")'
    pg.clock.run_for(30000)                                   # the refresh starts (nothing typed yet); its answer comes 2.5 s later
    pg.fill(card + ' input[type=time]', '11:40')              # typed inside those 2.5 s
    pg.clock.run_for(3000); pg.wait_for_timeout(300)
    out['UB_staffTime'] = pg.input_value(card + ' input[type=time]')
    b.close()
    b, pg, url = page(p)
    login(pg, url, 'aakash')
    other(pg, 'vikas', 'submitLeave', {'kind': 'full', 'dates': ['2026-11-21'], 'reasonCode': 'Sick', 'reasonText': 'fever'})
    tab(pg, 'Approvals'); pg.wait_for_selector('button:has-text("Reject")')
    pg.evaluate(SLOW)
    pg.clock.run_for(30000)
    pg.fill('input[placeholder^="Reason (required to reject)"]', 'Two people are already away')
    pg.clock.run_for(3000); pg.wait_for_timeout(300)
    out['UB_rejectReason'] = pg.input_value('input[placeholder^="Reason (required to reject)"]')
    b.close()
case('UB', ub)

# ---- UC: every refresh throws the screen back to the top ----
def uc(p):
    b, pg, url = page(p)
    login(pg, url, 'aakash')
    for who in ['vikas', 'neha', 'raunak', 'bhawna', 'harsh', 'manish']:
        other(pg, who, 'submitLeave', {'kind': 'full', 'dates': ['2026-11-21'], 'reasonCode': 'Sick', 'reasonText': 'fever'})
    tab(pg, 'Approvals'); pg.wait_for_selector('button:has-text("Reject")')
    pg.evaluate("()=>window.scrollTo(0, 900)"); pg.wait_for_timeout(200)
    under = "()=>{var e=document.elementFromPoint(195,500);var c=e&&e.closest('.card');return c?c.querySelector('strong').textContent:''}"
    out['UC_scrollBefore'] = pg.evaluate("()=>window.scrollY"); out['UC_cardBefore'] = pg.evaluate(under)
    pg.clock.run_for(31000); pg.wait_for_timeout(400)
    out['UC_scrollAfter'] = pg.evaluate("()=>window.scrollY"); out['UC_cardAfter'] = pg.evaluate(under)
    b.close()
case('UC', uc)

# ---- UD: "I will leave early" falls back to "I will be late" ----
def ud(p):
    b, pg, url = page(p)
    login(pg, url, 'vikas')
    card = '.card:has-text("Late or leaving early")'
    pg.click('button:has-text("I will leave early")')
    pg.clock.run_for(31000); pg.wait_for_timeout(400)
    out['UD_kind'] = pg.inner_text(card + ' .seg button.on')
    b.close()
case('UD', ud)

# ---- UE: one long word in a reason makes Approvals wider than the phone ----
def ue(p):
    b, pg, url = page(p, poll=False)
    login(pg, url, 'aakash')
    other(pg, 'vikas', 'submitLeave', {'kind': 'full', 'dates': ['2026-11-21'], 'reasonCode': 'Other', 'reasonText': 'https://example.test/' + 'a' * 150})   # 171 characters, the form allows 200
    tab(pg, 'Approvals'); pg.wait_for_selector('button:has-text("Reject")')
    out['UE_pageWidth'] = pg.evaluate("()=>document.documentElement.scrollWidth"); out['UE_phoneWidth'] = 390
    out['UE_moreTabRight'] = pg.evaluate("()=>Math.round([].slice.call(document.querySelectorAll('#tabs button')).pop().getBoundingClientRect().right)")
    b.close()
case('UE', ue)

# ---- UF: 320 px wide phone, a request that needs Aakash + Varun ----
def uf(p):
    b, pg, url = page(p, w=320, h=640, poll=False)
    login(pg, url, 'aakash')
    other(pg, 'raunak', 'submitLeave', {'kind': 'full', 'dates': ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05'], 'reasonCode': 'Family function', 'reasonText': 'Wedding'})
    tab(pg, 'Approvals'); pg.wait_for_selector('button:has-text("Reject")')
    out['UF_status'] = pg.inner_text('.chip.violet')
    out['UF_pageWidth'] = pg.evaluate("()=>document.documentElement.scrollWidth")
    b.close()
case('UF', uf)

# ---- UG: "Sign out" with no network: the phone looks signed out, the server was never told ----
def ug(p):
    b, pg, url = page(p, poll=False)
    login(pg, url, 'neha')
    tok = pg.evaluate("()=>GJApp.state.session.deviceToken")
    pg.evaluate("()=>{window.__real=GJMock.handle;GJMock.handle=function(){throw new Error('offline')}}")     # no connection
    tab(pg, 'More'); pg.click('button:has-text("Sign out")'); pg.wait_for_timeout(600)
    out['UG_loginScreenShown'] = pg.locator('#pin').count() == 1
    out['UG_messageShown'] = pg.inner_text('#app')[-200:] + ' | toast: ' + (pg.inner_text('#toast') if pg.locator('#toast:visible').count() else '')
    r = pg.evaluate("t=>window.__real({action:'me',args:{},clientVersion:1,personId:'neha',deviceToken:t})", tok)   # the token alone, no PIN
    out['UG_tokenStillOpens'] = bool(r.get('ok'))
    b.close()
case('UG', ug)

srv.terminate()
print(json.dumps(out))
