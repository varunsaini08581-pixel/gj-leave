# Round 18 phone-app reproducers (python3 + Playwright, demo mode on 127.0.0.1 only, nothing outside is contacted).
# Prints one JSON object. Used by repro-round18.test.js; can be run alone: python3 repro-round18-ui.py [U1 U2 U3 U4]
# Nothing inside /home/claude/gj-leave is written (the docs folder is only served).
import subprocess, time, datetime, sys, json
try:
    from playwright.sync_api import sync_playwright
except Exception:
    print(json.dumps({'skip': 'playwright is not installed'})); sys.exit(0)
DOCS = '/home/claude/gj-leave/docs'
PORT = 8878
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1', '--directory', DOCS], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)
out = {}
ONLY = sys.argv[1:]

def page(p, w=390, h=700, poll=True, when=(2026, 11, 20, 10, 0)):
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': w, 'height': h}, has_touch=True, is_mobile=True)
    ctx.route('**/*', lambda r: r.continue_() if '127.0.0.1' in r.request.url else r.abort())
    pg = ctx.new_page(); pg.set_default_timeout(8000)
    pg.clock.install(time=datetime.datetime(*when, tzinfo=IST))
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
    if ONLY and name not in ONLY: return
    try:
        with sync_playwright() as p: fn(p)
    except Exception as e:
        out[name + '_error'] = str(e)[:400]

# ---- U1: month report of a locked month whose rows were damaged by hand (the store reads an unreadable JSON cell as empty) ----
def u1(p):
    b, pg, url = page(p, poll=False, when=(2026, 12, 2, 10, 0))
    login(pg, url, 'varun')
    l1 = other(pg, 'aakash', 'lockMonth', {'month': '2026-11'}); l2 = other(pg, 'varun', 'lockMonth', {'month': '2026-11'})
    if not (l1.get('ok') and l2.get('ok') and l2['data'].get('locked')): raise Exception('set-up: November was not locked: %s %s' % (l1, l2))
    # U1a: Harsh's locked result is damaged
    pg.evaluate("()=>{var r=GJMock.data.MonthSheet.filter(r=>r.personId==='harsh')[0];window.__keep=r.result;r.result=null}")
    out['U1_serverDamaged'] = other(pg, 'varun', 'monthReport', {'month': '2026-11'})['data'].get('damaged')
    tab(pg, 'More'); pg.click('button:text-is("Month report")'); pg.wait_for_selector('text=Dec 2026')
    pg.click('button:has-text("‹ Nov 2026")'); pg.wait_for_timeout(600)
    out['U1_screen'] = pg.inner_text('#app')
    # U1b: Harsh's row is whole again; a correction row is damaged
    pg.evaluate("()=>{GJMock.data.MonthSheet.filter(r=>r.personId==='harsh')[0].result=window.__keep}")
    c = other(pg, 'varun', 'addCorrection', {'month': '2026-11', 'personId': 'neha', 'note': 'One leave less'})
    if not c.get('ok'): raise Exception('set-up: correction not added: %s' % c)
    pg.evaluate("()=>{GJMock.data.MonthSheet.filter(r=>r.personId==='correction')[0].result=null}")
    tab(pg, 'More'); pg.click('button:text-is("Month report")'); pg.wait_for_selector('text=Dec 2026')
    out['U1b_before'] = pg.inner_text('#app .sub')
    pg.click('button:has-text("‹ Nov 2026")'); pg.wait_for_timeout(1500)
    out['U1b_after'] = pg.inner_text('#app')[:160]
    b.close()
case('U1', u1)

