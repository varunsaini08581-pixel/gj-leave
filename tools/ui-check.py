import sys, subprocess, time
from playwright.sync_api import sync_playwright
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '--directory', '' + __import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)), '..', 'docs') + ''], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
errors = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'])
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        pg = ctx.new_page()
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'XNNPACK' not in m.text else None)
        pg.on('pageerror', lambda e: errors.append(str(e)))
        def login(who):
            pg.goto('http://localhost:8765/?demo=1')
            pg.wait_for_selector('#who option', state='attached')
            pg.select_option('#who', who); pg.fill('#pin', '1234'); pg.click('text=Sign in')
            if pg.locator('text=Demo only: approve this phone').count() or True:
                try:
                    pg.wait_for_selector('text=Demo only: approve this phone', timeout=1500)
                    pg.click('text=Demo only: approve this phone'); pg.click('text=Sign in')
                except Exception: pass
            pg.wait_for_selector('text=Hello,')
        login('neha')
        pg.screenshot(path='1-home.png', full_page=True)
        pg.click('#tabs >> text=Apply'); pg.wait_for_selector('.result')
        pg.select_option('select', 'Personal work'); pg.fill('textarea', 'Bank work'); pg.wait_for_selector('.result.green')
        pg.screenshot(path='2-apply.png', full_page=True)
        pg.click('text=Send request'); pg.wait_for_selector('text=My requests')
        pg.click('#tabs >> text=Today'); pg.wait_for_selector('text=Hello,')
        pg.click('button:has-text("Check in")'); pg.click('button:has-text("Take photo"):not([disabled])'); pg.wait_for_selector('button:has-text("Check out")', timeout=30000)
        pg.click('#tabs >> text=My month'); pg.wait_for_selector('text=2-hour bank')
        pg.screenshot(path='3-month.png', full_page=True)
        # emergency request to create a pending approval
        pg.click('#tabs >> text=Apply'); pg.wait_for_selector('.result')
        import datetime
        tomorrow = (datetime.datetime.utcnow() + datetime.timedelta(hours=5.5, days=1)).strftime('%Y-%m-%d')
        pg.fill('input[type=date] >> nth=0', tomorrow); pg.dispatch_event('input[type=date] >> nth=0', 'change')
        pg.fill('input[type=date] >> nth=1', tomorrow); pg.dispatch_event('input[type=date] >> nth=1', 'change')
        pg.select_option('select', 'Sick'); pg.fill('textarea', 'Fever'); pg.wait_for_selector('.result.amber')
        pg.screenshot(path='4-apply-aakash.png', full_page=True)
        pg.click('text=Send request'); pg.wait_for_timeout(500)
        # same session data lives in page memory; switch user without reload
        pg.click('#tabs >> text=More'); pg.click('text=Sign out')
        pg.select_option('#who', 'aakash'); pg.fill('#pin', '1234'); pg.click('text=Sign in')
        pg.wait_for_selector('text=Demo only: approve this phone'); pg.click('text=Demo only: approve this phone'); pg.click('text=Sign in')
        pg.wait_for_selector('text=Hello, Aakash')
        pg.click('#tabs >> text=Approvals'); pg.wait_for_selector('text=waiting')
        pg.screenshot(path='5-approvals.png', full_page=True)
        pg.click('button:has-text("Approve") >> nth=0'); pg.wait_for_timeout(600)
        pg.screenshot(path='6-after.png', full_page=True)
        b.close()
finally:
    srv.terminate()
print('console errors:', errors)
