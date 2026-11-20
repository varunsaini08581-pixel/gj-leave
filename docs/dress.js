/**
 * Automatic dress check (handoff 3.8). Runs ON THE PHONE on the check-in photo.
 * Step 1: a pose model finds shoulders, hips, knees, ankles and feet.
 * Step 2: this file samples the colours there: top white (a black coat over it is fine),
 *         trousers black, shoes black, belt worn (weak, hint only).
 * It never creates a violation. The result only flags the photo to Aakash.
 *
 * analyze() is pure (pixels + landmarks in, result out) so it is tested without a camera.
 */
(function (root) {
  'use strict';
  // MediaPipe pose landmark numbers
  var L = { ls: 11, rs: 12, lh: 23, rh: 24, lk: 25, rk: 26, la: 27, ra: 28, lheel: 29, rheel: 30, lf: 31, rf: 32 };
  var MIN_VIS = 0.5, MIN_SAMPLES = 24;

  function classify(r, g, b) {
    var max = Math.max(r, g, b), min = Math.min(r, g, b), light = (max + min) / 510, chroma = (max - min) / 255;
    if (light < 0.27) return 'dark';
    if (light > 0.62 && chroma < 0.2) return 'white';
    return 'other';
  }
  function sampler(img) {
    return function (points) {
      var c = { dark: 0, white: 0, other: 0, n: 0 };
      points.forEach(function (p) {
        var x = Math.round(p[0] * img.width), y = Math.round(p[1] * img.height);
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
        var i = (y * img.width + x) * 4;
        c[classify(img.data[i], img.data[i + 1], img.data[i + 2])] += 1; c.n += 1;
      });
      return c;
    };
  }
  function grid(x0, y0, x1, y1, nx, ny) {
    var pts = [];
    for (var i = 0; i < nx; i++) for (var j = 0; j < ny; j++) pts.push([x0 + (x1 - x0) * (i + 0.5) / nx, y0 + (y1 - y0) * (j + 0.5) / ny]);
    return pts;
  }
  function along(a, b, width, n, from, to) {
    var pts = [], dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy) || 1, px = -dy / len, py = dx / len;
    for (var i = 0; i < n; i++) {
      var t = from + (to - from) * (i + 0.5) / n;
      for (var k = -1; k <= 1; k++) pts.push([a.x + dx * t + px * width * k, a.y + dy * t + py * width * k]);
    }
    return pts;
  }
  function seen(lm, keys) { return keys.every(function (k) { return lm[L[k]] && (lm[L[k]].visibility === undefined || lm[L[k]].visibility >= MIN_VIS); }); }

  /**
   * img: { width, height, data } (RGBA, like canvas ImageData)
   * lm:  33 pose landmarks, each { x, y, visibility } with x and y from 0 to 1
   * Returns { top, trousers, shoes, belt } each 'ok' | 'issue' | 'unknown'
   */
  function analyze(img, lm) {
    var out = { top: 'unknown', trousers: 'unknown', shoes: 'unknown', belt: 'unknown' };
    if (!lm || lm.length < 33) return out;
    var count = sampler(img);

    if (seen(lm, ['ls', 'rs', 'lh', 'rh'])) {
      var xs = [lm[L.ls].x, lm[L.rs].x].sort(), ys = (lm[L.ls].y + lm[L.rs].y) / 2, yh = (lm[L.lh].y + lm[L.rh].y) / 2;
      var w = xs[1] - xs[0], hgt = yh - ys;
      if (w > 0.01 && hgt > 0.02) {
        var top = count(grid(xs[0] + w * 0.2, ys + hgt * 0.15, xs[1] - w * 0.2, yh - hgt * 0.2, 8, 10));
        if (top.n >= MIN_SAMPLES) {
          // White shirt or plain kurti; a black coat over it is OK. Flag only a clearly coloured top.
          out.top = (top.white + top.dark) / top.n >= 0.6 && (top.white / top.n >= 0.08 || top.dark / top.n >= 0.6) ? 'ok' : 'issue';
        }
        // Belt: a darker band at the waist, between the hips. Weak signal.
        var hx = [lm[L.lh].x, lm[L.rh].x].sort();
        var belt = count(grid(hx[0], yh - hgt * 0.1, hx[1], yh - hgt * 0.02, 10, 3));
        if (belt.n >= 12) out.belt = belt.dark / belt.n >= 0.4 ? 'ok' : 'issue';
      }
    }
    if (seen(lm, ['lh', 'rh', 'lk', 'rk', 'la', 'ra'])) {
      var thighW = Math.abs(lm[L.lh].x - lm[L.rh].x) * 0.18 + 0.002;
      var legs = count(along(lm[L.lh], lm[L.lk], thighW, 8, 0.25, 0.95).concat(along(lm[L.rh], lm[L.rk], thighW, 8, 0.25, 0.95),
        along(lm[L.lk], lm[L.la], thighW, 8, 0.05, 0.85), along(lm[L.rk], lm[L.ra], thighW, 8, 0.05, 0.85)));
      if (legs.n >= MIN_SAMPLES) out.trousers = legs.dark / legs.n >= 0.55 ? 'ok' : 'issue';
    }
    if (seen(lm, ['la', 'ra', 'lf', 'rf'])) {
      var fw = Math.abs(lm[L.la].y - lm[L.lk].y) * 0.06 + 0.002;
      var feet = count(along(lm[L.lheel] || lm[L.la], lm[L.lf], fw, 6, 0.1, 0.9).concat(along(lm[L.rheel] || lm[L.ra], lm[L.rf], fw, 6, 0.1, 0.9)));
      if (feet.n >= MIN_SAMPLES) out.shoes = feet.dark / feet.n >= 0.5 ? 'ok' : 'issue';
    }
    return out;
  }

  // ---------- pose model (loaded only on a phone, only at check-in) ----------
  var VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  var MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
  var landmarker = null;
  function load() {
    if (landmarker) return Promise.resolve(landmarker);
    return import(VISION + '/vision_bundle.mjs').then(function (v) {
      return v.FilesetResolver.forVisionTasks(VISION + '/wasm').then(function (files) {
        return v.PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: MODEL }, runningMode: 'IMAGE', numPoses: 1 });
      });
    }).then(function (lmk) { landmarker = lmk; return lmk; });
  }
  /** Check a canvas. Never throws: if the model cannot load or no person is found, everything is 'unknown'. */
  function check(canvas, timeoutMs) {
    var unknown = { top: 'unknown', trousers: 'unknown', shoes: 'unknown', belt: 'unknown' };
    var work = load().then(function (lmk) {
      var res = lmk.detect(canvas);
      if (!res.landmarks || !res.landmarks.length) return unknown;
      var ctx = canvas.getContext('2d');
      return analyze(ctx.getImageData(0, 0, canvas.width, canvas.height), res.landmarks[0]);
    }).catch(function () { return unknown; });
    var timer = new Promise(function (ok) { setTimeout(function () { ok(unknown); }, timeoutMs || 12000); });
    return Promise.race([work, timer]);
  }

  var api = { analyze: analyze, classify: classify, check: check };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJDress = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
