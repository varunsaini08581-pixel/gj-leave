/* GJ Leave & Attendance - phone app. All rules are enforced on the server; this file only shows them. */
(function () {
  'use strict';
  var CFG = window.GJ_CONFIG || {};
  var CLIENT_VERSION = 1; // goes up when the server must refuse older copies of this file (server: MIN_CLIENT_VERSION)
  // Demo mode (sample data inside the phone, nothing saved) only when the address asks for it.
  // If the settings file did not arrive, the app stops: it must never quietly turn into a demo.
  var DEMO = /[?&]demo=1/.test(location.search);
  var BROKEN = !DEMO && !CFG.API_URL;
  function once(key) { try { if (sessionStorage.getItem(key)) return false; sessionStorage.setItem(key, '1'); return true; } catch (e) { return false; } }
  var app = document.getElementById('app'), tabsEl = document.getElementById('tabs'), toastEl = document.getElementById('toast');
  var state = { me: null, tab: 'home', sub: '', gen: 0, loading: false, reload: null, session: loadSession(), badge: 0 };

  // ---------- helpers ----------
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') el.className = attrs[k];
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    [].concat(kids == null ? [] : kids).forEach(function (c) { if (c != null && c !== false) el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c))); });
    return el;
  }
  var labelNo = 0;
  function tieLabels() {
    if (!app.querySelectorAll) return;
    [].forEach.call(app.querySelectorAll('label:not([for])'), function (l) {
      var f = l.nextElementSibling;
      if (!f || !/^(INPUT|SELECT|TEXTAREA)$/.test(f.tagName)) return;
      if (!f.id) f.id = 'l' + (++labelNo);
      l.setAttribute('for', f.id);
    });
    [].forEach.call(app.querySelectorAll('input:not([id]), textarea:not([id]), select:not([id])'), function (f) {
      if (!f.getAttribute('aria-label') && f.getAttribute('placeholder')) f.setAttribute('aria-label', f.getAttribute('placeholder'));
    });
  }
  function show(nodes) { state.loading = false; app.replaceChildren.apply(app, [].concat(nodes).filter(function (n) { return n != null && n !== false; })); tieLabels(); window.scrollTo(0, 0); }
  /** A screen that could not load: say so, and offer to try again (never an endless "Loading"). */
  function showLoadError(message) {
    var again = state.reload;
    show([h('h1', {}, 'Could not load'), h('div', { class: 'card' }, [h('p', {}, message || 'Check the connection and try again.'),
      h('div', { class: 'btns' }, [button('Try again', 'primary', function () { if (again) again(); }), state.tab === 'more' && state.sub ? button('‹ Back', '', function () { go('more'); }) : null])])]);
  }
  /** A button that asks once more before something that cannot be taken back. */
  function confirmButton(label, cls, question, fn) {
    var armed = false, timer, b = h('button', { class: cls || '', type: 'button' }, label);
    b.addEventListener('click', function () {
      if (b.disabled) return;
      if (!armed) { armed = true; b.textContent = typeof question === 'function' ? question() : question; clearTimeout(timer); timer = setTimeout(function () { armed = false; b.textContent = label; }, 6000); return; }
      clearTimeout(timer); armed = false; b.textContent = label; b.disabled = true;
      Promise.resolve().then(fn).catch(function (e) { if (!(e && e.code)) toast('Something went wrong on this screen. Please try again.', true); }).then(function () { b.disabled = false; });
    });
    return b;
  }
  function phoneLabel() {
    var u = navigator.userAgent || '', kind = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android phone' : /Windows/.test(u) ? 'Windows computer' : /Mac/.test(u) ? 'Mac' : 'Device';
    var m = u.match(/Android [\d.]+; ([^;)]+)/);
    return kind + (m && m[1] && m[1] !== 'K' ? ' (' + m[1].trim().slice(0, 30) + ')' : '') + ', ' + (/Chrome|CriOS/.test(u) ? 'Chrome' : /Safari/.test(u) ? 'Safari' : 'browser');
  }
  var toastTimer;
  function toast(text, isError) {
    toastEl.textContent = text; toastEl.className = isError ? 'err' : ''; toastEl.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.hidden = true; }, isError ? 6000 : 3000);
  }
  function loadSession() { try { return JSON.parse(localStorage.getItem(DEMO ? 'gjleave.demo' : 'gjleave.session')) || {}; } catch (e) { return {}; } }
  // The phone's approval token is kept apart from the sign-in: after "Sign out" the PIN is needed again,
  // but the phone stays the approved phone (no new approval from the owner).
  function loadDevice() { try { return JSON.parse(localStorage.getItem(DEMO ? 'gjleave.demo.device' : 'gjleave.device')) || {}; } catch (e) { return {}; } }
  function saveDevice(d) { try { localStorage.setItem(DEMO ? 'gjleave.demo.device' : 'gjleave.device', JSON.stringify(d)); } catch (e) { /* stays in memory */ } }
  function knownToken(personId) {
    var d = loadDevice();
    if (d.personId === personId && d.deviceToken) return d.deviceToken;
    return state.session.personId === personId ? (state.session.deviceToken || null) : null;
  }
  function signOut() {
    // The server is told first: after this the phone's token opens nothing until the PIN is entered again.
    var done = state.session.deviceToken ? api('signOut').catch(function () {}) : Promise.resolve();
    if (state.session.deviceToken) saveDevice({ personId: state.session.personId, deviceToken: state.session.deviceToken });
    return done.then(function () { saveSession({ personId: state.session.personId }); state.me = null; });
  }
  function saveSession(s) { state.session = s; try { localStorage.setItem(DEMO ? 'gjleave.demo' : 'gjleave.session', JSON.stringify(s)); } catch (e) { /* stays in memory */ } }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ist(ms) { return new Date(ms + 19800000); }
  function timeOf(ms) { var d = ist(ms); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); }
  function whenOf(ms) { var d = ist(ms).toISOString().slice(0, 10); return (d === todayStr() ? 'Today' : niceDate(d)) + ', ' + timeOf(ms); }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function niceDate(d) { return (+d.slice(8)) + ' ' + MON[+d.slice(5, 7) - 1]; }
  function niceDates(ds) { return ds.length === 1 ? niceDate(ds[0]) : niceDate(ds[0]) + ' – ' + niceDate(ds[ds.length - 1]) + ' (' + ds.length + ' days)'; }
  function todayStr() { return ist(Date.now()).toISOString().slice(0, 10); }
  function addDays(d, n) { return new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
  function statusChip(status, waitingFor) {
    var c = status === 'Approved' || status === 'Recorded' ? 'green' : /^Rejected|^Absent/.test(status) ? 'red' : status === 'Cancelled' ? 'blue' : /^Special/.test(status) ? 'violet' : 'amber';
    return h('span', { class: 'chip ' + c }, /^Special/.test(status) && waitingFor ? 'Special – waiting for ' + waitingFor : status);
  }

  // ---------- API ----------
  // Answers of these calls only fill a screen. If the person has moved to another screen meanwhile, the answer is dropped.
  var READS = { today: 1, notifications: 1, approvals: 1, myMonth: 1, myLeaves: 1, myRestrictions: 1, board: 1, todayAtGJ: 1, calendar: 1, monthReport: 1, getSettings: 1,
    restrictions: 1, incidentItems: 1, disputes: 1, devices: 1, pending: 1 };
  var NEVER = { then: function () { return NEVER; }, catch: function () { return NEVER; } };
  function post(body) {
    if (DEMO) return Promise.resolve().then(function () { return window.GJMock.handle(body); }).then(null, function () { var e = new Error('No connection, or the server took too long. Please try again.'); e.code = 'NET'; throw e; });
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 45000);
    return fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined })
      .then(function (r) { clearTimeout(timer); return r.json().catch(function () { return { ok: false, code: 'SERVER', message: 'The server did not answer properly. Please try again in a minute.' }; }); },
        function () { clearTimeout(timer); var e = new Error('No connection, or the server took too long. Please try again.'); e.code = 'NET'; throw e; });
  }
  function api(action, args) {
    var body = { action: action, args: args || {}, clientVersion: CLIENT_VERSION, personId: state.session.personId, deviceToken: state.session.deviceToken };
    var gen = state.gen, read = READS[action] === 1;
    return post(body).then(function (res) {
      if (read && gen !== state.gen) return NEVER; // the person is on another screen now
      if (res.ok) return res.data;
      if (res.code === 'AUTH') { state.me = null; viewLogin(); }
      if (res.code === 'UPDATE') {
        // One reload fetches the new files. If the same old files come back, stop and say so: never a reload loop.
        if (once('gjleave.reloaded')) location.replace(location.origin + location.pathname + '?u=' + Date.now());
        else { res.message = 'This copy of the app is old. Close the app completely and open it again. If it stays, tell Varun.'; show([h('h1', {}, 'Update needed'), h('div', { class: 'card' }, h('p', {}, res.message))]); tabsEl.hidden = true; }
      }
      if (res.code === 'UNKNOWN') res.message = 'The app is newer than the server. Please tell Varun. (code UNKNOWN)';
      var e = new Error(res.message); e.code = res.code; throw e;
    }).then(null, function (e) {
      if (read && gen !== state.gen) return NEVER;
      if (read && state.loading && e.code !== 'AUTH' && e.code !== 'UPDATE') showLoadError(e.message);
      throw e;
    });
  }
  function run(promise, okText) {
    return promise.then(function (d) { if (okText) toast(okText); return d; }, function (e) { if (e.code !== 'AUTH') toast(e.message, true); throw e; });
  }
  function busy(btn, fn) {
    return function () {
      if (btn.disabled) return;
      btn.disabled = true;
      Promise.resolve().then(fn).catch(function (e) { if (!(e && e.code)) toast('Something went wrong on this screen. Please try again.', true); }).then(function () { btn.disabled = false; });
    };
  }
  function button(label, cls, fn) { var b = h('button', { class: cls || '', type: 'button' }, label); b.addEventListener('click', busy(b, fn)); return b; }

  // ---------- tabs ----------
  function drawTabs() {
    if (!state.me) { tabsEl.hidden = true; return; }
    var items = [['home', 'Today'], ['apply', 'Apply'], ['month', 'My month']];
    if (state.me.role !== 'staff') items.push(['approve', 'Approvals']);
    items.push(['more', 'More']);
    tabsEl.replaceChildren.apply(tabsEl, items.map(function (it) {
      var b = h('button', { class: state.tab === it[0] ? 'on' : '', type: 'button', 'aria-current': state.tab === it[0] ? 'page' : false, onclick: function () { go(it[0]); } }, it[1]);
      if (it[0] === 'approve' && state.badge) b.appendChild(h('span', { class: 'dot' }, state.badge));
      return b;
    }));
    tabsEl.hidden = false;
  }
  var VIEWS = {};
  function go(tab, arg, fromHistory) {
    state.tab = tab; state.sub = ''; state.gen += 1; drawTabs();
    show(h('p', { class: 'muted' }, 'Loading…')); state.loading = true;
    state.reload = function () { go(tab, arg, true); };
    // Each screen is a step in the phone's own Back history, so Back goes to the previous screen and does not leave the app.
    if (!fromHistory) { try { history.pushState({ tab: tab }, ''); } catch (e) { /* no history: fine */ } }
    VIEWS[tab](arg);
  }
  window.addEventListener && window.addEventListener('popstate', function (ev) {
    if (!state.me) return;
    var st = ev.state || { tab: 'home' };
    if (st.sub && window.GJOpen) window.GJOpen(st.sub, st.arg, true); else go(VIEWS[st.tab] ? st.tab : 'home', undefined, true);
  });
  // Nothing is pushed to the phone, so the screen itself must stay fresh: when the app comes back to the
  // front, and every 30 seconds while Today or Approvals is open and nobody is typing.
  function typing() { var el = document.activeElement; return !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || '') && (el.value || '') !== ''; }
  function refresh() { if (state.me && !state.loading && !state.sub && (state.tab === 'home' || state.tab === 'approve') && !typing() && !state.camera) VIEWS[state.tab](); }
  if (document.addEventListener) document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  if (typeof setInterval !== 'undefined' && (!DEMO || /[?&]poll=1/.test(location.search))) setInterval(function () { if (!document.hidden) refresh(); }, 30000);

  // ---------- login ----------
  function viewLogin(note) {
    tabsEl.hidden = true;
    var sel = h('select', { id: 'who' }), pin = h('input', { id: 'pin', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 6, placeholder: '4 to 6 digits' });
    var msg = h('div', {});
    var btn = button('Sign in', 'primary', function () {
      return run(api('login', { personId: sel.value, pin: pin.value, deviceToken: knownToken(sel.value), deviceLabel: phoneLabel() })).then(function (r) {
        var token = r.deviceToken || knownToken(sel.value);
        saveDevice({ personId: sel.value, deviceToken: token });
        saveSession({ personId: sel.value, deviceToken: token });
        if (r.ok) return start();
        msg.replaceChildren(h('div', { class: 'warn' }, 'This phone is waiting for the owner’s approval. After he approves it, sign in again.'),
          DEMO ? button('Demo only: approve this phone', 'small', function () { window.GJMock.approveDevices(); toast('Approved (demo). Sign in again.'); }) : null);
      });
    });
    pin.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') btn.click(); });
    show([
      h('div', { class: 'brand' }, [h('h1', {}, 'GJ Leave & Attendance'), h('p', { class: 'sub' }, 'Genuine Junction')]),
      DEMO ? h('div', { class: 'demo' }, 'Demo mode: sample data on this phone only. Nothing is saved. Every PIN is 1234.') : null,
      note ? h('div', { class: 'warn' }, note) : null,
      h('div', { class: 'card' }, [h('label', { for: 'who' }, 'Your name'), sel, h('label', { for: 'pin' }, 'PIN'), pin, h('div', { class: 'btns' }, btn), msg])
    ]);
    run(api('names')).then(function (list) {
      list.forEach(function (p) { sel.appendChild(h('option', { value: p.id }, p.name)); });
      if (state.session.personId) sel.value = state.session.personId;
    });
  }

  // ---------- today ----------
  VIEWS.home = function () {
    Promise.all([api('today'), api('notifications'), state.me.role !== 'staff' ? api('approvals') : null]).then(function (r) {
      var t = r[0], notes = r[1].slice(-5).reverse(), ap = r[2];
      if (ap) { state.badge = ap.leaves.length + ap.outings.length + ap.devices.length + ap.absences.length + ap.shorts.length + (ap.dress || []).length; drawTabs(); }
      var cards = [h('h1', {}, 'Hello, ' + state.me.name), h('p', { class: 'sub' }, niceDate(t.date) + ' · Duty ' + state.me.dutyStart + '–' + state.me.dutyEnd)];
      var tracked = state.me.role === 'staff';
      if (!tracked && window.GJBoard) cards.push(window.GJBoard());
      if (tracked && t.hints && t.hints.length) cards.push(h('div', { class: 'card' }, [h('h2', {}, 'This month'), h('ul', { class: 'list' }, t.hints.map(function (x) { return h('li', {}, x); }))]));
      if (tracked) {
        var c = h('div', { class: 'card' }, h('h2', {}, 'Attendance'));
        if (!t.checkIn) {
          c.appendChild(h('p', {}, 'You have not checked in yet. The check-in photo is taken sideways (landscape) with the back camera, by another person or the tripod.'));
          if (state.shot) c.appendChild(h('div', { class: 'warn' }, ['Your photo is saved on this phone but was not sent. ', button('Send again', 'primary', function () {
            var shot = state.shot;
            return run(api('checkIn', shot), 'Checked in.').then(function () { state.shot = null; VIEWS.home(); });
          })]));
          c.appendChild(button('Check in', 'primary', function () {
            var sunday = new Date(Date.parse(t.date + 'T00:00:00Z')).getUTCDay() === 0;
            var sendShot = function (shot) {
              return run(api('checkIn', shot), 'Checked in.').then(function (res) {
                state.shot = null;
                if (res.flag) toast('Checked in. Flag: ' + res.flag.replace(/-/g, ' '), true);
                VIEWS.home();
              }, function (e) {
                // The photo is kept: it can be sent again without setting up the second person or the tripod once more.
                if (e.code === 'NET' || e.code === 'SERVER' || e.code === 'ERROR') { state.shot = shot; VIEWS.home(); }
                throw e;
              });
            };
            state.camera = true;
            return window.GJCamera.capture({ name: state.me.name, deviceShort: state.me.deviceShort, serverOffsetMs: state.offset || 0, shopPoint: state.me.shopPoint,
              demo: DEMO, dressCheck: !state.me.dressExempt && !sunday }).then(function (shot) { state.camera = false; return sendShot(shot); }, function (e) { state.camera = false; toast(e.message, true); throw e; });
          }));
        } else {
          c.appendChild(h('div', { class: 'row' }, [h('span', {}, 'Checked in'), h('span', { class: 'big' }, timeOf(t.checkIn.at))]));
          if (t.checkOut) c.appendChild(h('div', { class: 'row' }, [h('span', {}, 'Checked out'), h('span', { class: 'big' }, timeOf(t.checkOut.at))]));
          else if (!t.outing || t.outing.status === 'Back') {
            var nowMin = (function () { var d = ist(Date.now() + (state.offset || 0)); return d.getUTCHours() * 60 + d.getUTCMinutes(); })();
            var endMin = +state.me.dutyEnd.slice(0, 2) * 60 + +state.me.dutyEnd.slice(3), earlyBy = endMin - nowMin;
            var doOut = function () { return run(api('checkOut'), 'Checked out.').then(VIEWS.home); };
            // Before duty end this ends the day and the missing time is counted: ask once more.
            c.appendChild(h('div', { class: 'btns' }, earlyBy > 0
              ? confirmButton('Check out', '', 'Duty ends at ' + state.me.dutyEnd + '. Tap again to check out ' + (earlyBy >= 60 ? Math.floor(earlyBy / 60) + ' h ' + (earlyBy % 60) + ' min' : earlyBy + ' min') + ' early', doOut)
              : button('Check out', '', doOut)));
            if (earlyBy > 0) c.appendChild(h('p', { class: 'muted' }, 'Check out only when you leave for the day. A wrong check-out can be taken back only by Aakash.'));
          }
        }
        cards.push(c);
        if (t.checkIn && !t.checkOut) cards.push(outingCard(t));
        cards.push(shortCard(t));
      }
      if (notes.length) cards.push(h('div', { class: 'card' }, [h('h2', {}, 'Recent'), h('ul', { class: 'list' }, notes.map(function (n) {
        return h('li', {}, [h('strong', {}, n.title), n.body ? h('div', { class: 'muted' }, n.body) : null, h('div', { class: 'muted' }, whenOf(n.createdAt))]);
      }))]));
      show(cards);
    }).catch(function (e) { if (e.code !== 'AUTH') show(h('div', { class: 'warn' }, e.message)); });
  };
  function position() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve({});
      navigator.geolocation.getCurrentPosition(function (p) { resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }); },
        function () { resolve({}); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
    });
  }
  function outingCard(t) {
    var c = h('div', { class: 'card' }, h('h2', {}, 'Going out'));
    var o = t.outing;
    if (!o) {
      var reason = h('input', { placeholder: 'Reason', maxlength: 80 }), mins = h('input', { type: 'number', inputmode: 'numeric', min: 1, max: 120, placeholder: 'Expected minutes' });
      c.appendChild(h('p', { class: 'muted' }, 'Up to 15 min is free. More than 15 min: the whole outing comes from your 2-hour bank.'));
      var eff = h('div', {});
      mins.addEventListener('input', function () { effectInto(eff, { kind: 'out', minutes: +mins.value }); });
      c.appendChild(reason); c.appendChild(h('div', { style: 'height:8px' })); c.appendChild(mins); c.appendChild(eff);
      c.appendChild(h('div', { class: 'btns' }, button('Ask Aakash', '', function () { return run(api('goingOut', { reason: reason.value, expectedMinutes: +mins.value }), 'Sent to Aakash.').then(VIEWS.home); })));
    } else if (o.status === 'Pending') {
      c.appendChild(h('p', {}, [h('span', { class: 'chip amber' }, 'Pending with Aakash'), ' ' + o.reason]));
      c.appendChild(h('p', { class: 'muted' }, 'Wait for the approval before you leave.'));
    } else if (o.status === 'Approved') {
      c.appendChild(h('p', {}, 'Out since ' + timeOf(o.approvedAt) + ' – still open'));
      c.appendChild(button('I’m back', 'primary', function () { return run(api('imBack', { id: o.id })).then(function (r) { toast('Back. ' + r.minutes + ' min.'); VIEWS.home(); }); }));
    } else {
      c.appendChild(h('p', {}, 'Out ' + timeOf(o.approvedAt) + '–' + timeOf(o.backAt) + ' = ' + o.minutes + ' min. Waiting for Aakash to confirm.'));
      c.appendChild(button('Remind Aakash', 'small', function () { return run(api('remindBack', { id: o.id }), 'Reminder sent.'); }));
    }
    return c;
  }
  var effectTimer;
  function effectInto(box, args) {
    clearTimeout(effectTimer);
    effectTimer = setTimeout(function () {
      api('effect', args).then(function (r) { box.replaceChildren.apply(box, r.lines.map(function (l) { return h('div', { class: 'warn' }, l); })); }).catch(function () {});
    }, 350);
  }
  function shortCard(t) {
    var c = h('div', { class: 'card' }, h('h2', {}, 'Late or leaving early'));
    t.shorts.forEach(function (q) {
      var cls = q.status === 'Approved' ? 'green' : q.status === 'Rejected' ? 'red' : 'amber';
      c.appendChild(h('p', {}, [h('span', { class: 'chip ' + cls }, q.status === 'Pending' ? 'Pending with Aakash' : q.status), ' ' + (q.date && q.date !== t.date ? niceDate(q.date) + ': ' : '') + (q.kind === 'late' ? 'Arriving at ' : 'Leaving at ') + q.time + (q.decisionReason ? ' \u2014 ' + q.decisionReason : ''),
        q.status !== 'Rejected' ? confirmButton('Cancel', 'small', 'Tap again to cancel this request', function () { return run(api('cancelShort', { id: q.id }), 'Cancelled.').then(VIEWS.home); }) : null]));
    });
    var kind = 'late', seg = h('div', { class: 'seg' });
    var date = h('input', { type: 'date', value: t.date, min: t.date }), time = h('input', { type: 'time' });
    function drawSeg() {
      seg.replaceChildren(h('button', { class: kind === 'late' ? 'on' : '', type: 'button', onclick: function () { kind = 'late'; drawSeg(); } }, 'I will be late'),
        h('button', { class: kind === 'early' ? 'on' : '', type: 'button', onclick: function () { kind = 'early'; drawSeg(); } }, 'I will leave early'));
    }
    drawSeg();
    c.appendChild(h('p', { class: 'muted' }, 'Ask before duty start (late) or before you leave (early). After Aakash approves, the minutes are "informed".'));
    c.appendChild(seg); c.appendChild(h('label', {}, 'Date')); c.appendChild(date);
    var eff2 = h('div', {});
    function upd() { if (time.value) effectInto(eff2, { kind: kind, time: time.value, date: date.value }); }
    time.addEventListener('change', upd); date.addEventListener('change', upd); seg.addEventListener('click', upd);
    c.appendChild(h('label', {}, 'Exact time (arrival or leaving)')); c.appendChild(time); c.appendChild(eff2);
    c.appendChild(h('div', { class: 'btns' }, button('Ask Aakash', '', function () {
      return run(api('requestShort', { kind: kind, date: date.value, time: time.value })).then(function (r) { toast(r.repeated ? 'This request was already sent.' : 'Sent to Aakash.'); VIEWS.home(); });
    })));
    return c;
  }

  // ---------- apply ----------
  VIEWS.apply = function () {
    var f = { kind: 'full', from: addDays(todayStr(), 3), to: addDays(todayStr(), 3), halfStart: state.me.dutyStart, reasonCode: '', reasonText: '', extremeEmergency: false };
    var seg = h('div', { class: 'seg' }), from = h('input', { type: 'date', value: f.from, min: todayStr() }), to = h('input', { type: 'date', value: f.to, min: todayStr() });
    var half = h('input', { type: 'time', value: f.halfStart }), toWrap = h('div', {}, [h('label', {}, 'Last day'), to]), halfWrap = h('div', { hidden: true }, [h('label', {}, 'Half day starts at (4 h 30 min)'), half]);
    var reason = h('select', {}, [h('option', { value: '' }, 'Choose a reason')].concat(state.me.reasons.map(function (r) { return h('option', { value: r }, r); })));
    var text = h('textarea', { maxlength: 200, placeholder: 'Write the reason' });
    var result = h('div', {}), mine = h('div', {}), restr = h('div', {}), editId = null;
    var send = button('Send request', 'primary', function () {
      var inp = input(); if (editId) inp.id = editId;
      return run(api(editId ? 'editLeave' : 'submitLeave', inp)).then(function (r) { toast('Request: ' + r.status); state.gen += 1; VIEWS.apply(); });
    });
    send.disabled = true;
    function dates() { var out = []; for (var d = from.value; d && d <= (f.kind === 'half' ? from.value : to.value) && out.length < 62; d = addDays(d, 1)) out.push(d); return out; }
    function input() { return { editId: editId || undefined, kind: f.kind, dates: dates(), halfStart: f.kind === 'half' ? half.value : '', reasonCode: reason.value, reasonText: text.value, extremeEmergency: f.extremeEmergency }; }
    var timer, seq = 0;
    function preview() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var my = ++seq;
        api('previewLeave', input()).then(function (p) {
          if (my !== seq) return;
          var map = { auto: ['green', 'Will be auto-approved'], aakash: ['amber', 'Goes to Aakash'], special: ['violet', 'Needs Aakash + Varun'], varun: ['amber', 'Goes to Varun'], recorded: ['green', 'Will be recorded. No approval needed.'], blocked: ['red', ''] };
          var m = map[p.decision];
          var kids = [h('div', { class: 'result ' + m[0] }, p.decision === 'blocked' ? p.reasons.join(' ') : m[1] + (p.type ? ' · ' + p.type : ''))];
          if (p.decision !== 'blocked' && p.decision !== 'auto' && p.decision !== 'recorded') kids.push(h('p', { class: 'muted', style: 'margin-top:6px' }, p.reasons.join(' ')));
          (p.warnings || []).forEach(function (w) {
            var box = h('div', { class: 'warn' }, w);
            if (/extreme emergency/.test(w)) box.appendChild(button(f.extremeEmergency ? 'Marked as extreme emergency' : 'Mark as extreme emergency', 'small', function () { f.extremeEmergency = !f.extremeEmergency; preview(); }));
            kids.push(box);
          });
          if (p.quota) kids.push(h('p', { class: 'muted', style: 'margin-top:8px' }, 'Leaves this month after this: ' + p.quota.total + ' of 5.'));
          result.replaceChildren.apply(result, kids);
          send.disabled = p.decision === 'blocked';
        }).catch(function () {});
      }, 350);
    }
    function drawSeg() {
      seg.replaceChildren(h('button', { class: f.kind === 'full' ? 'on' : '', type: 'button', onclick: function () { f.kind = 'full'; drawSeg(); } }, 'Full day(s)'),
        h('button', { class: f.kind === 'half' ? 'on' : '', type: 'button', onclick: function () { f.kind = 'half'; drawSeg(); } }, 'Half day'));
      toWrap.hidden = f.kind === 'half'; halfWrap.hidden = f.kind !== 'half'; if (typeof dayLabel !== 'undefined' && dayLabel) dayLabel.textContent = f.kind === 'half' ? 'Date' : 'First day'; preview();
    }
    from.addEventListener('change', function () { if (to.value < from.value) to.value = from.value; preview(); });
    [to, half, reason].forEach(function (el) { el.addEventListener('change', preview); });
    text.addEventListener('input', preview);
    var title = h('h1', {}, 'Apply for leave'), editBar = h('div', {}), dayLabel = null;
    dayLabel = h('label', {}, 'First day');
    show([title, h('p', { class: 'sub' }, 'Exact dates only. You will see the result before you send.'),
      h('div', { class: 'card' }, [editBar, restr, seg, dayLabel, from, toWrap, halfWrap, h('label', {}, 'Reason'), reason, h('div', { style: 'height:8px' }), text, result, h('div', { class: 'btns' }, send)]),
      mine]);
    drawSeg();
    api('myRestrictions').then(function (list) {
      if (list.length) restr.replaceChildren(h('div', { class: 'warn', style: 'margin:0 0 12px' }, [h('strong', {}, 'Restricted dates'), h('ul', { class: 'list', style: 'margin-top:6px' }, list.map(function (r) {
        return h('li', {}, niceDate(r.from) + ' to ' + niceDate(r.to) + ': ' + r.note + (r.rule === 'no-leave' ? ' (no leave)' : ' (leave counts as 1 violation)'));
      }))]));
    }).catch(function () {});
    api('myLeaves').then(function (list) {
      if (!list.length) return;
      mine.replaceChildren(h('div', { class: 'card' }, [h('h2', {}, 'My requests'), h('ul', { class: 'list' }, list.slice().reverse().slice(0, 20).map(function (r) {
        var li = h('li', {}, [h('div', { class: 'row' }, [h('strong', {}, niceDates(r.dates) + (r.kind === 'half' ? ' · half day ' + r.halfStart : '')), statusChip(r.status, r.waitingFor)]),
          h('div', { class: 'muted' }, r.type + (r.decisionReason ? ' · ' + r.decisionReason : '') + (r.enteredBy ? ' · entered by ' + r.enteredBy : ''))]);
        if (r.status === 'Approved' || /^(Pending|Special)/.test(r.status)) {
          li.appendChild(h('div', { class: 'btns' }, [button('Edit', 'small', function () {
            editId = r.id; f.kind = r.kind; from.value = r.dates[0]; to.value = r.dates[r.dates.length - 1]; half.value = r.halfStart || state.me.dutyStart;
            reason.value = r.reasonCode; text.value = r.reasonText; send.textContent = 'Save changes'; drawSeg(); window.scrollTo(0, 0);
            title.textContent = 'Change your request';
            editBar.replaceChildren(h('div', { class: 'warn', style: 'margin:0 0 12px' }, ['You are changing the request for ' + niceDates(r.dates) + '. Saving sends it for a decision again. ', button('Stop editing', 'small', function () { VIEWS.apply(); })]));
          }), confirmButton('Cancel this request', 'small danger', 'Tap again to cancel ' + niceDates(r.dates), function () { return run(api('cancelLeave', { id: r.id }), 'Cancelled.').then(VIEWS.apply); })]));
        }
        return li;
      }))]));
    }).catch(function () {});
  };

  // ---------- my month ----------
  var RULE_TEXT = { 'not-informed-over-30': 'Not informed, more than 30 min', 'not-informed-beyond-passes': 'Not informed, after the 3 passes', 'extra-2-hours-beyond-bank': 'Extra 2 hours beyond the bank',
    'unannounced-leave': 'Unannounced leave', 'emergency-beyond-2': 'Emergency leave beyond 2 in the month', 'leave-in-restricted-period': 'Leave in a restricted period', 'absent-no-request': 'Absent with no request' };
  function shiftMonth(m, by) { var y = +m.slice(0, 4), mo = +m.slice(5) + by; if (mo < 1) { mo = 12; y -= 1; } if (mo > 12) { mo = 1; y += 1; } return y + '-' + pad(mo); }
  VIEWS.month = function (arg) {
    // arg: nothing (own page, this month) or { personId, month, back } from a report or an approval card.
    arg = typeof arg === 'string' ? { personId: arg } : (arg || {});
    var personId = arg.personId, month = arg.month || todayStr().slice(0, 7), thisMonth = todayStr().slice(0, 7);
    state.reload = function () { VIEWS.month(arg); };
    run(api('myMonth', { month: month, personId: personId })).then(function (m) {
      var L = m.leaves, B = m.bank;
      var open = function (mo) { state.gen += 1; show(h('p', { class: 'muted' }, 'Loading…')); state.loading = true; VIEWS.month({ personId: personId, month: mo, back: arg.back }); };
      var cards = [arg.back ? button('‹ Back', 'small', arg.back) : null, h('h1', {}, personId ? m.name : 'My month'),
        h('p', { class: 'sub' }, MON[+m.month.slice(5) - 1] + ' ' + m.month.slice(0, 4) + (m.locked ? ' · Locked' : '')),
        h('div', { class: 'btns', style: 'margin:0 0 12px' }, [button('‹ ' + MON[+shiftMonth(month, -1).slice(5) - 1], 'small', function () { open(shiftMonth(month, -1)); }),
          month < thisMonth ? button(MON[+shiftMonth(month, 1).slice(5) - 1] + ' ›', 'small', function () { open(shiftMonth(month, 1)); }) : null])];
      cards.push(h('div', { class: 'card' }, [h('h2', {}, 'Leaves'), h('div', { class: 'row' }, [h('span', {}, 'Used'), h('span', { class: 'big' }, L.total + ' / ' + L.free)]),
        h('div', { class: 'bar' + (L.total > L.free ? ' over' : '') }, h('span', { style: 'width:' + Math.min(100, L.total / L.free * 100) + '%' })),
        h('p', { class: 'muted' }, 'Roster Sundays ' + L.rosterSundays + ' · Leaves taken ' + L.taken + ' · Left ' + L.left),
        h('p', { class: 'muted' }, 'Emergencies ' + L.emergencies + ' of ' + L.emergenciesAllowed + (L.emergencies >= L.emergenciesAllowed ? ' · the next emergency is a violation' : '')),
        L.undecided && L.undecided.length ? h('p', { class: 'muted' }, 'Counted, not decided yet: ' + L.undecided.map(niceDate).join(', ') + ' (away, and the request is still waiting)') : null]));
      cards.push(h('div', { class: 'card' }, [h('h2', {}, '2-hour bank'), h('div', { class: 'row' }, [h('span', {}, 'Left'), h('span', { class: 'big' }, B.left + ' min')]),
        h('div', { class: 'bar' + (B.beyond ? ' over' : '') }, h('span', { style: 'width:' + Math.min(100, B.used / B.minutes * 100) + '%' })),
        h('p', { class: 'muted' }, 'Used ' + B.used + ' of ' + B.minutes + ' min' + (B.beyond ? ' · ' + B.beyond + ' min beyond the bank' : '') + ' · Not-informed passes ' + B.passesUsed + ' of ' + B.passes),
        B.days.length ? h('ul', { class: 'list' }, B.days.map(function (d) {
          var what = d.kind === 'late' ? d.minutes + ' min late' : d.kind === 'early' ? 'left ' + d.minutes + ' min early' : 'out ' + d.minutes + ' min';
          return h('li', {}, niceDate(d.date) + ': ' + what + ' (' + d.counted + ' counted, ' + (d.informed ? 'informed' : 'not informed') + ')' + (d.notes.length ? ' · ' + d.notes.join(' · ') : ''));
        })) : null]));
      var lad = m.ladder;
      cards.push(h('div', { class: 'card' }, [h('h2', {}, 'Violations'), h('div', { class: 'row' }, [h('span', {}, 'This month'), h('span', { class: 'big' }, String(lad.violations))]),
        h('p', { class: 'muted' }, lad.violations === 0 ? 'None. 1st violation is a record only.' : lad.notice ? 'Notice stage. Varun decides.' : lad.bonusLost ? 'Rs ' + lad.bonusAmount + ' discipline bonus and target allowance would be lost. 1 more = notice.' : 'Record only. 1 more violation = discipline bonus and target allowance would be lost.'),
        m.last3 ? h('p', { class: 'muted' }, 'Last 3 months: ' + m.last3.map(function (x) { return MON[+x.month.slice(5) - 1] + ' ' + x.violations; }).join(' · ')) : null,
        m.violations.length ? h('ul', { class: 'list' }, m.violations.map(function (v) {
          var li = h('li', {}, niceDate(v.date) + ': ' + (v.label || RULE_TEXT[v.rule] || v.rule.replace('manual:', 'Recorded by Aakash: ')));
          if (v.note) li.appendChild(h('div', { class: 'muted' }, 'Note: ' + v.note));
          if (v.disputeState) li.appendChild(h('div', { class: 'muted' }, 'Dispute: ' + v.disputeState));
          else if (!personId && Date.now() - v.createdAt < 86400000) {
            var why = h('input', { placeholder: 'Why do you dispute it?', maxlength: 200 });
            li.appendChild(why);
            li.appendChild(button('Dispute (within 24 hours)', 'small', function () { return run(api('disputeViolation', { id: v.id, text: why.value }), 'Sent to Varun.').then(function () { VIEWS.month(arg); }); }));
          }
          return li;
        })) : null]));
      if (m.wouldBeDeducted) cards.push(h('div', { class: 'card est' }, [h('h2', {}, m.onPayroll ? 'Would be deducted' : 'If you were on payroll'),
        h('div', { class: 'row' }, [h('span', {}, 'Estimate'), h('span', { class: 'big' }, 'Rs ' + m.wouldBeDeducted.total)]),
        h('ul', { class: 'list' }, m.wouldBeDeducted.lines.map(function (l) { return h('li', {}, l); })), h('small', {}, m.wouldBeDeducted.label)]));
      show(cards);
    }).catch(function () {});
  };

  // ---------- approvals ----------
  VIEWS.approve = function () {
    run(api('approvals')).then(function (a) {
      state.badge = a.leaves.length + a.outings.length + a.devices.length + a.absences.length + a.shorts.length + (a.dress || []).length; drawTabs();
      var cards = [h('h1', {}, 'Approvals'), h('p', { class: 'sub' }, state.badge ? state.badge + ' waiting' : 'Nothing is waiting.')];
      function decide(label, okFn, noFn) {
        var why = h('input', { placeholder: 'Reason (required to reject)', maxlength: 120 });
        return h('div', {}, [why, h('div', { class: 'btns' }, [button(label || 'Approve', 'good', function () { return okFn(why.value).then(VIEWS.approve); }),
          noFn ? button('Reject', 'danger', function () { return noFn(why.value).then(VIEWS.approve); }) : null])]);
      }
      a.leaves.forEach(function (r) {
        cards.push(h('div', { class: 'card' }, [h('div', { class: 'row' }, [h('strong', {}, r.name), statusChip(r.status, r.waitingFor)]),
          h('p', {}, niceDates(r.dates) + (r.kind === 'half' ? ' · half day ' + r.halfStart : '') + ' · ' + r.type),
          h('p', { class: 'muted' }, r.reasonCode + ': ' + r.reasonText),
          r.route === 'special' ? h('p', { class: 'muted' }, 'Aakash: ' + (r.approvals.aakash || 'waiting') + ' · Varun: ' + (r.approvals.varun || 'waiting')) : null,
          r.context && r.context.ruleResult.length ? h('p', { class: 'muted' }, 'Why it needs you: ' + r.context.ruleResult.join(' ')) : null,
          r.context ? h('p', { class: 'muted' }, 'Also away: ' + (r.context.awayToo.length ? r.context.awayToo.map(function (x) { return x.name + ' (' + niceDate(x.date) + ', ' + x.why + ')'; }).join(', ') : 'nobody')) : null,
          r.context && r.context.month ? h('p', { class: 'muted' }, 'Month so far: ' + r.context.month.leaves + ' of ' + r.context.month.free + ' leaves · ' + r.context.month.emergencies + ' emergencies · bank ' + r.context.month.bankLeft + ' min left · ' + r.context.month.violations + ' violations') : null,
          button('Open ' + r.name + '’s month', 'small', function () { go('month', { personId: r.personId, month: r.dates[0].slice(0, 7), back: function () { go('approve'); } }); }),
          decide('Approve', function (w) { return run(api('decideLeave', { id: r.id, approve: true, reason: w })).then(function (x) { toast(x.status); }); },
            function (w) { return run(api('decideLeave', { id: r.id, approve: false, reason: w }), 'Rejected.'); })]));
      });
      a.shorts.forEach(function (q) {
        cards.push(h('div', { class: 'card' }, [h('div', { class: 'row' }, [h('strong', {}, q.name + (q.kind === 'late' ? ' \u00b7 Coming late' : ' \u00b7 Leaving early')), h('span', { class: 'chip amber' }, 'Pending')]),
          h('p', {}, niceDate(q.date) + ' \u00b7 ' + (q.kind === 'late' ? 'arriving at ' : 'leaving at ') + q.time),
          decide('Approve', function () { return run(api('decideShort', { id: q.id, approve: true }), 'Approved.'); }, function (w) { return run(api('decideShort', { id: q.id, approve: false, reason: w }), 'Rejected.'); })]));
      });
      a.outings.forEach(function (o) {
        if (o.status === 'Pending') cards.push(h('div', { class: 'card' }, [h('div', { class: 'row' }, [h('strong', {}, o.name + ' · Going out'), h('span', { class: 'chip amber' }, 'Pending')]),
          h('p', {}, o.reason + ' · about ' + o.expectedMinutes + ' min'),
          decide('Approve', function () { return run(api('decideOuting', { id: o.id, approve: true }), 'Approved.'); }, function (w) { return run(api('decideOuting', { id: o.id, approve: false, reason: w }), 'Rejected.'); })]));
        else {
          var fix = h('input', { type: 'time' });
          cards.push(h('div', { class: 'card' }, [h('div', { class: 'row' }, [h('strong', {}, o.name + ' is back'), h('span', { class: 'chip blue' }, o.minutes + ' min')]),
            h('p', {}, 'Out ' + timeOf(o.approvedAt) + '–' + timeOf(o.backAt)), h('label', {}, 'Correct the back time (only if wrong)'), fix,
            h('div', { class: 'btns' }, button('Confirm back', 'good', function () { return run(api('confirmBack', { id: o.id, correctedTime: fix.value || undefined }), 'Confirmed.').then(VIEWS.approve); }))]));
        }
      });
      (a.outNow || []).forEach(function (o) {
        var at = h('input', { type: 'time' });
        cards.push(h('div', { class: 'card' }, [h('div', { class: 'row' }, [h('strong', {}, o.name + ' is out'), h('span', { class: 'chip amber' }, 'Since ' + timeOf(o.approvedAt))]),
          h('p', {}, o.reason + ' · about ' + o.expectedMinutes + ' min'), h('label', {}, 'If the person forgot to tap I’m back: time they returned'), at,
          h('div', { class: 'btns' }, button('Close this outing', '', function () { return run(api('confirmBack', { id: o.id, correctedTime: at.value }), 'Closed.').then(VIEWS.approve); }))]));
      });
      (a.dress || []).forEach(function (d) {
        cards.push(h('div', { class: 'card' }, [h('div', { class: 'row' }, [h('strong', {}, d.name + ' \u00b7 Dress check'), h('span', { class: 'chip amber' }, 'Possible issue')]),
          h('p', {}, niceDate(d.date) + ': ' + d.issues.join(', ') + (d.belt === 'issue' ? ' (hint: belt not seen)' : '')), h('p', { class: 'muted' }, 'The app only flags. Look at the photo and decide.'),
          window.GJPhoto ? window.GJPhoto(d.photoId) : null,
          h('div', { class: 'btns' }, [button('Confirm', 'danger', function () { return run(api('decideDress', { id: d.id, confirm: true })).then(function (r) { toast(r.result === 'violation' ? 'Violation recorded.' : 'Noted, within grace.'); VIEWS.approve(); }); }),
            button('Dismiss', 'good', function () { return run(api('decideDress', { id: d.id, confirm: false }), 'Dismissed.').then(VIEWS.approve); })])]));
      });
      a.absences.forEach(function (r) {
        var why = h('input', { placeholder: 'Reason for excusing', maxlength: 120 });
        cards.push(h('div', { class: 'card' }, [h('div', { class: 'row' }, [h('strong', {}, r.name), h('span', { class: 'chip red' }, 'Absent – unannounced')]), h('p', {}, niceDates(r.dates) + ' · 1 violation recorded'), why,
          h('div', { class: 'btns' }, [button('Humanitarian – excused', '', function () { return run(api('excuseAbsence', { id: r.id, reason: why.value }), 'Excused.').then(VIEWS.approve); }),
            button('Keep as absent', '', function () { return run(api('keepAbsent', { id: r.id }), 'Kept as absent.').then(VIEWS.approve); })])]));
      });
      a.devices.forEach(function (d) {
        cards.push(h('div', { class: 'card' }, [h('div', { class: 'row' }, [h('strong', {}, d.name + ' · New phone'), h('span', { class: 'chip amber' }, 'Pending')]), h('p', { class: 'muted' }, d.label),
          h('div', { class: 'btns' }, [button('Approve phone', 'good', function () { return run(api('decideDevice', { id: d.id, approve: true }), 'Phone approved.').then(VIEWS.approve); }),
            button('Reject', 'danger', function () { return run(api('decideDevice', { id: d.id, approve: false }), 'Rejected.').then(VIEWS.approve); })])]));
      });
      show(cards);
    }).catch(function () {});
  };

  // ---------- more ----------
  VIEWS.more = function () {
    var cards = [h('h1', {}, 'More')];
    if (state.me.role === 'owner') {
      var sel = h('select', {}, h('option', { value: '' }, 'Choose a person')), out = h('div', {});
      api('names').then(function (l) { l.forEach(function (p) { sel.appendChild(h('option', { value: p.id }, p.name)); }); });
      cards.push(h('div', { class: 'card' }, [h('h2', {}, 'Set a PIN'), h('p', { class: 'muted' }, 'A new PIN is made here and shown once. Send it from your own WhatsApp.'), sel,
        h('div', { class: 'btns' }, confirmButton('Create new PIN', '', function () { return sel.value ? 'Tap again: ' + sel.options[sel.selectedIndex].text + '’s old PIN will stop working' : 'Choose a person first'; }, function () {
          if (!sel.value) return Promise.resolve();
          var pin = String(1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000));
          var name = sel.options[sel.selectedIndex].text;
          return run(api('setPin', { personId: sel.value, pin: pin }), 'PIN set.').then(function () {
            var textMsg = 'GJ Leave & Attendance\nName: ' + name + '\nPIN: ' + pin + '\nOpen: ' + location.origin + location.pathname;
            out.replaceChildren(h('div', { class: 'result green' }, name + ': ' + pin), h('p', { class: 'muted', style: 'margin-top:6px' }, 'Shown once. It is not stored in readable form.'),
              h('div', { class: 'btns' }, h('a', { href: 'https://wa.me/?text=' + encodeURIComponent(textMsg), target: '_blank', rel: 'noopener' }, h('button', { type: 'button' }, 'Open WhatsApp with this message'))));
          });
        })), out]));
    }
    if (window.GJMenu) cards.push(window.GJMenu());
    cards.push(h('div', { class: 'card' }, [h('h2', {}, 'Account'), h('p', {}, state.me.name + ' · ' + state.me.group),
      h('div', { class: 'btns' }, button('Sign out', 'danger', function () { return signOut().then(viewLogin); }))]));
    show(cards);
  };

  // A screen is drawn only while it is the screen the person is on: an action that finishes after
  // they moved to another tab must not paint over that tab.
  ['home', 'apply', 'month', 'approve'].forEach(function (name) {
    var fn = VIEWS[name];
    VIEWS[name] = function (arg) { if (state.tab !== name || state.sub) return; return fn(arg); };
  });

  // ---------- start ----------
  function start() {
    return api('me').then(function (me) { state.me = me; state.offset = me.serverTime - Date.now(); try { sessionStorage.removeItem('gjleave.reloaded'); } catch (e) { /* fine */ } go('home'); }, function (e) { if (e.code !== 'AUTH') viewLogin(e.message); });
  }
  window.GJApp = { h: h, show: show, toast: toast, api: api, run: run, button: button, confirmButton: confirmButton, whenOf: whenOf, state: state, VIEWS: VIEWS, go: go, drawTabs: drawTabs,
    niceDate: niceDate, niceDates: niceDates, timeOf: timeOf, todayStr: todayStr, addDays: addDays, statusChip: statusChip, MON: MON, RULE_TEXT: RULE_TEXT, position: position };
  try { if (navigator.serviceWorker && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js'); } catch (e) { /* the app works without it */ }
  function boot() { if (state.session.deviceToken) start(); else viewLogin(); }
  if (BROKEN) show([h('h1', {}, 'GJ Leave & Attendance'), h('div', { class: 'card' }, [h('p', {}, 'The app could not load completely. Check your internet connection, close the app and open it again.'), h('p', { class: 'muted' }, 'Nothing was saved. If this stays, tell Varun.')])]);
  else if (DEMO) { var s = document.createElement('script'); s.src = 'mock-server.js'; s.onload = boot; document.body.appendChild(s); } else boot();
})();
