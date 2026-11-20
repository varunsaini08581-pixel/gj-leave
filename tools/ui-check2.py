# Phone-size check of the management screens in demo mode. Prints console errors.
import sys, subprocess, time, os
from playwright.sync_api import sync_playwright
docs = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs')
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8766', '--directory', docs], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errors = []; shots = sys.argv[1] if len(sys.argv) > 1 else None
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']); ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=1, geolocation={'latitude': 29.1492, 'longitude': 75.7217}, permissions=['geolocation'])
        pg = ctx.new_page(); pg.set_default_timeout(8000)
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'XNNPACK' not in m.text else None); pg.on('pageerror', lambda e: errors.append(str(e)))
        def login(who):
            pg.select_option('#who', who); pg.fill('#pin', '1234'); pg.click('text=Sign in')
            pg.wait_for_selector('button:has-text("Demo only"), h1:has-text("Hello,")')
            if pg.locator('text=Demo only: approve this phone').count():
                pg.click('text=Demo only: approve this phone'); pg.click('text=Sign in')
            pg.wait_for_selector('text=Hello,')
        def menu(label, expect):
            pg.click('#tabs >> text=More'); pg.click('button:has-text("%s")' % label); pg.wait_for_selector('text=%s' % expect)
            if shots: pg.screenshot(path=os.path.join(shots, label.split(' ')[0].lower() + '.png'), full_page=True)
        pg.goto('http://localhost:8766/?demo=1'); pg.wait_for_selector('#who option', state='attached')
        login('harsh'); pg.click('button:has-text("Check in")'); pg.click('button:has-text("Take photo"):not([disabled])'); pg.wait_for_selector('button:has-text("Check out")', timeout=30000)
        pg.fill('input[type=time]', '19:00'); pg.click('button:has-text("I will leave early")'); pg.click('button:has-text("Ask Aakash") >> nth=-1'); pg.wait_for_timeout(700); pg.wait_for_selector('text=Pending with Aakash')
        pg.click('#tabs >> text=More'); pg.click('text=Sign out')
        login('aakash'); pg.wait_for_selector('text=Shop today')
        if shots: pg.screenshot(path=os.path.join(shots, 'board.png'), full_page=True)
        pg.click('#tabs >> text=Approvals'); pg.wait_for_selector('text=Leaving early'); pg.click('button:has-text("Approve") >> nth=0'); pg.wait_for_timeout(400)
        menu('Record a violation', 'Record an incident'); pg.select_option('select >> nth=0', 'harsh'); pg.select_option('select >> nth=1', 'job-sheet'); pg.fill('textarea', 'Job sheet not filled'); pg.click('button:has-text("Record")'); pg.wait_for_selector('text=Violation recorded')
        menu('Calendar', 'Clash risk'); menu('Month report', 'Live, not locked'); menu('Restrictions', 'New restriction')
        pg.fill('input[type=date] >> nth=0', '2026-12-24'); pg.fill('input[type=date] >> nth=1', '2026-12-26'); pg.fill('input[placeholder^="For example"]', 'Year-end sale'); pg.click('button:has-text("Add restriction")'); pg.wait_for_selector('text=Year-end sale')
        menu('Set shop location', 'Stand inside the shop'); pg.click('button:has-text("Set shop location now")'); pg.wait_for_selector('text=Saved:', timeout=15000)
        menu('Today at GJ', 'Harsh'); pg.wait_for_selector('img[alt="Check-in photo"][src^="data:image/jpeg"]'); menu('Notifications', 'Notifications')
        menu('Enter leave', 'Enter leave for staff')
        pg.click('#tabs >> text=More'); pg.click('text=Sign out')
        login('harsh'); pg.click('#tabs >> text=My month'); pg.wait_for_selector('text=Recorded by Aakash'); pg.fill('input[placeholder^="Why do you"]', 'I filled it later'); pg.click('button:has-text("Dispute")'); pg.wait_for_selector('text=Dispute: open')
        pg.click('#tabs >> text=Apply'); pg.wait_for_selector('.result')
        pg.click('#tabs >> text=More'); pg.click('text=Sign out')
        login('varun'); menu('Disputes', '1 open'); pg.fill('input[placeholder^="Your decision"]', 'Checked, sheet was filled'); pg.click('button:has-text("Remove violation")'); pg.wait_for_selector('text=No open disputes')
        menu('People, duty', 'Only you can see'); pg.click('button:has-text("Salary structure") >> nth=0'); pg.wait_for_selector('text=salary structure'); pg.click('button:has-text("Save")'); pg.wait_for_selector('text=Only you can see')
        pg.click('button:has-text("Edit") >> nth=0'); pg.wait_for_selector('text=Duty start'); pg.click('button:has-text("Save")'); pg.wait_for_selector('text=Only you can see')
        menu('Clash rules', 'Hard rules'); menu('Grace table', 'How many times'); pg.click('button:has-text("Save grace table")'); pg.wait_for_timeout(300)
        menu('Override', 'Only you can do this')
        b.close()
finally:
    srv.terminate()
print('console errors:', errors)
