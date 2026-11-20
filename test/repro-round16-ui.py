# Round 16 phone-app reproducers (python3 + Playwright, demo mode on 127.0.0.1 only, nothing outside is contacted).
# Prints one JSON object. Used by repro-round16.test.js; can be run alone: python3 repro-round16-ui.py
import subprocess, time, datetime, sys, json
try:
    from playwright.sync_api import sync_playwright
except Exception:
    print(json.dumps({'skip': 'playwright is not installed'})); sys.exit(0)
DOCS = '/home/claude/gj-leave/docs'
PORT = 8876
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1', '--directory', DOCS], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)
out = {}
ONLY = sys.argv[1:]

def page(p, w=390, h=700, poll=True, cam=False, locale=None):
    b = p.chromium.launch(args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] if cam else [])
    kw = dict(viewport={'width': w, 'height': h}, has_touch=True, is_mobile=True)
    if locale: kw['locale'] = locale
    if cam: kw['permissions'] = ['camera']
    ctx = b.new_context(**kw)
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
    if ONLY and name not in ONLY: return
    try:
        with sync_playwright() as p: fn(p)
    except Exception as e:
        out[name + '_error'] = str(e)[:400]
def L(d, text): return {'kind': 'full', 'dates': [d], 'reasonCode': 'Sick', 'reasonText': text}

# ---- UA: Approvals, two waiting cards with the SAME heading (one person, late arrival asked for two days); a new leave request arrives above them ----
def ua(p):
    b, pg, url = page(p)
    login(pg, url, 'aakash')
    out['UA_setup'] = [other(pg, 'bhawna', 'requestShort', {'kind': 'late', 'date': '2026-11-21', 'time': '10:30'}), other(pg, 'bhawna', 'requestShort', {'kind': 'late', 'date': '2026-11-23', 'time': '11:00'})]
    tab(pg, 'Approvals'); pg.wait_for_selector('button:has-text("Reject")')
    pos = pg.evaluate("()=>{var c=[].slice.call(document.querySelectorAll('.card')).filter(c=>/23 Nov/.test(c.textContent)&&/Bhawna/.test(c.textContent))[0];var bt=c.querySelector('button.good');bt.scrollIntoView({block:'center'});var r=bt.getBoundingClientRect();return [r.left+r.width/2, r.top+r.height/2]}")
    under = "([x,y])=>{var e=document.elementFromPoint(x,y);var c=e&&e.closest('.card');return (e?e.textContent:'')+' @ '+(c?c.querySelector('strong').textContent+' / '+c.querySelectorAll('p')[0].textContent:'')}"
    out['UA_before'] = pg.evaluate(under, pos)
    out['UA_new'] = other(pg, 'manish', 'submitLeave', L('2026-11-21', 'fever'))['ok']     # one more request comes in; its card is drawn above
    pg.clock.run_for(31000); pg.wait_for_timeout(400)
    out['UA_after'] = pg.evaluate(under, pos)
    b.close()
case('UA', ua)

# ---- UB: manager's Today; the shop board answers after more than 4 seconds ----
def ub(p):
    b, pg, url = page(p)
    login(pg, url, 'aakash')
    for x in ['neha', 'manish', 'bhawna']: other(pg, x, 'submitLeave', L('2026-11-21', 'fever'))
    pg.clock.run_for(31000); pg.wait_for_timeout(500)
    pg.evaluate("()=>window.scrollTo(0, document.documentElement.scrollHeight)"); pg.wait_for_timeout(200)
    out['UB_before'] = pg.evaluate("()=>window.scrollY")
    pg.evaluate("()=>{var o=GJMock.handle;GJMock.handle=function(b){var r=o(b);return new Promise(function(ok){setTimeout(function(){ok(r)}, b.action==='board'?5000:2300)})}}")
    pg.clock.run_for(30000); pg.wait_for_timeout(200)
    ys = []
    for i in range(10): pg.clock.run_for(1000); pg.wait_for_timeout(120); ys.append(pg.evaluate("()=>window.scrollY"))
    out['UB_ys'] = ys
    b.close()
case('UB', ub)

# ---- UC: the "sign-in was repeated at HH:MM" line on a phone set to another language ----
def uc(p):
    for loc in ['hi-IN', 'mr-IN', 'en-IN']:
        b, pg, url = page(p, poll=False, locale=loc)
        login(pg, url, 'varun')
        pg.evaluate("()=>{for(var i=0;i<2;i++)GJMock.handle({action:'login',args:{personId:'harsh',pin:'1234',deviceLabel:'Android phone, Chrome'},clientVersion:1})}")
        tab(pg, 'Approvals'); pg.wait_for_selector('text=New phone')
        out['UC_' + loc] = pg.inner_text('.card:has-text("New phone") .warn')
        b.close()
