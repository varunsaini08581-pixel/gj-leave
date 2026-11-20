// Demo boot: sample roster in memory, every PIN 1234. NOT used when a real API_URL is set.
(function (root) {
  'use strict';
  var data = {};
  Object.keys(root.GJSchema.TABS).forEach(function (t) { data[t] = []; });
  var db = {
    rows: function (tab) { return data[tab]; },
    insert: function (tab, obj) { data[tab].push(JSON.parse(JSON.stringify(obj))); },
    update: function (tab, id, patch) {
      var key = root.GJSchema.TABS[tab][0];
      var row = data[tab].filter(function (r) { return r[key] === id; })[0];
      Object.assign(row, JSON.parse(JSON.stringify(patch)));
    }
  };
  var n = 0;
  var env = {
    sha256: function (s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return 'demo' + h.toString(16); }, // demo only, not secure
    randomId: function () { return 'd' + (++n) + Math.random().toString(36).slice(2, 10); },
    withLock: function (fn) { return fn(); }
  };
  [['Neha', 'Sales', 'staff', '09:30', '18:30', [3, 4]], ['Vikas', 'Sales', 'staff', '11:00', '20:00', [1, 2]], ['Harsh', 'Sales', 'staff', '10:30', '19:30', [1, 2]],
    ['Raunak', 'Repairing', 'staff', '10:30', '19:30', [1, 2]], ['Manish', 'Repairing', 'staff', '09:30', '18:30', [3, 4]], ['Muskan', 'Testing', 'staff', '10:45', '19:45', []],
    ['Bhawna', 'Calls', 'staff', '09:30', '18:30', [3, 4]], ['Pooja', 'Calls', 'staff', '10:00', '19:00', [1, 2]], ['Anita', 'Housekeeping', 'staff', '09:30', '17:30', 'every'],
    ['Aakash', 'Manager', 'manager', '10:00', '19:00', []], ['Varun', 'Owner', 'owner', '10:00', '19:00', []]
  ].forEach(function (p) {
    var id = p[0].toLowerCase();
    db.insert('People', { id: id, name: p[0], group: p[1], role: p[2], dutyStart: p[3], dutyEnd: p[4], sundayOff: p[5], noApproval: p[0] === 'Muskan',
      noClash: p[0] === 'Muskan' || p[0] === 'Anita', noQuota: p[0] === 'Muskan', dressExempt: p[0] === 'Anita', active: true,
      pinSalt: 's', pinHash: env.sha256('s:1234'), pinTries: 0, pinLockedUntil: 0 });
    if (p[2] === 'staff') db.insert('PayInfo', { personId: id, fixedSalary: 17000, targetAllowance: 2000, disciplineBonus: 500, dutyHours: 9 }); // sample figure from the handoff example
  });
  root.GJMock = {
    data: data,
    handle: function (request) { return JSON.parse(JSON.stringify(root.GJApi.handle({ db: db, now: Date.now(), env: env }, request))); },
    approveDevices: function () { data.Devices.forEach(function (d) { if (d.status === 'pending') d.status = 'approved'; }); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
