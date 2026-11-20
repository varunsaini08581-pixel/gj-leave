#!/usr/bin/env python3
"""
Round 5 (phone UI and usability) reproducers for GJ Leave & Attendance.

Run:  python3 repro-round5.py [path-to-docs] [--shots]
      default docs path: docs
Every check states the behaviour a phone user needs and FAILS on the code as reviewed.
Only 127.0.0.1 is contacted; every other request is blocked. Demo mode (?demo=1), every PIN 1234.
Exit code = number of failed checks.
"""
import sys, os, subprocess, time, json, datetime
from playwright.sync_api import sync_playwright

ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
DOCS = ARGS[0] if ARGS else 'docs'
SHOTS = '--shots' in sys.argv
SHOT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shots5')
PORT = 8795
BASE = 'http://127.0.0.1:%d/index.html' % PORT
URL = BASE + '?demo=1'
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))


def ist(h, m, day=20):
    return datetime.datetime(2026, 11, day, h, m, tzinfo=IST)   # Friday 20 Nov 2026


class Phone:
    def __init__(self, p, w=360, h=740, at=None, geo=True):
        self.w = w
        self.b = p.chromium.launch(args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'])
        kw = dict(viewport={'width': w, 'height': h}, device_scale_factor=1, has_touch=True, is_mobile=True)
        if geo:
            kw.update(geolocation={'latitude': 29.1492, 'longitude': 75.7217}, permissions=['geolocation'])
        self.ctx = self.b.new_context(**kw)
        self.ctx.route('**/*', lambda r: r.continue_() if '127.0.0.1' in r.request.url else r.abort())
        self.pg = self.ctx.new_page()
        self.pg.set_default_timeout(8000)
        if at:
            self.pg.clock.install(time=at)

    def open(self):
        self.pg.goto(URL)
        self.pg.wait_for_selector('#who option', state='attached')

    def login(self, who):
        pg = self.pg
        pg.select_option('#who', who); pg.fill('#pin', '1234'); pg.click('button:has-text("Sign in")')
        pg.wait_for_selector('button:has-text("Demo only"), h1:has-text("Hello,")')
        if pg.locator('text=Demo only: approve this phone').count():
            pg.click('text=Demo only: approve this phone'); pg.click('button:has-text("Sign in")')
        pg.wait_for_selector('text=Hello,')

    def tab(self, name):
        self.pg.evaluate("n=>{[].slice.call(document.querySelectorAll('#tabs button')).filter(b=>b.firstChild.textContent===n)[0].click()}", name)
        self.pg.wait_for_timeout(350)

    def menu(self, label):
        self.tab('More'); self.pg.click('button:has-text("%s")' % label); self.pg.wait_for_timeout(450)

    def text(self):
        return self.pg.inner_text('#app')

    def toast(self):
        return self.pg.evaluate("()=>{var t=document.getElementById('toast');return t.hidden?'':t.textContent}")

    def call(self, action, args=None):
        """Call the in-page demo server as the signed-in person."""
        return self.pg.evaluate("([a,b])=>{var s=GJApp.state.session;return GJMock.handle({action:a,args:b||{},clientVersion:GJ_CONFIG.CLIENT_VERSION,personId:s.personId,deviceToken:s.deviceToken})}", [action, args or {}])

    def as_other(self, who, action, args=None):
        """Call the in-page demo server as another person (stands in for that person's own phone)."""
        return self.pg.evaluate("""([who,a,b])=>{var r=GJMock.handle({action:'login',args:{personId:who,pin:'1234',deviceToken:window['__t_'+who]||null,deviceLabel:'other phone'},clientVersion:GJ_CONFIG.CLIENT_VERSION});
          if(r.data&&r.data.deviceToken) window['__t_'+who]=r.data.deviceToken; GJMock.approveDevices();
          return GJMock.handle({action:a,args:b||{},clientVersion:GJ_CONFIG.CLIENT_VERSION,personId:who,deviceToken:window['__t_'+who]})}""", [who, action, args or {}])

    def check_in(self):
        pg = self.pg
        pg.click('button:has-text("Check in")'); pg.click('button:has-text("Take photo"):not([disabled])')
        pg.wait_for_selector('button:has-text("Check out")', timeout=25000)

    def shot(self, name, full=False):
        if SHOTS:
            os.makedirs(SHOT_DIR, exist_ok=True)
            self.pg.screenshot(path=os.path.join(SHOT_DIR, name + '.png'), full_page=full)

    def close(self):
        self.b.close()


class Fail(Exception):
    pass


def need(cond, why):
    if not cond:
        raise Fail(why)


CHECKS = []


def check(cid, severity, title):
    def deco(fn):
        CHECKS.append((cid, severity, title, fn)); return fn
    return deco


# ---------------------------------------------------------------- HIGH

@check('R5-01', 'High', 'One accidental tap on "Check out" must not end the day and create a violation')
def _(p):
    s = Phone(p, at=ist(9, 26)); pg = s.pg
    try:
        s.open(); s.login('neha'); s.check_in()                     # Neha, duty 09:30-18:30, in at 09:26
        dialogs = []
        pg.on('dialog', lambda d: (dialogs.append(d.message), d.dismiss()))
        pg.click('button:has-text("Check out")'); pg.wait_for_timeout(600)   # a single tap, four minutes before duty even starts
        s.shot('01-checkout-one-tap')
        t = s.call('today')['data']; m = s.call('myMonth', {'month': '2026-11'})['data']
        undo = s.as_other('aakash', 'manualCheckOut', {'personId': 'neha', 'date': '2026-11-20', 'time': '18:30', 'reason': 'tapped by mistake'})
        need(t['checkOut'] is None,
             'a single tap checked Neha out at once (no confirmation step, dialogs=%r); it recorded violations %r and %s leave day; Aakash cannot correct it: %r'
             % (dialogs, [v['rule'] for v in m['violations']], m['leaves']['taken'], undo.get('message')))
    finally:
        s.close()


@check('R5-02', 'Low', 'An old cached app must show a lasting "update" message, and never reload for ever (the loop was High until 18:29 IST)')
def _(p):
    s = Phone(p); pg = s.pg
    try:
        # Real (non-demo) mode. The server call is answered locally with what the server sends to an old copy of the app.
        s.ctx.unroute('**/*')
        def route(r):
            u = r.request.url
            if '127.0.0.1' in u: return r.continue_()
            if 'script.google.com' in u: return r.fulfill(body=json.dumps({'ok': False, 'code': 'UPDATE', 'message': 'Please update the app.'}), content_type='application/json')
            return r.abort()
        s.ctx.route('**/*', route)
        n = [0]
        pg.on('framenavigated', lambda f: n.__setitem__(0, n[0] + 1))
        try:
            pg.goto(BASE, wait_until='commit')
        except Exception:
            pass
        pg.wait_for_timeout(4000)
        need(n[0] <= 3, 'the page reloaded %d times in 4 seconds (api() calls location.reload() on every UPDATE answer); the user never sees a message and each loop calls the server again' % n[0])
        seen = (pg.inner_text('body') + ' ' + s.toast()).lower()
        pg.wait_for_timeout(7000)                                    # the toast lasts 6 s
        later = pg.inner_text('body').lower()
        need(('old' in seen or 'update' in seen) and ('old' in later or 'update' in later),
             'no reload loop, but the "old copy" message is only a 6-second toast; after it the sign-in screen stays with an empty name list and no explanation: %r' % pg.inner_text('#app')[:120])
    finally:
        s.close()


# ---------------------------------------------------------------- MEDIUM

@check('R5-03', 'Medium', 'A slow answer for one tab must not replace the screen of the tab opened after it')
def _(p):
    s = Phone(p, at=ist(11, 5)); pg = s.pg
    try:
        s.open(); s.login('neha')
        # The real server answers in 2-3 s (PROGRESS.md). Give "today" 2.5 s and everything else 0.3 s.
        pg.evaluate("()=>{var o=GJMock.handle;GJMock.handle=function(b){var r=o(b);return new Promise(function(ok){setTimeout(function(){ok(r)}, b.action==='today'?2500:300)})}}")
        pg.clock.resume()
        s.tab('Today'); pg.wait_for_timeout(200); s.tab('Apply'); pg.wait_for_timeout(900)
        need('Apply for leave' in s.text(), 'setup: Apply did not open')
        pg.fill('textarea', 'Half typed reason'); pg.wait_for_timeout(2600)
        s.shot('03-tab-race')
        need('Apply for leave' in s.text() and pg.locator('textarea').count() == 1,
             'the late "Today" answer replaced the Apply form: screen now starts with %r while the highlighted tab is %r; the typed reason is gone'
             % (s.text()[:25], pg.inner_text('#tabs button.on')))
    finally:
        s.close()


@check('R5-04', 'Medium', 'When a screen cannot load it must say so and offer a retry, not stay on "Loading…"')
def _(p):
    s = Phone(p, at=ist(11, 5)); pg = s.pg
    try:
        s.open(); s.login('aakash')
        pg.evaluate("()=>{var o=GJMock.handle;GJMock.handle=function(b){return {ok:false,code:'ERROR',message:'Something went wrong. Please try again.'}}}")
        stuck = []
        for name in ['My month', 'Approvals']:
            s.tab(name); pg.clock.run_for(8000); pg.wait_for_timeout(200)      # the red toast is gone after 6 s
            if s.text().strip() == 'Loading…' and s.toast() == '':
                stuck.append(name)
        s.tab('More'); pg.click('button:has-text("Calendar")'); pg.clock.run_for(8000); pg.wait_for_timeout(200)
        if s.text().strip() == 'Loading…':
            stuck.append('More > Calendar (also: no Back button)')
        s.shot('04-stuck-loading')
        need(not stuck, 'after a failed call these screens show only "Loading…" for ever, with no message and no retry: ' + ', '.join(stuck))
    finally:
        s.close()


@check('R5-05', 'Medium', 'The sign-in screen must not print the word "null"')
def _(p):
    s = Phone(p); pg = s.pg
    try:
        s.open(); demo = s.text()
        # Real (non-demo) mode: answer the names call locally, nothing leaves the machine.
        s.ctx.unroute('**/*')
        def route(r):
            u = r.request.url
            if '127.0.0.1' in u: return r.continue_()
            if 'script.google.com' in u: return r.fulfill(body=json.dumps({'ok': True, 'data': [{'id': 'neha', 'name': 'Neha'}]}), content_type='application/json')
            return r.abort()
        s.ctx.route('**/*', route)
        pg.goto(BASE); pg.wait_for_selector('#who option', state='attached'); real = s.text()
        s.shot('05-login-null')
        need('null' not in demo and 'null' not in real,
             'show() passes null to replaceChildren, which prints it: demo sign-in shows "null", the real sign-in screen shows %r above "Your name"'
             % [l for l in real.split('\n') if 'null' in l])
    finally:
        s.close()


@check('R5-06', 'Medium', 'A late / early request for another day must stay visible to the person who sent it')
def _(p):
    s = Phone(p, at=ist(9, 0)); pg = s.pg
    try:
        s.open(); s.login('neha')
        c = '.card:has-text("Late or leaving early")'
        pg.fill(c + ' input[type=date]', '2026-11-21'); pg.fill(c + ' input[type=time]', '10:00'); pg.dispatch_event(c + ' input[type=time]', 'change')
        pg.click(c + ' button:has-text("Ask Aakash")'); pg.wait_for_timeout(600)
        seen = []
        for name in ['Today', 'Apply', 'My month']:
            s.tab(name); pg.wait_for_timeout(500)
            if '10:00' in s.text(): seen.append(name)
        s.tab('More'); pg.click('button:has-text("Notifications")'); pg.wait_for_timeout(400)
        if '10:00' in s.text(): seen.append('Notifications')
        need(seen, 'the request for 21 Nov, arriving 10:00, was accepted ("Sent to Aakash") and is then shown on no screen of the sender (Today lists only today\'s requests); there is also no way to cancel a late / early request')
    finally:
        s.close()


@check('R5-07', 'Medium', '"My month" and "Open <name>\'s month" must be able to show a month other than the current one')
def _(p):
    s = Phone(p, at=ist(11, 5)); pg = s.pg
    try:
        s.open(); s.login('aakash')
        s.menu('Month report'); pg.click('button:has-text("Oct 2026")'); pg.wait_for_timeout(500)
        need('Oct 2026' in s.text(), 'setup: October report did not open')
        pg.click('button:has-text("Open Neha")'); pg.wait_for_timeout(500)
        opened = s.text()[:40].replace('\n', ' ')
        s.tab('My month'); pg.wait_for_timeout(400)
        nav = pg.locator('#app button').count()
        need('Oct 2026' in opened and nav > 0,
             'from the October report, "Open Neha\'s month" shows %r (the current month); and "My month" has %d controls to change the month, so nobody can open last month (for example on 1 Dec, to read or dispute a violation recorded on 30 Nov)' % (opened, nav))
    finally:
        s.close()


@check('R5-08', 'Medium', 'An old unannounced absence must not sit in Approvals as "waiting" for ever')
def _(p):
    s = Phone(p, at=ist(11, 5)); pg = s.pg
    try:
        s.open(); s.login('aakash')
        # An absence the end-of-day job recorded 46 days ago, which Aakash chose not to excuse.
        pg.evaluate("()=>{GJMock.data.LeaveRequests.push({id:'old1',personId:'harsh',kind:'full',dates:['2026-10-05'],status:'Absent \\u2013 unannounced',type:'Unannounced',reasonCode:'',reasonText:'',submittedAt:Date.now()-46*86400000,history:[],approvals:{}})}")
        s.tab('Approvals'); pg.wait_for_timeout(400)
        txt = s.text(); badge = pg.locator('#tabs .dot').count()
        need('1 waiting' not in txt and badge == 0,
             'Approvals says "1 waiting" and the tab shows a red badge for an absence of 5 Oct; the only button is "Humanitarian – excused", so an absence that is NOT excused can never be cleared and the badge never returns to zero')
    finally:
        s.close()


@check('R5-09', 'Medium', 'The phone\'s Back button must go one screen back inside the app, not leave it')
def _(p):
    s = Phone(p, at=ist(11, 5)); pg = s.pg
    try:
        pg.goto('about:blank'); s.open(); s.login('neha')
        s.tab('Apply'); pg.fill('textarea', 'My reason'); s.tab('More'); pg.click('button:has-text("Today at GJ")'); pg.wait_for_timeout(300)
        pg.go_back(); pg.wait_for_timeout(500)                     # Android Back / iPhone back swipe
        need('127.0.0.1' in pg.url, 'no screen is put into the browser history, so Back left the app (now at %r); in the installed app this closes it, from any screen, including a half-filled form' % pg.url)
    finally:
        s.close()


@check('R5-10', 'Medium', 'A staff member waiting on "Pending with Aakash" must see the approval without having to tap again')
def _(p):
    s = Phone(p, at=ist(11, 5)); pg = s.pg
    try:
        s.open(); s.login('vikas'); s.check_in()
        oid = s.call('goingOut', {'reason': 'Bank', 'expectedMinutes': 20})['data']['id']
        s.tab('Today'); pg.wait_for_timeout(400)
        need('Pending with Aakash' in pg.inner_text('.card:has-text("Going out")'), 'setup: outing not pending')
        s.as_other('aakash', 'decideOuting', {'id': oid, 'approve': True})
        pg.evaluate("()=>{document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'))}")   # phone unlocked / app brought back
        pg.clock.run_for(5 * 60000); pg.wait_for_timeout(400)
        card = pg.inner_text('.card:has-text("Going out")')
        need('Pending with Aakash' not in card,
             '5 minutes after Aakash approved, and after the app came back to the front, the card still says "Pending with Aakash / Wait for the approval before you leave." Nothing refreshes by itself and no text tells the person to tap Today again')
    finally:
        s.close()


@check('R5-11', 'Medium', 'Actions that cannot be undone must ask once before they happen')
def _(p):
    s = Phone(p, at=ist(11, 5)); pg = s.pg
    try:
        s.open(); s.login('varun'); dialogs = []
        pg.on('dialog', lambda d: (dialogs.append(d.message), d.dismiss()))
        s.tab('More'); pg.wait_for_timeout(300)
        before = pg.evaluate("()=>GJMock.data.People[0].pinHash")
        pg.click('button:has-text("Create new PIN")'); pg.wait_for_timeout(500)     # the list is pre-set to the first name, Neha
        changed = before != pg.evaluate("()=>GJMock.data.People[0].pinHash")
        asked = bool(dialogs) or pg.locator('button:has-text("Yes"), button:has-text("Confirm")').count() > 0
        need(not changed or asked,
             'one tap on "Create new PIN" replaced the PIN of %s (the pre-selected first name) with no question; her old PIN stopped working. The same one-tap pattern is on "Cancel this request" (an approved leave) and "Remove this phone"'
             % pg.evaluate("()=>GJMock.data.People[0].name"))
    finally:
        s.close()


@check('R5-12', 'Medium', 'No screen may be wider than the phone (Calendar at 360 and 390 px)')
def _(p):
    bad = []
    for w, h in [(360, 740), (390, 844)]:
        s = Phone(p, w=w, h=h, at=ist(11, 5)); pg = s.pg
        try:
            s.open(); s.login('aakash'); s.menu('Calendar'); pg.wait_for_timeout(300)
            sw = pg.evaluate('document.documentElement.scrollWidth')
            if sw > w: bad.append('%d px phone: page is %d px wide' % (w, sw))
            if w == 360: s.shot('12-calendar-overflow')
        finally:
            s.close()
    need(not bad, 'Calendar: the "Clash risk: Sales, Calls, Repairing, Repair pool" chip does not wrap (white-space: nowrap), so the whole page and the tab bar become wider than the screen: ' + '; '.join(bad))


@check('R5-13', 'Medium', 'A violation on "My month" must say in plain words what it is and show the note (the proof)')
def _(p):
    s = Phone(p, at=ist(11, 5)); pg = s.pg
    try:
        s.open(); s.login('neha')
        s.as_other('aakash', 'recordIncident', {'personId': 'neha', 'item': 'job-sheet', 'note': 'Sheet not filled for job 4411', 'date': '2026-11-20'})
        s.tab('My month'); pg.wait_for_timeout(400)
        card = pg.inner_text('.card:has-text("Violations")')
        s.shot('13-violation-raw-key')
        need('job-sheet' not in card and '4411' in card,
             'the line reads %r: the internal key "job-sheet" instead of "BytePhase job sheet", and Aakash\'s note is not shown (myMonth does not send it), so the person is asked to dispute within 24 hours without seeing what was recorded'
             % [l for l in card.split('\n') if 'Recorded by' in l])
    finally:
        s.close()


# ---------------------------------------------------------------- LOW

@check('R5-14', 'Low', 'Opening the app with no network must show the app\'s own message')
def _(p):
    s = Phone(p); pg = s.pg
    try:
        s.open()
        regs = pg.evaluate("()=>navigator.serviceWorker?navigator.serviceWorker.getRegistrations().then(r=>r.length):0")
        s.ctx.set_offline(True); ok = True
        try: pg.reload(timeout=5000)
        except Exception: ok = False
        need(regs > 0 and ok, 'no service worker is registered (%d), so with no network the installed app opens on the browser\'s own error page instead of a "No connection" screen' % regs)
    finally:
        s.close()


@check('R5-15', 'Low', 'The framing guide must sit on the camera picture, not on the black bars')
def _(p):
    s = Phone(p, w=740, h=360, at=ist(9, 26)); pg = s.pg
    try:
        s.open(); s.login('neha'); pg.clock.resume()
        pg.click('button:has-text("Check in")'); pg.wait_for_timeout(1500)
        r = pg.evaluate("()=>{var w=document.body.lastElementChild,v=w.querySelector('video').getBoundingClientRect(),g=w.querySelector('video').nextElementSibling.getBoundingClientRect();return {v:[v.left,v.right],g:[g.left,g.right]}}")
        s.shot('15-camera-guide')
        need(r['g'][0] >= r['v'][0] - 1 and r['g'][1] <= r['v'][1] + 1,
             'landscape phone: the picture is drawn from x=%d to %d but the dashed guide runs from x=%d to %d (it is sized from the screen, not from the picture), so "whole shop inside the frame" cannot be judged from it'
             % (r['v'][0], r['v'][1], r['g'][0], r['g'][1]))
    finally:
        s.close()


@check('R5-16', 'Low', 'Save on "Edit person" must never do nothing')
def _(p):
    s = Phone(p, at=ist(11, 5)); pg = s.pg
    try:
        s.open(); s.login('varun')
        pg.evaluate("()=>{GJMock.data.People[0].sundayOff=[2,4]}")      # a Sunday pattern typed in the Sheet that is not one of the four in the list
        s.menu('People, duty'); pg.click('button:has-text("Edit") >> nth=0'); pg.wait_for_timeout(300)
        pg.fill('#app input >> nth=0', 'Neha S'); pg.click('button:has-text("Save")'); pg.wait_for_timeout(600)
        need('Edit Neha' not in s.text() or s.toast() != '',
             'the Sunday list shows a blank value, JSON.parse("") throws inside the click handler, busy() swallows it: the Save button does nothing and shows no message')
    finally:
        s.close()


@check('R5-17', 'Low', 'The minutes in the preview and in the confirmation must be the same number')
def _(p):
    s = Phone(p, at=ist(9, 0)); pg = s.pg
    try:
        s.open(); s.login('neha')
        c = '.card:has-text("Late or leaving early")'
        pg.fill(c + ' input[type=time]', '10:15'); pg.dispatch_event(c + ' input[type=time]', 'change'); pg.wait_for_timeout(800)
        preview = [l for l in pg.inner_text(c).split('\n') if 'This uses' in l]
        pg.click(c + ' button:has-text("Ask Aakash")'); pg.wait_for_timeout(500); toast = s.toast()
        need(preview and '35 min' in preview[0] and '45 min' not in toast,
             'preview says %r, then the confirmation says %r: two different numbers for the same request with no word on which one counts' % (preview, toast))
    finally:
        s.close()


@check('R5-18', 'Low', 'Editing a request must look like editing and offer a way out')
def _(p):
    s = Phone(p, at=ist(11, 5)); pg = s.pg
    try:
        s.open(); s.login('vikas')
        s.call('submitLeave', {'kind': 'half', 'dates': ['2026-11-26'], 'halfStart': '11:00', 'reasonCode': 'Exam', 'reasonText': 'Paper'})
        s.tab('Apply'); pg.wait_for_timeout(600); pg.click('button:has-text("Edit")'); pg.wait_for_timeout(700)
        pg.clock.run_for(4000); pg.wait_for_timeout(200)             # the 3-second toast is gone
        labels = pg.evaluate("()=>[].filter.call(document.querySelectorAll('#app .card label'),l=>!l.parentElement.hidden).map(l=>l.textContent)")
        buttons = pg.evaluate("()=>[].map.call(document.querySelectorAll('#app .card:first-of-type button'),b=>b.textContent)")
        need(pg.inner_text('h1') != 'Apply for leave' and any('edit' in b.lower() and ('stop' in b.lower() or 'cancel' in b.lower() or 'discard' in b.lower()) for b in buttons) and 'First day' not in labels,
             'after "Edit" the heading is still %r, the only sign of edit mode is a 3-second toast, there is no "stop editing" control (buttons: %r), and a half-day form still labels its date %r'
             % (pg.inner_text('h1'), buttons, labels[0]))
    finally:
        s.close()


@check('R5-19', 'Low', 'Notifications must carry a date and readable dates; the phone list must name the phone')
def _(p):
    s = Phone(p, at=ist(11, 5)); pg = s.pg
    try:
        s.open(); s.login('vikas')
        s.call('submitLeave', {'kind': 'full', 'dates': ['2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10'], 'reasonCode': 'Travel', 'reasonText': 'Trip'})   # 4 days: goes to Aakash and Varun
        pg.clock.run_for(26 * 3600 * 1000)                          # the next day
        s.as_other('aakash', 'notifications')
        tok = pg.evaluate("()=>window.__t_aakash")
        pg.evaluate("t=>{GJApp.state.session={personId:'aakash',deviceToken:t}}", tok)
        notes = s.call('notifications')['data']
        pg.evaluate("()=>GJApp.VIEWS.notes()"); pg.wait_for_timeout(400); txt = s.text()
        need(notes, 'setup: no notification')
        problems = []
        if '2026-12-07' in txt: problems.append('body shows raw dates "2026-12-07, 2026-12-08, …"')
        if '20 Nov' not in txt and 'Yesterday' not in txt: problems.append('yesterday\'s notification shows only a clock time ("11:05"), no date')
        need(not problems, '; '.join(problems) + '. (Also: Phones and the "New phone" approval card label every phone with the raw browser string "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit…", identical on all Android phones.)')
    finally:
        s.close()


@check('R5-20', 'Low', 'Form fields need a label a screen reader can read; tick boxes need a 40 px row')
def _(p):
    s = Phone(p, at=ist(11, 5)); pg = s.pg
    try:
        s.open(); s.login('vikas'); s.check_in()
        js = """()=>{var bad=[];document.querySelectorAll('#app input,#app select,#app textarea').forEach(function(e){var named=e.getAttribute('aria-label')||e.getAttribute('aria-labelledby')||(e.id&&document.querySelector('label[for="'+e.id+'"]'))||e.closest('label');if(!named)bad.push(e.tagName.toLowerCase()+'['+(e.type||'')+']')});return bad}"""
        a = pg.evaluate(js); s.tab('Apply'); pg.wait_for_timeout(500); b = pg.evaluate(js)
        s.as_other('varun', 'me'); pg.evaluate("()=>{GJApp.state.session={personId:'varun',deviceToken:window.__t_varun}}")
        pg.evaluate("()=>GJApp.VIEWS.restrictions()"); pg.wait_for_timeout(400)
        hgt = pg.evaluate("()=>{var c=document.querySelector('#app input[type=checkbox]');return c?Math.round(c.closest('label').getBoundingClientRect().height):-1}")
        need(not a and not b and hgt >= 40,
             'fields with no programmatic label (the visible <label> has no "for"): Today %r, Apply %r; "Applies to" tick rows are %d px high (9 stacked rows)' % (a, b, hgt))
    finally:
        s.close()


@check('R5-21', 'Low', 'A special request Aakash has already approved must leave his "waiting" list')
def _(p):
    s = Phone(p, at=ist(11, 5)); pg = s.pg
    try:
        s.open(); s.login('aakash')
        s.as_other('vikas', 'submitLeave', {'kind': 'full', 'dates': ['2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10', '2026-12-11'], 'reasonCode': 'Travel', 'reasonText': 'Trip'})
        s.tab('Approvals'); pg.wait_for_timeout(400); pg.click('button:has-text("Approve")'); pg.wait_for_timeout(600)
        txt = s.text()
        need('1 waiting' not in txt,
             'after Aakash approved, his screen still says "1 waiting" with live Approve / Reject buttons ("Aakash: yes · Varun: waiting") and the badge stays; the toast and the staff chip say only "Special – waiting", not who is awaited (the handoff asks for "Special – waiting for Varun")')
    finally:
        s.close()


@check('R5-22', 'Low', 'If the upload fails after the photo is taken, the photo must be kept for a retry')
def _(p):
    s = Phone(p, at=ist(9, 26)); pg = s.pg
    try:
        s.open(); s.login('neha'); pg.clock.resume()
        pg.evaluate("()=>{var o=GJMock.handle;GJMock.handle=function(b){ if(b.action==='checkIn'&&!window.__once){window.__once=1;throw new Error('network')} return o(b)}}")
        pg.click('button:has-text("Check in")'); pg.click('button:has-text("Take photo"):not([disabled])'); pg.wait_for_timeout(3000)
        retry = pg.locator('button:has-text("Try again"), button:has-text("Retry"), button:has-text("Send again")').count()
        need(retry > 0, 'toast %r and the screen is back at "Check in": the photo (second person or tripod, everyone in position) is thrown away and must be taken again; the arrival time moves later meanwhile' % s.toast())
    finally:
        s.close()


@check('R5-23', 'Low', 'Messages must match what happened (server error page; location refused; empty rule list)')
def _(p):
    problems = []
    s = Phone(p); pg = s.pg
    try:
        s.ctx.unroute('**/*')
        def route(r):
            u = r.request.url
            if '127.0.0.1' in u: return r.continue_()
            if 'script.google.com' in u:
                b = json.loads(r.request.post_data)
                if b['action'] == 'names': return r.fulfill(body=json.dumps({'ok': True, 'data': [{'id': 'neha', 'name': 'Neha'}]}), content_type='application/json')
                return r.fulfill(body='<html><body>Service invoked too many times for one day</body></html>', content_type='text/html')
            return r.abort()
        s.ctx.route('**/*', route)
        pg.goto(BASE); pg.wait_for_selector('#who option', state='attached'); pg.fill('#pin', '1234'); pg.click('button:has-text("Sign in")'); pg.wait_for_timeout(500)
        if 'No connection' in s.toast(): problems.append('a Google error page (quota, outage) is reported as "No connection. Please try again." although the phone is online')
    finally:
        s.close()
    s = Phone(p, geo=False); pg = s.pg
    try:
        s.open(); s.login('aakash'); s.menu('Set shop location'); pg.click('button:has-text("Set shop location now")'); pg.wait_for_timeout(9000)
        if 'Reading 5 of 5' in pg.inner_text('.card'): problems.append('with location refused, "Set shop location" spends about 6 s on "Reading 1…5 of 5", then leaves "Reading 5 of 5…" on the card; the message does not say that location permission is off')
        s.as_other('varun', 'me'); pg.evaluate("()=>{GJApp.state.session={personId:'varun',deviceToken:window.__t_varun}}")
        pg.evaluate("()=>GJApp.VIEWS.rules()"); pg.wait_for_timeout(400)
        if pg.locator('#app .card').count() == 0 and 'No ' not in s.text(): problems.append('demo: "Clash rules" is an empty page with no rule and no "none" line, although the rules are in force (the demo does not seed them)')
    finally:
        s.close()
    need(not problems, '; '.join(problems))


def main():
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1', '--directory', DOCS], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.0)
    failed = 0
    only = [a[7:] for a in sys.argv if a.startswith('--only=')]
    try:
        with sync_playwright() as p:
            for cid, sev, title, fn in CHECKS:
                if only and cid not in only: continue
                try:
                    fn(p); print('PASS  %s [%s] %s' % (cid, sev, title))
                except Fail as e:
                    failed += 1; print('FAIL  %s [%s] %s\n      -> %s' % (cid, sev, title, e))
                except Exception as e:
                    failed += 1; print('ERROR %s [%s] %s\n      -> %s' % (cid, sev, title, str(e).split('\n')[0][:300]))
    finally:
        srv.terminate()
    print('\n%d of %d checks failed (docs: %s)' % (failed, len(only) or len(CHECKS), DOCS))
    sys.exit(failed)


if __name__ == '__main__':
    main()