# ---- U2: Approvals, scrolled down; the other approver decides everything; automatic refresh ----
def u2(p):
    b, pg, url = page(p)
    login(pg, url, 'aakash')
    ids = []
    for x in ['neha', 'manish', 'bhawna', 'raunak', 'vikas', 'pooja']:
        r = other(pg, x, 'requestShort', {'kind': 'late', 'date': '2026-11-23', 'time': '11:30'})
        if not r.get('ok'): raise Exception('set-up: request refused: %s' % r)
        ids.append(r['data']['id'])
    tab(pg, 'Approvals'); pg.wait_for_selector('button:has-text("Reject")')
    pg.evaluate("()=>window.scrollTo(0, document.documentElement.scrollHeight)"); pg.wait_for_timeout(200)
    out['U2_before'] = pg.evaluate("()=>({y:window.scrollY, cards:document.querySelectorAll('#app .card').length})")
    for i in ids:
        r = other(pg, 'varun', 'decideShort', {'id': i, 'approve': False, 'reason': 'Not this week'})   # Varun, on his own phone
        if not r.get('ok'): raise Exception('set-up: decision refused: %s' % r)
    pg.clock.run_for(31000); pg.wait_for_timeout(500)                                                    # the 30-second refresh
    look = "()=>{var c=[].slice.call(document.querySelectorAll('#app > *')).filter(e=>{var r=e.getBoundingClientRect();return r.height>0&&r.bottom>0&&r.top<window.innerHeight});return {y:window.scrollY,min:document.getElementById('app').style.minHeight,visible:c.map(e=>e.textContent.slice(0,40)),cards:document.querySelectorAll('#app .card').length}}"
    out['U2_after'] = pg.evaluate(look)
    pg.clock.run_for(15000); pg.wait_for_timeout(300); out['U2_after15s'] = pg.evaluate(look)
    pg.clock.run_for(6000); pg.wait_for_timeout(300); out['U2_after21s'] = pg.evaluate(look)
    b.close()
case('U2', u2)

# ---- U3: the answer to the automatic refresh comes late, after the answer to the person's own action ----
def u3(p):
    b, pg, url = page(p)
    login(pg, url, 'neha')
    # the two calls of the automatic refresh take 5 s (a slow moment of the server); everything after the request is quick
    pg.evaluate("()=>{var o=GJMock.handle,slow=true;GJMock.handle=function(b){var r=o(b);var d=(slow&&(b.action==='today'||b.action==='notifications'))?5000:150;if(b.action==='requestShort')slow=false;return new Promise(function(ok){setTimeout(function(){ok(r)},d)})}}")
    pg.clock.run_for(30000); pg.wait_for_timeout(200)                     # automatic refresh starts
    pg.click('button:has-text("I will leave early")')
    pg.fill('input[type=time]', '18:00'); pg.dispatch_event('input[type=time]', 'change')
    pg.click('.card:has-text("Late or leaving early") button:has-text("Ask Aakash")')
    for i in range(8): pg.clock.run_for(1000); pg.wait_for_timeout(120)
    out['U3_card'] = pg.inner_text('.card:has-text("Late or leaving early")')[:300]
    out['U3_server'] = pg.evaluate("()=>GJMock.data.ShortRequests.map(q=>q.personId+' '+q.kind+' '+q.time+' '+q.status)")
    b.close()
case('U3', u3)

# ---- U4: the phone is signed in; the app is opened again while the first call ("me") fails as with no connection ----
def u4(p):
    b, pg, url = page(p, poll=False)
    # From the second load on, every call fails the way a dead connection does (docs/app.js turns it into code NET).
    pg.add_init_script("if(sessionStorage.getItem('r18down')){(function(){var m;Object.defineProperty(window,'GJMock',{configurable:true,get:function(){return m},set:function(v){m=v;v.handle=function(){throw new Error('offline')}}})})()}")
    login(pg, url, 'harsh')
    out['U4_first'] = pg.inner_text('#app h1')
    out['U4_token'] = pg.evaluate("()=>!!JSON.parse(localStorage.getItem('gjleave.demo')).deviceToken")
    pg.evaluate("()=>sessionStorage.setItem('r18down','1')")
    pg.reload(); pg.wait_for_timeout(1500)
    out['U4_screen'] = pg.inner_text('#app')[:300]
    out['U4_pinField'] = pg.locator('#pin').count()
    out['U4_tryAgain'] = pg.locator('button:has-text("Try again")').count()
    b.close()
case('U4', u4)

srv.terminate()
print(json.dumps(out, ensure_ascii=False))
