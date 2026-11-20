import sys, subprocess, time, os
from playwright.sync_api import sync_playwright
docs = '/home/claude/gj-leave/docs'
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8767', '--directory', docs], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); errors = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 390, 'height': 844})
        pg = ctx.new_page(); pg.set_default_timeout(8000)
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None); pg.on('pageerror', lambda e: errors.append(str(e)))
        def login(who):
            pg.select_option('#who', who); pg.fill('#pin', '1234'); pg.click('text=Sign in')
            pg.wait_for_selector('button:has-text("Demo only"), h1:has-text("Hello,")')
            if pg.locator('text=Demo only: approve this phone').count():
                pg.click('text=Demo only: approve this phone'); pg.click('text=Sign in')
            pg.wait_for_selector('text=Hello,')
        pg.goto('http://localhost:8767/?demo=1'); pg.wait_for_selector('#who option', state='attached')
        login('neha'); pg.click('#tabs >> text=Apply'); pg.wait_for_selector('.result'); pg.select_option('select', 'Travel'); pg.fill('textarea', 'Trip'); pg.wait_for_timeout(700)
        pg.click('button:has-text("Send request")'); pg.wait_for_selector('text=My requests')
        pg.click('#tabs >> text=More'); pg.click('text=Sign out'); pg.wait_for_selector('#who')
        login('aakash'); pg.click('#tabs >> text=More'); pg.click('button:has-text("Staff leaves")'); pg.wait_for_selector('text=Cancel this leave')
        pg.fill('input[placeholder^="Reason"]', 'Plan changed'); pg.click('button:has-text("Cancel this leave")'); pg.click('button:has-text("Tap again")'); pg.wait_for_selector('text=No leaves.')
        pg.go_back(); pg.wait_for_selector('h1:has-text("More")')
        pg.click('text=Sign out'); pg.wait_for_selector('#who')
        login('varun'); pg.click('#tabs >> text=More'); pg.click('button:has-text("Clash rules")'); pg.wait_for_selector('text=Change people')
        pg.click('button:has-text("Change people") >> nth=0'); pg.wait_for_selector('text=People in this rule'); pg.click('button:has-text("Save rule")'); pg.wait_for_selector('text=Hard rules')
        w = pg.evaluate('document.documentElement.scrollWidth'); print('width', w)
        pg.click('#tabs >> text=More'); pg.click('button:has-text("Shop-closed days")'); pg.wait_for_selector('text=No closed days'); pg.click('#tabs >> text=More'); pg.click('button:has-text("Phones")'); pg.wait_for_selector('text=One approved phone')
        b.close()
finally:
    srv.terminate()
print('console errors:', errors)
