/* GJ Leave & Attendance - offline message only. Nothing of the app is kept here: every file always comes
   fresh from the network, so an old copy can never be served. When there is no network at all, the phone
   shows this short page instead of the browser's own error page. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(function () {
    return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GJ Leave &amp; Attendance</title>' +
      '<body style="font:17px system-ui,sans-serif;margin:0;padding:32px 20px;background:#f3f5f9;color:#14213d"><h1 style="font-size:22px">No connection</h1>' +
      '<p>GJ Leave &amp; Attendance needs the internet. Check your mobile data or Wi-Fi and open the app again.</p>' +
      '<p>If the app stays down: call Aakash, or message him directly.</p><p><a href="./" style="display:inline-block;padding:14px 18px;border-radius:12px;background:#2563eb;color:#fff;font-weight:700;text-decoration:none">Try again</a></p></body>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }));
});
