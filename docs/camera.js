/**
 * Check-in photo (handoff 3.8): taken INSIDE the app, BACK camera only, LANDSCAPE only,
 * no gallery upload. A stamp is drawn on the photo like a "GPS camera" app.
 * GJCamera.capture(opts) -> Promise<{ photo, thumb, dress, lat, lng, accuracy }>
 * opts: { name, deviceShort, serverOffsetMs, shopPoint, demo, dressCheck }
 */
(function () {
  'use strict';
  var PHOTO_W = 1280, THUMB_W = 320;

  function el(tag, style, text) { var e = document.createElement(tag); if (style) e.style.cssText = style; if (text) e.textContent = text; return e; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function stampTime(ms) { var d = new Date(ms + 19800000); return pad(d.getUTCDate()) + '-' + pad(d.getUTCMonth() + 1) + '-' + d.getUTCFullYear() + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ' IST'; }
  function distance(a, b) {
    var R = 6371000, t = Math.PI / 180, dLat = (b.lat - a.lat) * t, dLng = (b.lng - a.lng) * t;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return Math.round(2 * R * Math.asin(Math.sqrt(x)));
  }
  function locate() {
    return new Promise(function (ok) {
      if (!navigator.geolocation) return ok(null);
      navigator.geolocation.getCurrentPosition(function (p) { ok({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }); }, function () { ok(null); },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
    });
  }
  function openCamera(demo) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.reject(new Error('This browser cannot open the camera.'));
    // Back camera only. "exact" means the front camera can never be offered.
    return navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { exact: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } }).catch(function (e) {
      if (demo) return navigator.mediaDevices.getUserMedia({ audio: false, video: true }); // demo on a laptop only
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw new Error('Camera permission is off. Allow the camera for this app in the phone settings.');
      throw new Error('The back camera was not found. A check-in photo must be taken with the back camera.');
    });
  }

  function capture(opts) {
    return new Promise(function (resolve, reject) {
      var wrap = el('div', 'position:fixed;inset:0;background:#000;z-index:50;display:flex;flex-direction:column;color:#fff;font:15px system-ui,sans-serif');
      var stage = el('div', 'position:relative;flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden');
      var video = el('video', 'max-width:100%;max-height:100%'); video.setAttribute('playsinline', ''); video.muted = true; video.autoplay = true;
      var guide = el('div', 'position:absolute;inset:6%;border:2px dashed rgba(255,255,255,.75);border-radius:10px;pointer-events:none');
      var figure = el('div', 'position:absolute;left:50%;top:12%;bottom:8%;width:14%;transform:translateX(-50%);border:2px solid rgba(255,255,255,.6);border-radius:40% 40% 8px 8px;pointer-events:none');
      var hint = el('div', 'padding:10px 14px;text-align:center;background:#14213d', '');
      var bar = el('div', 'display:flex;gap:10px;padding:12px;background:#14213d;padding-bottom:calc(12px + env(safe-area-inset-bottom))');
      var cancel = el('button', 'flex:1;min-height:52px;border:0;border-radius:12px;font:inherit;font-weight:700;background:#e7ebf3;color:#14213d', 'Cancel');
      var shoot = el('button', 'flex:2;min-height:52px;border:0;border-radius:12px;font:inherit;font-weight:700;background:#2563eb;color:#fff', 'Take photo');
      stage.appendChild(video); stage.appendChild(guide); stage.appendChild(figure); bar.appendChild(cancel); bar.appendChild(shoot);
      wrap.appendChild(hint); wrap.appendChild(stage); wrap.appendChild(bar); document.body.appendChild(wrap);
      var stream = null, where = locate(), timer = null, done = false;

      function close() { done = true; clearInterval(timer); if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); wrap.remove(); }
      function landscape() { return video.videoWidth > video.videoHeight; }
      function refresh() {
        var ok = landscape();
        // The guide and the outline sit on the picture itself, not on the black bars beside it.
        var vr = video.getBoundingClientRect(), sr = stage.getBoundingClientRect();
        if (vr.width > 0 && vr.height > 0) {
          var x = vr.left - sr.left, y = vr.top - sr.top;
          guide.style.cssText += ';inset:auto;left:' + (x + vr.width * 0.04) + 'px;top:' + (y + vr.height * 0.05) + 'px;width:' + (vr.width * 0.92 - 4) + 'px;height:' + (vr.height * 0.90 - 4) + 'px';
          figure.style.cssText += ';transform:none;bottom:auto;left:' + (x + vr.width * 0.43) + 'px;top:' + (y + vr.height * 0.12) + 'px;width:' + (vr.width * 0.14) + 'px;height:' + (vr.height * 0.80) + 'px';
        }
        shoot.disabled = !ok; shoot.style.opacity = ok ? '1' : '.45';
        hint.textContent = ok ? 'Whole shop in the frame. ' + opts.name + ' standing inside the outline, head to toe. Photo taken by another person or the tripod.'
          : 'Turn the phone sideways (landscape). A portrait photo is not accepted.';
      }
      cancel.onclick = function () { close(); reject(new Error('Check-in photo cancelled.')); };
      shoot.onclick = function () {
        if (!landscape() || done) return;
        shoot.disabled = true; hint.textContent = 'Saving the photo…';
        var scale = Math.min(1, PHOTO_W / video.videoWidth), w = Math.round(video.videoWidth * scale), hgt = Math.round(video.videoHeight * scale);
        var canvas = document.createElement('canvas'); canvas.width = w; canvas.height = hgt;
        var g = canvas.getContext('2d', { willReadFrequently: true }); g.drawImage(video, 0, 0, w, hgt);
        var takenAt = Date.now() + (opts.serverOffsetMs || 0); // server time, never the phone clock
        var dressJob = opts.dressCheck && window.GJDress ? window.GJDress.check(canvas, 12000) : Promise.resolve(null);
        Promise.all([where, dressJob]).then(function (r) {
          var pos = r[0], dress = r[1];
          var lines = ['GJ Leave · ' + opts.name + ' · ' + stampTime(takenAt) + ' (server time)',
            pos ? pos.lat.toFixed(5) + ', ' + pos.lng.toFixed(5) + ' ±' + pos.accuracy + ' m' + (opts.shopPoint ? ' · ' + distance(opts.shopPoint, pos) + ' m from shop point' : '') : 'Location not available',
            'Device ' + (opts.deviceShort || '----')];
          var fs = Math.max(13, Math.round(hgt / 34)), boxH = fs * 1.35 * lines.length + fs * 0.7;
          g.fillStyle = 'rgba(0,0,0,.62)'; g.fillRect(0, hgt - boxH, w, boxH);
          g.fillStyle = '#fff'; g.font = '600 ' + fs + 'px system-ui, sans-serif'; g.textBaseline = 'top';
          lines.forEach(function (t, i) { g.fillText(t, fs * 0.6, hgt - boxH + fs * 0.35 + i * fs * 1.35); });
          var photo = canvas.toDataURL('image/jpeg', 0.72);
          if (photo.length > 880000) photo = canvas.toDataURL('image/jpeg', 0.5);
          var t = document.createElement('canvas'); t.width = THUMB_W; t.height = Math.round(hgt * THUMB_W / w); t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
          var thumb = t.toDataURL('image/jpeg', 0.6);
          if (thumb.length > 42000) thumb = t.toDataURL('image/jpeg', 0.35); // must fit in one Sheet cell
          var out = { photo: photo, thumb: thumb, dress: dress || undefined };
          if (pos) { out.lat = pos.lat; out.lng = pos.lng; out.accuracy = pos.accuracy; }
          close(); resolve(out);
        }).catch(function (e) { close(); reject(e); });
      };
      openCamera(opts.demo).then(function (s) {
        if (done) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
        stream = s; video.srcObject = s; refresh(); timer = setInterval(refresh, 400);
      }).catch(function (e) { close(); reject(e); });
    });
  }

  window.GJCamera = { capture: capture };
})();
