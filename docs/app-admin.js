/* GJ Leave & Attendance - screens for Aakash and Varun, plus the shared "Today at GJ" and notifications. */
(function () {
  'use strict';
  var A = window.GJApp, h = A.h, api = A.api, run = A.run, button = A.button, show = A.show, toast = A.toast, V = A.VIEWS, state = A.state;
  function open(name, arg) { state.tab = 'more'; A.drawTabs(); show(h('p', { class: 'muted' }, 'Loading…')); V[name](arg); }
  function back() { return button('‹ Back', 'small', function () { A.go('more'); }); }
  function field(label, el) { return h('div', {}, [h('label', {}, label), el]); }
  function dur(m) { return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; }
  function month() { return A.todayStr().slice(0, 7); }
  function prevMonth(m) { var y = +m.slice(0, 4), n = +m.slice(5) - 1; if (n < 1) { n = 12; y -= 1; } return y + '-' + (n < 10 ? '0' + n : n); }
  function nextMonth(m) { var y = +m.slice(0, 4), n = +m.slice(5) + 1; if (n > 12) { n = 1; y += 1; } return y + '-' + (n < 10 ? '0' + n : n); }
  function monthName(m) { return A.MON[+m.slice(5) - 1] + ' ' + m.slice(0, 4); }
  function monthNav(m, fn) {
    return h('div', { class: 'btns', style: 'margin:0 0 12px' }, [button('‹ ' + monthName(prevMonth(m)), 'small', function () { fn(prevMonth(m)); }), button(monthName(nextMonth(m)) + ' ›', 'small', function () { fn(nextMonth(m)); })]);
  }

  // A photo is fetched through the API (private Drive folder), never by a public link.
  window.GJPhoto = function (id) {
    if (!id) return null;
    var img = h('img', { alt: 'Check-in photo', style: 'width:100%;border-radius:10px;margin-top:8px;background:#e7ebf3;min-height:60px' });
    api('photo', { id: id }).then(function (r) { img.src = r.data; }).catch(function () { img.replaceWith(h('div', { class: 'muted' }, 'Photo not available.')); });
    return img;
  };

  // ---------- menu on the More tab ----------
  window.GJMenu = function () {
    var role = state.me.role, items = [['Today at GJ', 'gj'], ['Notifications', 'notes']];
    if (role !== 'staff') items = items.concat([['Record a violation / incident', 'incident'], ['Enter leave for a staff member', 'enter'], ['Enter a check-in (phone or camera problem)', 'manualin'], ['Enter a forgotten check-out', 'manualout'], ['Calendar', 'calendar'],
      ['Month report', 'report'], ['Restrictions (blackout dates)', 'restrictions'], ['Set shop location', 'shop']]);
    if (role === 'owner') items = items.concat([['Disputes', 'disputes'], ['Override a rule (leave)', 'override'], ['People, duty times and pay', 'people'], ['Phones', 'phones'], ['Clash rules', 'rules'], ['Shop-closed days', 'closed'], ['Grace table', 'grace']]);
    return h('div', { class: 'card' }, [h('h2', {}, 'Menu'), h('ul', { class: 'list' }, items.map(function (it) {
      return h('li', {}, button(it[0], 'small', function () { open(it[1]); }));
    }))]);
  };

  // ---------- board on the Today tab (Aakash / Varun) ----------
  window.GJBoard = function () {
    var card = h('div', { class: 'card' }, [h('h2', {}, 'Shop today'), h('p', { class: 'muted' }, 'Loading…')]);
    api('board').then(function (b) {
      var cls = { 'In': 'green', 'On leave': 'blue', 'Roster off': 'blue', 'Checked out': 'blue', 'Out right now': 'amber', 'Not in yet': 'amber', 'Not in yet – late': 'red' };
      card.replaceChildren(h('h2', {}, 'Shop today'), h('ul', { class: 'list' }, b.people.map(function (p) {
        var detail = p.checkInAt ? 'In ' + A.timeOf(p.checkInAt) + (p.lateMinutes > 10 ? ' · ' + dur(p.lateMinutes) + ' late' : '') + (p.checkOutAt ? ' · out ' + A.timeOf(p.checkOutAt) : '')
          : p.state.indexOf('late') !== -1 ? dur(p.lateMinutes) + ' past ' + p.dutyStart : 'Duty ' + p.dutyStart;
        if (p.outSince) detail += ' · out since ' + A.timeOf(p.outSince);
        if (p.halfDay) detail += ' · half day from ' + p.halfDay;
        if (p.flag) detail += ' · flag: ' + p.flag.replace(/-/g, ' ');
        return h('li', {}, [h('div', { class: 'row' }, [h('strong', {}, p.name), h('span', { class: 'chip ' + (cls[p.state] || 'amber') }, p.state)]), h('div', { class: 'muted' }, p.group + ' · ' + detail)]);
      })));
    }).catch(function () {});
    return card;
  };

  // ---------- shared ----------
  V.gj = function () {
    run(api('todayAtGJ')).then(function (list) {
      show([back(), h('h1', {}, 'Today at GJ'), h('p', { class: 'sub' }, 'Today’s check-ins, visible to everyone.'),
        h('div', { class: 'card' }, list.length ? h('ul', { class: 'list' }, list.map(function (x) {
          return h('li', {}, [h('div', { class: 'row' }, [h('strong', {}, x.name), h('span', {}, A.timeOf(x.at))]), window.GJPhoto ? window.GJPhoto(x.photoId) : null]);
        })) : h('p', { class: 'muted' }, 'Nobody has checked in yet.'))]);
    }).catch(function () {});
  };
  V.notes = function () {
    run(api('notifications')).then(function (list) {
      show([back(), h('h1', {}, 'Notifications'), h('div', { class: 'card' }, list.length ? h('ul', { class: 'list' }, list.slice().reverse().map(function (n) {
        return h('li', {}, [h('strong', {}, n.title), n.body ? h('div', { class: 'muted', style: 'white-space:pre-line' }, n.body) : null, h('div', { class: 'muted' }, A.timeOf(n.createdAt))]);
      })) : h('p', { class: 'muted' }, 'Nothing yet.'))]);
    }).catch(function () {});
  };

  // ---------- incidents ----------
  V.incident = function () {
    run(api('incidentItems')).then(function (d) {
      var who = h('select', {}, d.people.map(function (p) { return h('option', { value: p.id }, p.name); }));
      var item = h('select', {}, d.items.map(function (g) { return h('option', { value: g.key }, g.item + ' (grace ' + (g.grace || 'none') + (g.grace ? ' / ' + g.per : '') + ')'); }));
      var note = h('textarea', { placeholder: 'What happened (required unless there is a photo)', maxlength: 300 }), date = h('input', { type: 'date', value: A.todayStr(), max: A.todayStr() });
      var out = h('div', {});
      show([back(), h('h1', {}, 'Record an incident'), h('p', { class: 'sub' }, 'Inside the grace number it is only noted. Beyond it, it becomes a violation.'),
        h('div', { class: 'card' }, [field('Staff member', who), field('Item', item), field('Date', date), field('Note', note),
          h('div', { class: 'btns' }, button('Record', 'primary', function () {
            return run(api('recordIncident', { personId: who.value, item: item.value, note: note.value, date: date.value })).then(function (r) {
              out.replaceChildren(h('div', { class: 'result ' + (r.result === 'violation' ? 'red' : 'green') }, r.result === 'violation' ? 'Violation recorded (' + r.count + ' this period, grace ' + r.grace + ').' : 'Noted, within grace (' + r.count + ' of ' + r.grace + ').'));
              note.value = '';
            });
          })), out])]);
    }).catch(function () {});
  };

  V.manualin = function () {
    run(api('incidentItems')).then(function (d) {
      var who = h('select', {}, d.people.map(function (p) { return h('option', { value: p.id }, p.name); })), time = h('input', { type: 'time' }), why = h('input', { placeholder: 'Why could the person not check in?', maxlength: 120 }), out = h('div', {});
      show([back(), h('h1', {}, 'Enter a check-in'), h('p', { class: 'sub' }, 'Only when the phone or camera failed. It is labelled "entered by ' + state.me.name + '" and has no photo.'),
        h('div', { class: 'card' }, [field('Staff member', who), field('Arrival time today', time), field('Reason', why), h('div', { class: 'btns' }, button('Save check-in', 'primary', function () {
          return run(api('manualCheckIn', { personId: who.value, time: time.value, reason: why.value })).then(function (r) { out.replaceChildren(h('div', { class: 'result green' }, 'Saved. ' + (r.lateMinutes > 10 ? r.lateMinutes + ' min late.' : 'On time.'))); });
        })), out])]);
    }).catch(function () {});
  };

  V.manualout = function () {
    run(api('incidentItems')).then(function (d) {
      var who = h('select', {}, d.people.map(function (p) { return h('option', { value: p.id }, p.name); })), date = h('input', { type: 'date', value: A.todayStr(), max: A.todayStr() }),
        time = h('input', { type: 'time' }), why = h('input', { placeholder: 'Why is it entered by hand?', maxlength: 120 }), out = h('div', {});
      show([back(), h('h1', {}, 'Enter a forgotten check-out'), h('p', { class: 'sub' }, 'When someone left without checking out. It is labelled "entered by ' + state.me.name + '".'),
        h('div', { class: 'card' }, [field('Staff member', who), field('Date', date), field('Time the person left', time), field('Reason', why), h('div', { class: 'btns' }, button('Save check-out', 'primary', function () {
          return run(api('manualCheckOut', { personId: who.value, date: date.value, time: time.value, reason: why.value })).then(function (r) { out.replaceChildren(h('div', { class: 'result green' }, 'Saved. ' + (r.earlyMinutes > 0 ? r.earlyMinutes + ' min before duty end.' : 'After duty end.'))); });
        })), out])]);
    }).catch(function () {});
  };

  // ---------- shop-closed days (owner) ----------
  V.closed = function () {
    run(api('getSettings')).then(function (s) {
      var list = []; try { list = JSON.parse(s.settings.closedDays || '[]') || []; } catch (e) { list = []; }
      list.sort();
      var day = h('input', { type: 'date' });
      function save(next) { return run(api('setSetting', { key: 'closedDays', value: next }), 'Saved.').then(V.closed); }
      show([back(), h('h1', {}, 'Shop-closed days'), h('p', { class: 'sub' }, 'Days the whole shop is closed (festival, shutdown). Nobody is marked absent, and a leave on such a day uses no quota, also when the day is added later.'),
        h('div', { class: 'card' }, [field('Add a closed day', day), h('div', { class: 'btns' }, button('Add', 'primary', function () {
          if (!day.value) { A.toast('Pick a date.'); return Promise.resolve(); }
          return save(list.indexOf(day.value) === -1 ? list.concat([day.value]) : list);
        }))]),
        h('div', { class: 'card' }, list.length ? h('ul', { class: 'list' }, list.map(function (d) {
          return h('li', {}, h('div', { class: 'row' }, [h('strong', {}, A.niceDate(d)), button('Remove', 'small', function () { return save(list.filter(function (x) { return x !== d; })); })]));
        })) : h('p', { class: 'muted' }, 'No closed days.'))]);
    }).catch(function () {});
  };

  // ---------- phones (owner) ----------
  V.phones = function () {
    run(api('devices')).then(function (list) {
      var live = list.filter(function (d) { return d.status === 'approved' || d.status === 'pending'; });
      show([back(), h('h1', {}, 'Phones'), h('p', { class: 'sub' }, 'One approved phone per person. Remove a phone when it is lost, sold or the person has left. A removed phone can never sign in again.'),
        h('div', { class: 'card' }, live.length ? h('ul', { class: 'list' }, live.map(function (d) {
          return h('li', {}, [h('div', { class: 'row' }, [h('strong', {}, d.name), h('span', { class: 'chip ' + (d.status === 'approved' ? 'green' : 'amber') }, d.status === 'approved' ? 'Approved' : 'Waiting')]),
            h('div', { class: 'muted' }, (d.label || 'Phone') + ' · asked ' + A.niceDate(new Date(d.requestedAt + 19800000).toISOString().slice(0, 10))),
            d.status === 'approved' ? h('div', { class: 'btns' }, button('Remove this phone', 'danger', function () { return run(api('decideDevice', { id: d.id, approve: false }), 'Phone removed.').then(V.phones); })) : null]);
        })) : h('p', { class: 'muted' }, 'No phones yet.'))]);
    }).catch(function () {});
  };

  // ---------- leave form for someone else (Aakash entry, or Varun override) ----------
  function leaveFor(title, sub, action, extra) {
    run(api('incidentItems')).then(function (d) {
      var people = d.people.slice();
      var who = h('select', {}, people.map(function (p) { return h('option', { value: p.id }, p.name); }));
      var from = h('input', { type: 'date', value: A.todayStr() }), to = h('input', { type: 'date', value: A.todayStr() });
      var kind = h('select', {}, [h('option', { value: 'full' }, 'Full day(s)'), h('option', { value: 'half' }, 'Half day')]), half = h('input', { type: 'time', value: '09:30' });
      var reason = h('select', {}, state.me.reasons.map(function (r) { return h('option', { value: r }, r); })), text = h('textarea', { placeholder: 'Reason, for example "Called – emergency"', maxlength: 200 });
      var called = extra ? null : h('input', { type: 'time' });
      var over = extra ? h('textarea', { placeholder: 'Why are you overriding the rule? (required, shown in the month report)', maxlength: 300 }) : null, out = h('div', {});
      function dates() { var a = []; for (var x = from.value; x && x <= (kind.value === 'half' ? from.value : to.value) && a.length < 62; x = A.addDays(x, 1)) a.push(x); return a; }
      show([back(), h('h1', {}, title), h('p', { class: 'sub' }, sub), h('div', { class: 'card' }, [field('Staff member', who), field('Type', kind), field('First day', from), field('Last day', to),
        field('Half day starts at', half), field('Reason', reason), text, called ? field('If the person phoned: time of the call (notice is counted from it)', called) : null, over ? field('Override reason', over) : null,
        h('div', { class: 'btns' }, button(extra ? 'Approve with override' : 'Enter request', 'primary', function () {
          return run(api(action, { forPersonId: who.value, kind: kind.value, dates: dates(), halfStart: kind.value === 'half' ? half.value : '', reasonCode: reason.value, reasonText: text.value, calledAt: called && called.value ? called.value : undefined, overrideReason: over ? over.value : undefined }))
            .then(function (r) { out.replaceChildren(h('div', { class: 'result green' }, 'Saved: ' + r.status + '. Labelled "entered by ' + state.me.name + '".')); });
        })), out])]);
    }).catch(function () {});
  }
  V.enter = function () { leaveFor('Enter leave for staff', 'Use this when the app was down or the person called. Every rule still applies.', 'submitLeave', false); };
  V.override = function () { leaveFor('Override a rule', 'Only you can do this. It skips the clash and restriction rules, is logged, and shows in the month report.', 'overrideLeave', true); };

  // ---------- calendar ----------
  V.calendar = function (m) {
    m = m || month();
    run(api('calendar', { month: m })).then(function (c) {
      var rows = c.days.map(function (d) {
        var names = d.entries.map(function (e) { return e.name + (e.kind === 'roster' ? ' (roster)' : e.kind === 'half' ? ' (half)' : '') + (e.status && e.status !== 'Approved' && e.status !== 'Recorded' ? ' [' + e.status + ']' : ''); });
        var li = h('li', { style: d.risk.length ? 'background:#fde8e8;margin:0 -8px;padding:10px 8px;border-radius:8px' : '' }, [
          h('div', { class: 'row' }, [h('strong', {}, A.niceDate(d.date) + (d.sunday ? ' · Sunday ' + d.sunday : '')), d.risk.length ? h('span', { class: 'chip red' }, 'Clash risk: ' + d.risk.join(', ')) : null]),
          names.length ? h('div', { class: 'muted' }, names.join(', ')) : null]);
        d.restrictions.forEach(function (r) { li.appendChild(h('div', { class: 'chip amber', style: 'margin-top:4px' }, 'Restricted: ' + r.note)); });
        return li;
      });
      show([back(), h('h1', {}, 'Calendar'), h('p', { class: 'sub' }, monthName(m) + ' · red days: a group is at its minimum, the next request will be refused.'), monthNav(m, V.calendar), h('div', { class: 'card' }, h('ul', { class: 'list' }, rows))]);
    }).catch(function () {});
  };

  // ---------- month report ----------
  V.report = function (m) {
    m = m || month();
    run(api('monthReport', { month: m })).then(function (r) {
      var cards = [back(), h('h1', {}, 'Month report'), h('p', { class: 'sub' }, monthName(m) + (r.locked ? ' · Locked' : ' · Live, not locked')), monthNav(m, V.report)];
      r.people.forEach(function (p) {
        cards.push(h('div', { class: 'card' }, [h('div', { class: 'row' }, [h('strong', {}, p.name), h('span', { class: 'chip ' + (p.ladder.notice ? 'red' : p.ladder.bonusLost ? 'amber' : 'green') }, p.ladder.violations + ' violation(s)')]),
          h('p', { class: 'muted' }, 'Leaves ' + p.leaves.total + ' / ' + p.leaves.free + ' · Emergencies ' + p.leaves.emergencies + ' · Bank used ' + p.bank.used + ' min' + (p.bank.beyond ? ' (+' + p.bank.beyond + ' beyond)' : '')),
          p.wouldBeDeducted ? h('p', {}, (p.onPayroll ? 'Would be deducted (estimate): Rs ' : 'If on payroll: Rs ') + p.wouldBeDeducted.total) : null,
          p.wouldBeDeducted && p.wouldBeDeducted.lines.length ? h('ul', { class: 'list' }, p.wouldBeDeducted.lines.map(function (l) { return h('li', { class: 'muted' }, l); })) : null,
          r.locked ? null : button('Open ' + p.name + '’s month', 'small', function () { state.tab = 'month'; A.drawTabs(); V.month(p.personId); })]));
      });
      if (r.overrides.length) cards.push(h('div', { class: 'card' }, [h('h2', {}, 'Overrides by Varun'), h('ul', { class: 'list' }, r.overrides.map(function (o) { return h('li', {}, o.personId + ': ' + o.dates.join(', ') + ' — ' + o.reason); }))]));
      if (r.locked) {
        var who = h('select', {}, r.people.map(function (p) { return h('option', { value: p.personId }, p.name); })), note = h('textarea', { placeholder: 'Correction (a new logged entry; the locked result does not change)' });
        cards.push(h('div', { class: 'card' }, [h('h2', {}, 'Corrections'), r.corrections.length ? h('ul', { class: 'list' }, r.corrections.map(function (c) { return h('li', {}, c.name + ': ' + c.note + ' (' + c.by + ')'); })) : h('p', { class: 'muted' }, 'None.'),
          who, h('div', { style: 'height:8px' }), note, h('div', { class: 'btns' }, button('Add correction', '', function () { return run(api('addCorrection', { month: m, personId: who.value, note: note.value }), 'Added.').then(function () { V.report(m); }); }))]));
      } else if (m < month()) {
        var done = r.lockConfirmedBy || [];
        cards.push(h('div', { class: 'card' }, [h('p', {}, 'This month has ended. Aakash and Varun both confirm the report; then it is locked. Locking freezes the result; later changes become logged corrections.'),
          done.length ? h('p', { class: 'muted' }, 'Confirmed by ' + done.join(', ') + '. Waiting for the other approver.') : null,
          button((done.length ? 'Confirm and lock ' : 'Confirm ') + monthName(m), 'primary', function () {
            return run(api('lockMonth', { month: m })).then(function (x) { A.toast(x.locked ? 'Locked.' : 'Confirmed. Waiting for ' + x.waitingFor.join(' / ') + '.'); V.report(m); });
          })]));
      }
      cards.push(h('p', { class: 'muted' }, 'Estimate as per company rules. Final salary is decided by management.'));
      show(cards);
    }).catch(function () {});
  };

  // ---------- restrictions ----------
  V.restrictions = function () {
    run(api('restrictions')).then(function (d) {
      var from = h('input', { type: 'date' }), to = h('input', { type: 'date' }), note = h('input', { placeholder: 'For example: Peak sales season', maxlength: 80 });
      var rule = h('select', {}, [h('option', { value: 'no-leave' }, 'No leave'), h('option', { value: 'violation' }, 'Leave allowed, counts as 1 violation')]);
      var ticks = d.people.map(function (n) { var cb = h('input', { type: 'checkbox', style: 'width:auto;min-height:0;margin-right:8px' }); cb.checked = n !== 'Anita' && n !== 'Muskan'; return { name: n, cb: cb }; });
      var cards = [back(), h('h1', {}, 'Restrictions'), h('p', { class: 'sub' }, 'Blackout dates. They show on the apply form before dates are picked.')];
      cards.push(h('div', { class: 'card' }, [h('h2', {}, 'New restriction'), field('From', from), field('To', to), field('Note', note), field('Rule', rule), h('label', {}, 'Applies to'),
        h('div', {}, ticks.map(function (t) { return h('label', { style: 'font-weight:400;margin:6px 0' }, [t.cb, t.name]); })),
        h('div', { class: 'btns' }, button('Add restriction', 'primary', function () {
          return run(api('saveRestriction', { from: from.value, to: to.value, note: note.value, rule: rule.value, appliesTo: ticks.filter(function (t) { return t.cb.checked; }).map(function (t) { return t.name; }) }), 'Added.').then(V.restrictions);
        }))]));
      d.list.slice().reverse().forEach(function (r) {
        cards.push(h('div', { class: 'card' }, [h('div', { class: 'row' }, [h('strong', {}, A.niceDate(r.from) + ' – ' + A.niceDate(r.to)), h('span', { class: 'chip ' + (r.on === false ? 'blue' : 'amber') }, r.on === false ? 'Off' : 'On')]),
          h('p', {}, r.note + ' · ' + (r.rule === 'no-leave' ? 'No leave' : 'Leave = 1 violation')), h('p', { class: 'muted' }, 'Applies to: ' + (r.appliesTo ? r.appliesTo.join(', ') : 'all staff except Anita and Muskan')),
          button(r.on === false ? 'Switch on' : 'Switch off', 'small', function () { return run(api('saveRestriction', Object.assign({}, r, { on: r.on === false })), 'Saved.').then(V.restrictions); })]));
      });
      show(cards);
    }).catch(function () {});
  };

  // ---------- shop location ----------
  V.shop = function () {
    var out = h('div', {});
    show([back(), h('h1', {}, 'Set shop location'), h('p', { class: 'sub' }, 'Stand inside the shop. The app reads the location for a few seconds and saves the average. Check-ins more than about 50 m away are flagged.'),
      h('div', { class: 'card' }, [button('Set shop location now', 'primary', function () {
        var samples = [], i = 0;
        function next() {
          return A.position().then(function (p) { if (p.lat !== undefined) samples.push(p); out.replaceChildren(h('p', { class: 'muted' }, 'Reading ' + (++i) + ' of 5…')); if (i < 5) return new Promise(function (ok) { setTimeout(ok, 1200); }).then(next); });
        }
        return next().then(function () { return run(api('setShopPoint', { samples: samples })); }).then(function (r) {
          out.replaceChildren(h('div', { class: 'result green' }, 'Saved: ' + r.lat.toFixed(5) + ', ' + r.lng.toFixed(5) + ' (' + samples.length + ' readings).'));
        });
      }), out, h('p', { class: 'muted', style: 'margin-top:10px' }, 'Indoor phone location can be off by 20–100 m. The check-in photo is the stronger proof.')])]);
  };

  // ---------- owner: disputes ----------
  V.disputes = function () {
    run(api('disputes')).then(function (list) {
      var cards = [back(), h('h1', {}, 'Disputes'), h('p', { class: 'sub' }, list.length ? list.length + ' open' : 'No open disputes.')];
      list.forEach(function (v) {
        var note = h('input', { placeholder: 'Your decision note (required)', maxlength: 200 });
        cards.push(h('div', { class: 'card' }, [h('strong', {}, v.name + ' · ' + A.niceDate(v.date)), h('p', {}, (A.RULE_TEXT[v.rule] || v.rule) + (v.note ? ' — ' + v.note : '')), h('p', { class: 'muted' }, 'Says: ' + v.text), note,
          h('div', { class: 'btns' }, [button('Uphold', '', function () { return run(api('decideDispute', { id: v.id, uphold: true, note: note.value }), 'Upheld.').then(V.disputes); }),
            button('Remove violation', 'good', function () { return run(api('decideDispute', { id: v.id, uphold: false, note: note.value }), 'Removed.').then(V.disputes); })])]));
      });
      show(cards);
    }).catch(function () {});
  };

  // ---------- owner: people, duty, pay ----------
  V.people = function () {
    run(api('getSettings')).then(function (s) {
      var cards = [back(), h('h1', {}, 'People, duty times and pay'), h('p', { class: 'sub' }, 'Only you can see and change this. Every change is logged. Salary is used only for the estimate.'),
        button('Add a new person', '', function () { personForm(null); })];
      s.people.forEach(function (p) {
        cards.push(h('div', { class: 'card' }, [h('div', { class: 'row' }, [h('strong', {}, p.name), h('span', { class: 'chip ' + (p.active === false ? 'red' : 'green') }, p.active === false ? 'Inactive' : p.role)]),
          h('p', { class: 'muted' }, p.group + ' · ' + p.dutyStart + '–' + p.dutyEnd + ' · Sunday off: ' + (p.sundayOff === 'every' ? 'every' : (p.sundayOff || []).join(', ') || 'none') + (p.hasPin ? '' : ' · no PIN yet')),
          h('p', { class: 'muted' }, p.pay ? 'Fixed Rs ' + p.pay.fixedSalary + ' · Target allowance Rs ' + p.pay.targetAllowance + ' · Discipline bonus Rs ' + p.pay.disciplineBonus + ' · ' + p.pay.dutyHours + ' h' : 'Salary structure not entered'),
          h('div', { class: 'btns' }, [button('Edit', 'small', function () { personForm(p); }), button('Salary structure', 'small', function () { payForm(p); })])]));
      });
      show(cards);
    }).catch(function () {});
  };
  function personForm(p) {
    p = p || { name: '', group: 'Sales', role: 'staff', dutyStart: '10:00', dutyEnd: '19:00', sundayOff: [1, 2], active: true };
    var name = h('input', { value: p.name }), group = h('input', { value: p.group }), role = h('select', {}, ['staff', 'manager', 'owner'].map(function (r) { return h('option', { value: r }, r); }));
    var ds = h('input', { type: 'time', value: p.dutyStart }), de = h('input', { type: 'time', value: p.dutyEnd }), email = h('input', { type: 'email', value: p.email || '', placeholder: 'For email alerts (optional)' }), phone = h('input', { value: p.phone || '', inputmode: 'numeric' });
    var sun = h('select', {}, [['[1,2]', '1st and 2nd Sunday'], ['[3,4]', '3rd and 4th Sunday'], ['[]', 'No Sunday off'], ['"every"', 'Every Sunday']].map(function (o) { return h('option', { value: o[0] }, o[1]); }));
    role.value = p.role; sun.value = JSON.stringify(p.sundayOff);
    function tick(label, key) { var cb = h('input', { type: 'checkbox', style: 'width:auto;min-height:0;margin-right:8px' }); cb.checked = key === 'active' ? p.active !== false : !!p[key]; return { key: key, cb: cb, el: h('label', { style: 'font-weight:400;margin:6px 0' }, [cb, label]) }; }
    var ticks = [tick('Active', 'active'), tick('No approval needed (recorded only)', 'noApproval'), tick('Clash rules do not block this person', 'noClash'), tick('Not on payroll (no quota or deduction)', 'noQuota'), tick('Exempt from the dress check', 'dressExempt')];
    show([button('‹ Back', 'small', function () { open('people'); }), h('h1', {}, p.id ? 'Edit ' + p.name : 'New person'),
      h('div', { class: 'card' }, [field('Name', name), field('Group', group), field('Role', role), field('Duty start', ds), field('Duty end', de), field('Sunday off', sun), field('Email', email), field('Phone', phone)].concat(ticks.map(function (t) { return t.el; })).concat([
        h('div', { class: 'btns' }, button('Save', 'primary', function () {
          var body = { id: p.id, name: name.value, group: group.value, role: role.value, dutyStart: ds.value, dutyEnd: de.value, sundayOff: JSON.parse(sun.value), email: email.value, phone: phone.value };
          ticks.forEach(function (t) { body[t.key] = t.cb.checked; });
          return run(api('savePerson', body), 'Saved.').then(function () { open('people'); });
        }))]))]);
  }
  function payForm(p) {
    var pay = p.pay || { fixedSalary: '', targetAllowance: '', disciplineBonus: 500, dutyHours: 9 };
    function num(v) { return h('input', { type: 'number', inputmode: 'numeric', value: v }); }
    var a = num(pay.fixedSalary), b = num(pay.targetAllowance), c = num(pay.disciplineBonus), d = num(pay.dutyHours);
    show([button('‹ Back', 'small', function () { open('people'); }), h('h1', {}, p.name + ': salary structure'), h('p', { class: 'sub' }, 'Visible only to you, Aakash and ' + p.name + '. Used only for the "would be deducted" estimate.'),
      h('div', { class: 'card' }, [field('Fixed salary (Rs per month)', a), field('Target allowance (Rs)', b), field('Discipline bonus (Rs)', c), field('Duty hours per day', d),
        h('div', { class: 'btns' }, button('Save', 'primary', function () { return run(api('setPay', { personId: p.id, fixedSalary: a.value, targetAllowance: b.value, disciplineBonus: c.value, dutyHours: d.value }), 'Saved.').then(function () { open('people'); }); }))])]);
  }

  // ---------- owner: clash rules, grace table ----------
  V.rules = function () {
    run(api('getSettings')).then(function (s) {
      var cards = [back(), h('h1', {}, 'Clash rules'), h('p', { class: 'sub' }, 'Hard rules: a clashing request cannot be sent. Switching a rule off or on is logged.')];
      s.rules.forEach(function (r) {
        cards.push(h('div', { class: 'card' }, [h('div', { class: 'row' }, [h('strong', {}, r.id + ' · ' + r.label), h('span', { class: 'chip ' + (r.on === false ? 'blue' : 'green') }, r.on === false ? 'Off' : 'On')]),
          h('p', {}, 'At least ' + r.minPresent + ' present of: ' + r.members.join(', ')),
          r.rosterSundayException ? h('p', { class: 'muted' }, 'Sunday exception: roster alone is allowed on Sunday ' + r.rosterSundayException.join(' and ')) : null,
          r.emergencyIfAllPresent ? h('p', { class: 'muted' }, 'Extreme emergency allowed only if present: ' + r.emergencyIfAllPresent.join(' and ')) : null,
          button(r.on === false ? 'Switch on' : 'Switch off', 'small', function () { return run(api('saveRule', Object.assign({}, r, { on: r.on === false })), 'Saved.').then(V.rules); })]));
      });
      show(cards);
    }).catch(function () {});
  };
  V.grace = function () {
    run(api('getSettings')).then(function (s) {
      var rows = s.graceTable.map(function (g) {
        var n = h('input', { type: 'number', inputmode: 'numeric', min: 0, value: g.grace, style: 'max-width:90px' });
        var per = h('select', { style: 'max-width:130px' }, [h('option', { value: 'month' }, 'per month'), h('option', { value: 'quarter' }, 'per quarter')]); per.value = g.per;
        return { g: g, n: n, per: per, el: h('li', {}, [h('strong', {}, g.item), h('div', { class: 'row', style: 'margin-top:6px' }, [n, per])]) };
      });
      show([back(), h('h1', {}, 'Grace table'), h('p', { class: 'sub' }, 'How many times each item is only noted before it becomes a violation. 0 = no grace.'),
        h('div', { class: 'card' }, [h('ul', { class: 'list' }, rows.map(function (r) { return r.el; })), h('div', { class: 'btns' }, button('Save grace table', 'primary', function () {
          return run(api('setSetting', { key: 'graceTable', value: rows.map(function (r) { return Object.assign({}, r.g, { grace: +r.n.value, per: r.per.value }); }) }), 'Saved.');
        }))])]);
    }).catch(function () {});
  };
})();
