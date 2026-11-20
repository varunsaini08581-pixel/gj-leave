# Round 14 phone-app reproducers (python3 + Playwright, demo mode on 127.0.0.1 only, nothing outside is contacted).
# Prints one JSON object. Used by repro-round14.test.js; can be run alone: python3 repro-round14-ui.py
import subprocess, time, datetime, sys, json
try:
    from playwright.sync_api import sync_playwright
except Exception:
    print(json.dumps({'skip': 'playwright is not installed'})); sys.exit(0)
DOCS = '/home/claude/gj-leave/docs'
PORT = 8864
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1', '--directory', DOCS], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)
out = {}
SLOW = "()=>{var o=GJMock.handle;GJMock.handle=function(b){var r=o(b);return new Promise(function(ok){setTimeout(function(){ok(r)}, 2500)})}}"   # the real server answers in about 2.3 s (PROGRESS, 17:45)

def page(p, w=390, h=700, poll=True):
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
LEAVE = {'kind': 'full', 'dates': ['2026-11-21'], 'reasonCode': 'Sick', 'reasonText': 'fever'}

# ---- UA (M5): Aakash's Today (the shop board) is thrown back to the top by every 30-second refresh ----
def ua(p):
    b, pg, url = page(p)
    login(pg, url, 'aakash')
    for x in ['neha', 'manish', 'bhawna']: other(pg, x, 'submitLeave', LEAVE)      # some alerts, so the page is longer than the phone
    pg.clock.run_for(31000); pg.wait_for_timeout(500)
    pg.evaluate("()=>window.scrollTo(0, document.documentElement.scrollHeight)"); pg.wait_for_timeout(200)
    under = "()=>{var e=document.elementFromPoint(195,350);return e?(e.closest('li')||e).textContent.slice(0,40):''}"
    out['UA_before'] = pg.evaluate("()=>window.scrollY"); out['UA_underBefore'] = pg.evaluate(under)
    pg.clock.run_for(31000); pg.wait_for_timeout(500)
    out['UA_after'] = pg.evaluate("()=>window.scrollY"); out['UA_underAfter'] = pg.evaluate(under)
    b.close()
case('UA', ua)

# ---- UB (L3): a screen under More paints over the tab the person has moved to ----
def ub(p):
    b, pg, url = page(p, poll=False)
    login(pg, url, 'aakash')
    other(pg, 'vikas', 'submitLeave', {'kind': 'full', 'dates': ['2026-11-25'], 'reasonCode': 'Sick', 'reasonText': 'fever'})
    tab(pg, 'More'); pg.click('button:has-text("Staff leaves")'); pg.wait_for_selector('h1:has-text("Staff leaves")')
    pg.fill('input[placeholder^="Reason (required)"]', 'Shop needs him')
    pg.evaluate(SLOW)
    el = pg.locator('button.danger').first.element_handle()
    el.click(); pg.wait_for_timeout(150); el.click(); pg.wait_for_timeout(300)        # "Cancel this leave", tapped twice (it asks once more)
    tab(pg, 'Today')                                                                   # he does not wait for the answer
    for i in range(8): pg.clock.run_for(1500); pg.wait_for_timeout(250)
    out['UB_heading'] = pg.inner_text('#app h1'); out['UB_tab'] = pg.inner_text('#tabs button.on')
    b.close()
case('UB', ub)

# ---- UC (L4): the manager's card for the owner's new phone ----
def uc(p):
    b, pg, url = page(p, poll=False)
    login(pg, url, 'varun')                                                            # the owner's first phone
    tab(pg, 'More'); pg.click('button:has-text("Sign out")'); pg.wait_for_selector('#who option', state='attached'); login(pg, url, 'aakash', goto=False)
    pg.evaluate("()=>GJMock.handle({action:'login',args:{personId:'varun',pin:'1234',deviceLabel:'Android phone, Chrome'},clientVersion:1})")   # the owner on a new phone
    tab(pg, 'Approvals'); pg.wait_for_selector('text=New phone')
    out['UC_card'] = pg.inner_text('.card:has-text("New phone")')
    out['UC_hasReject'] = pg.locator('.card:has-text("New phone") button:has-text("Reject")').count()
    if out['UC_hasReject']:
        pg.click('.card:has-text("New phone") button:has-text("Reject")'); pg.wait_for_timeout(500)
        out['UC_rejectToast'] = pg.inner_text('#toast')
    b.close()
case('UC', uc)

# ---- UD (L5): the 30-second refresh fails once (no network for a moment) ----
def ud(p):
    b, pg, url = page(p)
    login(pg, url, 'vikas')
    pg.evaluate("()=>{GJMock.handle=function(){throw new Error('offline')}}")
    pg.clock.run_for(31000); pg.wait_for_timeout(400)
    out['UD_screen'] = pg.inner_text('#app')[:200]; out['UD_buttons'] = pg.locator('#app button').count()
    b.close()
case('UD', ud)

# ---- UE (L7): a new request arrives; the card under the finger on Approvals is another one after the refresh ----
def ue(p):
    b, pg, url = page(p)
    login(pg, url, 'aakash')
    for x in ['vikas', 'raunak']: other(pg, x, 'submitLeave', LEAVE)
    PH = {'photo': 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEB', 'thumb': 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEB'}
    other(pg, 'neha', 'checkIn', PH); other(pg, 'neha', 'goingOut', {'reason': 'Bank', 'expectedMinutes': 30})
    other(pg, 'bhawna', 'checkIn', PH); other(pg, 'bhawna', 'requestShort', {'kind': 'early', 'time': '18:00'})
    tab(pg, 'Approvals'); pg.wait_for_selector('button:has-text("Reject")')
    pos = pg.evaluate("()=>{var c=[].slice.call(document.querySelectorAll('.card')).filter(c=>/Neha/.test(c.textContent)&&/Going out/.test(c.textContent))[0];var bt=c.querySelector('button.good');bt.scrollIntoView({block:'center'});var r=bt.getBoundingClientRect();return [r.left+r.width/2, r.top+r.height/2]}")
    under = "([x,y])=>{var e=document.elementFromPoint(x,y);var c=e&&e.closest('.card');return (e?e.textContent:'')+' @ '+(c?c.querySelector('strong').textContent:'')}"
    out['UE_before'] = pg.evaluate(under, pos)
    other(pg, 'manish', 'submitLeave', LEAVE)                                         # one more request comes in
    pg.clock.run_for(31000); pg.wait_for_timeout(400)
    out['UE_after'] = pg.evaluate(under, pos)
    b.close()
case('UE', ue)

# ---- UF (L9): Grace table: a number above 31 ----
def uf(p):
    b, pg, url = page(p, poll=False)
    login(pg, url, 'varun')
    tab(pg, 'More'); pg.click('button:has-text("Grace table")'); pg.wait_for_selector('h1:has-text("Grace table")')
    pg.click('button:has-text("Save grace table")'); pg.wait_for_timeout(500); out['UF_plainSave'] = pg.inner_text('#toast')
    pg.locator('input[type=number]').nth(6).fill('40'); pg.click('button:has-text("Save grace table")'); pg.wait_for_timeout(500)
    out['UF_toast'] = pg.inner_text('#toast'); out['UF_max'] = pg.locator('input[type=number]').nth(6).get_attribute('max')
    b.close()
case('UF', uf)

srv.terminate()
print(json.dumps(out))