case('UC', uc)

# ---- UD: a check-in photo that could not be sent is offered again the next day, and to the next person on the phone ----
def ud(p):
    b, pg, url = page(p, cam=True)
    login(pg, url, 'vikas')
    pg.evaluate("()=>{window.__o=GJMock.handle;window.__sent=[];GJMock.handle=function(b){if(b.action==='checkIn'){window.__sent.push(b.args.photo.length+':'+b.args.photo.slice(-40));if(window.__down)throw new Error('offline')}return window.__o(b)};window.__down=true}")
    pg.click('button:has-text("Check in")'); pg.wait_for_selector('button:has-text("Take photo")')
    for i in range(20):
        pg.clock.run_for(500); pg.wait_for_timeout(150)
        if pg.evaluate("()=>{var b=[].slice.call(document.querySelectorAll('button')).filter(x=>x.textContent==='Take photo')[0];return b&&!b.disabled}"): break
    pg.click('button:has-text("Take photo")')
    for i in range(30):
        pg.clock.run_for(1000); pg.wait_for_timeout(150)
        if pg.locator('button:has-text("Send again")').count(): break
    out['UD_keptDay1'] = pg.locator('button:has-text("Send again")').count()
    pg.evaluate("()=>{window.__down=false}")
    # Aakash enters the check-in by hand (the phone "did not work")
    out['UD_manual'] = other(pg, 'aakash', 'manualCheckIn', {'personId': 'vikas', 'date': '2026-11-20', 'time': '10:00', 'reason': 'Phone had no network'})
    pg.clock.run_for(31000); pg.wait_for_timeout(400)
    out['UD_day1AfterManual'] = pg.locator('button:has-text("Send again")').count()
    # next morning, the app was never closed
    pg.clock.fast_forward(23 * 3600 * 1000 + 30 * 60 * 1000); pg.wait_for_timeout(300); pg.clock.run_for(31000); pg.wait_for_timeout(500)
    out['UD_day2Date'] = pg.inner_text('#app .sub')
    out['UD_day2Offer'] = pg.locator('button:has-text("Send again")').count()
    if out['UD_day2Offer']:
        pg.click('button:has-text("Send again")'); pg.clock.run_for(1500); pg.wait_for_timeout(500)
        out['UD_day2Screen'] = pg.inner_text('#app')[:300]
        out['UD_sent'] = pg.evaluate("()=>window.__sent")
        out['UD_day2Punch'] = pg.evaluate("()=>GJMock.data.Punches.filter(x=>x.personId==='vikas').map(x=>x.date+' '+x.kind+' '+(x.enteredBy||'photo'))")
    b.close()
    # second part: the next person who signs in on the same phone
    b, pg, url = page(p, cam=True, poll=False)
    login(pg, url, 'vikas')
    pg.evaluate("()=>{window.__o=GJMock.handle;GJMock.handle=function(b){if(b.action==='checkIn'&&window.__down)throw new Error('offline');return window.__o(b)};window.__down=true}")
    pg.click('button:has-text("Check in")'); pg.wait_for_selector('button:has-text("Take photo")')
    for i in range(20):
        pg.clock.run_for(500); pg.wait_for_timeout(150)
        if pg.evaluate("()=>{var b=[].slice.call(document.querySelectorAll('button')).filter(x=>x.textContent==='Take photo')[0];return b&&!b.disabled}"): break
    pg.click('button:has-text("Take photo")')
    for i in range(30):
        pg.clock.run_for(1000); pg.wait_for_timeout(150)
        if pg.locator('button:has-text("Send again")').count(): break
    pg.evaluate("()=>{window.__down=false}")
    tab(pg, 'More'); pg.click('button:has-text("Sign out")'); pg.wait_for_selector('#who option', state='attached')
    login(pg, url, 'harsh', goto=False)
    out['UD_otherPersonOffer'] = pg.locator('button:has-text("Send again")').count()
    if out['UD_otherPersonOffer']:
        pg.click('button:has-text("Send again")'); pg.clock.run_for(1500); pg.wait_for_timeout(500)
        out['UD_otherPunch'] = pg.evaluate("()=>GJMock.data.Punches.filter(x=>x.personId==='harsh').length")
    b.close()
case('UD', ud)

srv.terminate()
print(json.dumps(out, ensure_ascii=False))
