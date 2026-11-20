/**
 * Sheet store. Turns tabs of plain-text cells into row objects and back.
 * It talks to a tiny "grid" interface so the same code is tested in Node with a fake grid
 * and runs in Apps Script on the real Sheet:
 *
 *   grid.tabNames() -> [name]
 *   grid.addTab(name)
 *   grid.read(name) -> 2D array of strings (row 0 = headers); [] when empty
 *   grid.append(name, rowArray)
 *   grid.writeRow(name, rowIndex /* 0-based, 0 = headers *\/, rowArray)
 *
 * Rows are never deleted. The first column of every tab is its key.
 */
(function (root) {
  'use strict';
  var Schema = (typeof require !== 'undefined') ? require('./schema.js') : root.GJSchema;
  var Clash = (typeof require !== 'undefined') ? require('../rules/clash.js') : root.GJClash;
  var Cal = (typeof require !== 'undefined') ? require('../rules/calendar.js') : root.GJCalendar;

  function has(list, x) { return list.indexOf(x) !== -1; }

  function encode(tab, col, v) {
    if (v === undefined || v === null) return '';
    if (has(Schema.JSON_COLS[tab] || [], col)) return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    var s = String(v);
    // Text that a spreadsheet could read as a formula is stored with a leading apostrophe
    // (the cells are plain text as well; this is the second lock on the same door).
    return /^[=+\-@']/.test(s) ? "'" + s : s;
  }
  function jsonDefault(col) { var d = Schema.JSON_DEFAULT[col]; return d === undefined ? null : JSON.parse(JSON.stringify(d)); }
  function decode(tab, col, text) {
    var isJson = has(Schema.JSON_COLS[tab] || [], col);
    if (text === '' || text === undefined || text === null) return isJson ? jsonDefault(col) : '';
    text = String(text);
    if (/^'[=+\-@']/.test(text)) text = text.slice(1);
    var trimmed = text.replace(/^\s+|\s+$/g, '');
    if (isJson) {
      try { return JSON.parse(text); } catch (e) { /* typed by hand: understand the plain forms, else the default */ }
      if (col === 'sundayOff' && /^every$/i.test(trimmed)) return 'every';
      if (col === 'dates' && Cal.isDate(trimmed)) return [trimmed];
      return jsonDefault(col);
    }
    if (has(Schema.BOOL_COLS, col)) return trimmed.toUpperCase() === 'TRUE';
    if (has(Schema.NUM_COLS, col)) { var n = Number(trimmed.replace(/,/g, '')); return trimmed === '' || isNaN(n) ? '' : n; }
    return text;
  }
  /** A row the app cannot work with (its dates were damaged by a hand edit). It is left alone and reported. */
  function damaged(tab, obj) {
    if (tab !== 'LeaveRequests') return false;
    return !(Array.isArray(obj.dates) && obj.dates.length && obj.dates.every(Cal.isDate));
  }

  /**
   * Create missing tabs and add missing columns. Safe to run twice: it never removes or
   * reorders anything that exists and never touches data rows.
   */
  function setup(grid, options) {
    var done = [];
    var names = grid.tabNames();
    var trim = function (h) { return String(h).replace(/^\s+|\s+$/g, ''); };
    // Which schema does this Sheet say it has? (0 = a new, empty Sheet.)
    var stored = 0;
    if (has(names, 'Settings')) {
      var st = grid.read('Settings'), kc = st.length ? st[0].map(trim).indexOf('key') : -1, vc = st.length ? st[0].map(trim).indexOf('value') : -1;
      st.slice(1).forEach(function (r) { if (kc !== -1 && r[kc] === 'schemaVersion') stored = Number(r[vc]) || 1; });
    }
    var inUse = stored > 0 || names.some(function (n) { return Schema.TABS[n] && grid.read(n).length > 1; });
    // First look at everything, and refuse before anything is written.
    Object.keys(Schema.TABS).forEach(function (tab) {
      if (!has(names, tab)) {
        if (inUse && (Schema.TAB_SINCE[tab] || 1) <= Math.max(stored, 1)) throw new Error('The "' + tab + '" tab is missing. It was renamed or deleted. Rename it back (or restore it from version history) and run this again. Nothing was changed.');
        return;
      }
      var data = grid.read(tab);
      if (data.length > 1 && !data[0].some(function (h) { return trim(h) !== ''; })) throw new Error('Row 1 of the "' + tab + '" tab (the column names) is empty. Restore it from version history and run this again. Nothing was changed.');
      if (data.length && data[0].some(function (h) { return trim(h) !== ''; }) && !has(data[0].map(trim), Schema.TABS[tab][0]))
        throw new Error('The "' + tab + '" tab has lost its "' + Schema.TABS[tab][0] + '" column. Restore the header row before using the app. Nothing was changed.');
    });
    Object.keys(Schema.TABS).forEach(function (tab) {
      if (!has(names, tab)) { grid.addTab(tab); grid.append(tab, Schema.TABS[tab].slice()); done.push('created ' + tab); return; }
      var data = grid.read(tab);
      if (!data.length) { grid.append(tab, Schema.TABS[tab].slice()); done.push('headers ' + tab); return; }
      var headers = data[0].map(String);
      // A space typed after a column name is repaired in place (never answered with a second, empty column).
      var tidy = headers.map(function (h) { return has(Schema.TABS[tab], trim(h)) ? trim(h) : h; });
      var changed = tidy.some(function (h, i) { return h !== headers[i]; });
      var missing = Schema.TABS[tab].filter(function (c) { return !has(tidy, c); });
      if (changed || missing.length) {
        grid.writeRow(tab, 0, tidy.concat(missing));
        if (changed) done.push('repaired column names in ' + tab);
        if (missing.length) done.push('columns ' + tab + ': ' + missing.join(', '));
      }
    });
    var db = open(grid);
    // The default clash rules are written once. If that first run broke off half-way, the next run adds the ones still
    // missing; after it has completed, a rule the owner deleted is never put back.
    var seeded = db.rows('Settings').some(function (s) { return s.key === 'rulesSeeded'; });
    if (!seeded) {
      var have = {}; db.rows('Rules').forEach(function (r) { have[r.id] = 1; });
      var virgin = !db.rows('Rules').length || !db.rows('Settings').some(function (s) { return s.key === 'schemaVersion'; });
      if (virgin) Clash.DEFAULT_RULES.forEach(function (r) { if (!have[r.id]) { db.insert('Rules', r); if (done.indexOf('seeded Rules') === -1) done.push('seeded Rules'); } });
      db.flush && db.flush();
      db.insert('Settings', { key: 'rulesSeeded', value: 'yes', updatedAt: '', updatedBy: 'setup' });
    }
    var row = db.rows('Settings').filter(function (s) { return s.key === 'schemaVersion'; })[0];
    if (!row) {
      db.insert('Settings', { key: 'schemaVersion', value: String(Schema.SCHEMA_VERSION), updatedAt: '', updatedBy: 'setup' });
      done.push('schemaVersion ' + Schema.SCHEMA_VERSION);
      // A brand-new Sheet remembers the day it was made: nobody is marked absent for days before it.
      if (!inUse && options && options.today && !db.rows('Settings').some(function (s) { return s.key === 'startDate'; })) {
        db.insert('Settings', { key: 'startDate', value: options.today, updatedAt: '', updatedBy: 'setup' });
        done.push('startDate ' + options.today);
      }
    } else if (String(row.value) !== String(Schema.SCHEMA_VERSION)) {
      db.update('Settings', 'schemaVersion', { value: String(Schema.SCHEMA_VERSION), updatedBy: 'setup' });
      done.push('schemaVersion ' + row.value + ' -> ' + Schema.SCHEMA_VERSION);
    }
    return done;
  }

  /**
   * Open a db over the grid. Each tab is read at most once per request and cached.
   *
   * options.buffer = true (used on the real Sheet): inserts and updates are collected and
   * written together by flush() - one write per tab instead of one per row. That is the
   * difference between a 3-second and a 12-second check-in. flush() is called inside the
   * server lock, so nothing is visible to another request half-written.
   * A tab that is only written to in a request (Audit, usually Notifications) is never read in full.
   */
  function open(grid, options) {
    var buffer = !!(options && options.buffer);
    var cache = {};
    function entry(tab) {
      if (!cache[tab]) cache[tab] = { headers: null, rows: null, pending: [], dirty: [], damaged: [] };
      return cache[tab];
    }
    function headersOf(tab) {
      var t = entry(tab);
      if (!t.headers) {
        var h = grid.headers ? grid.headers(tab) : (grid.read(tab)[0] || []);
        t.headers = h && h.length ? h.map(function (x) { return String(x).replace(/^\s+|\s+$/g, ''); }) : Schema.TABS[tab].slice();
      }
      return t.headers;
    }
    function load(tab) {
      var t = entry(tab);
      if (t.rows) return t;
      var data = grid.read(tab);
      t.headers = data.length ? data[0].map(function (x) { return String(x).replace(/^\s+|\s+$/g, ''); }) : Schema.TABS[tab].slice();
      var rows = [];
      for (var i = 1; i < data.length; i++) {
        var obj = {}, empty = true;
        for (var c = 0; c < t.headers.length; c++) {
          var cell = data[i][c];
          if (cell !== '' && cell !== undefined && cell !== null) empty = false;
          obj[t.headers[c]] = decode(tab, t.headers[c], cell);
        }
        if (empty) continue;
        if (damaged(tab, obj)) { t.damaged.push(tab + ' row ' + (i + 1)); continue; }
        Object.defineProperty(obj, '__row', { value: i, enumerable: false, writable: true });
        rows.push(obj);
      }
      t.rows = rows.concat(t.pending); // rows inserted earlier in this request, before the tab was read
      return t;
    }
    function toArray(tab, headers, obj) { return headers.map(function (h) { return encode(tab, h, obj[h]); }); }
    var CELL_MAX = 49000; // a Sheet cell holds 50,000 characters
    function flush() {
      // Nothing is written unless everything can be written: one oversized cell must not leave half an action on the Sheet.
      Object.keys(cache).forEach(function (tab) {
        var t = cache[tab];
        t.pending.concat(t.dirty).forEach(function (r) {
          toArray(tab, t.headers, r).forEach(function (cell) { if (cell.length > CELL_MAX) { discard(); throw new Error('A value is too long to store.'); } });
        });
      });
      try { write(); } catch (e) { try { if (grid.commit) grid.commit({}); } catch (e2) { /* the cache expires by itself */ } discard(); throw e; } // a failed write is never repeated by a second flush
    }
    /** Forget everything read and everything not yet written (after a refused action, and when the server lock is taken). */
    function discard() { cache = {}; if (grid.reset) grid.reset(); }
    /** The header row as it is on the Sheet right now (never a remembered copy). */
    function liveHeaders(tab) {
      var h = grid.liveHeaders ? grid.liveHeaders(tab) : grid.headers ? grid.headers(tab) : (grid.read(tab)[0] || []);
      return h && h.length ? h.map(function (x) { return String(x).replace(/^\s+|\s+$/g, ''); }) : null;
    }
    function same(a, b) { return a.length === b.length && a.every(function (x, i) { return x === b[i]; }); }
    function write() {
      var full = {}, firstRows = {}, batch = [], live = {}, unsure = {};
      // Rows are laid out by the header row the Sheet has NOW. A column the owner inserted by hand,
      // or a header that changed since it was last read, can then never shift a row.
      Object.keys(cache).forEach(function (tab) {
        var t = cache[tab];
        if (!t.pending.length && !t.dirty.length) return;
        if (!t.headers) headersOf(tab);
        live[tab] = liveHeaders(tab) || t.headers;
        if (!same(live[tab], t.headers)) unsure[tab] = true;
      });
      // All appended rows of this request go to the Sheet in ONE step (reads first, then writes),
      // because on the real Sheet every read placed between two writes costs a round trip.
      Object.keys(cache).forEach(function (tab) {
        var t = cache[tab];
        if (t.pending.length) batch.push({ tab: tab, rows: t.pending.map(function (r) { return toArray(tab, live[tab], r); }) });
      });
      // Where does each changed row stand now? (A row deleted or sorted by hand moves the others.)
      var places = [];
      Object.keys(cache).forEach(function (tab) {
        var t = cache[tab], key = Schema.TABS[tab][0], kc = live[tab] ? live[tab].indexOf(key) : -1, fresh = null;
        t.dirty.forEach(function (r) {
          if (!(r.__row > 0)) return;
          var at = r.__row;
          if (grid.readRow && kc !== -1) {
            var now = grid.readRow(tab, at);
            r.__was = now;
            if (!now || String(decode(tab, key, now[kc])) !== String(r[key])) {
              unsure[tab] = true;
              fresh = fresh || (grid.readLive ? grid.readLive(tab) : grid.read(tab));
              at = -1;
              for (var i = 1; i < fresh.length; i++) if (String(decode(tab, key, fresh[i][kc])) === String(r[key])) { at = i; break; }
              if (at === -1) throw new Error('A row of "' + tab + '" is no longer on the Sheet.');
              r.__was = fresh[at];
            }
          }
          // Only the app's own columns are written; whatever else the owner keeps in that row is not touched.
          var cells = [];
          live[tab].forEach(function (h, c) { if (has(Schema.TABS[tab], h) && Object.prototype.hasOwnProperty.call(r, h)) cells[c] = encode(tab, h, r[h]); });
          // What the Sheet holds in these cells now: put back if a later step of this write fails.
          var was = null;
          if (r.__was) { was = []; cells.forEach(function (v, c) { was[c] = r.__was[c] === undefined ? '' : r.__was[c]; }); }
          delete r.__was;
          places.push({ tab: tab, at: at, cells: cells, row: r, was: was });
        });
      });
      // One request is saved whole or not at all, as far as the Sheet allows: changed rows first, new rows
      // (alerts, audit, violations) last; if any step fails, the rows already changed are put back as they were.
      var done = [];
      try {
        places.forEach(function (p) { done.push(p); grid.writeRow(p.tab, p.at, p.cells); }); // listed first: a row written in two pieces may fail half-way
        if (batch.length) {
          if (grid.appendMany) firstRows = grid.appendMany(batch) || {};
          else batch.forEach(function (b) {
            if (grid.appendRows) firstRows[b.tab] = grid.appendRows(b.tab, b.rows);
            else { firstRows[b.tab] = null; b.rows.forEach(function (a) { grid.append(b.tab, a); }); }
          });
        }
      } catch (e) {
        // Put back what was changed, and take out again the new rows that did get in (the tabs are appended one
        // after the other): the action is then saved whole or not at all, and can simply be done again.
        done.forEach(function (p) { if (p.was) { try { grid.writeRow(p.tab, p.at, p.was); } catch (x) { /* the Sheet is down: nothing more can be done here */ } } });
        batch.forEach(function (b) {
          try {
            var key = Schema.TABS[b.tab][0], kc = live[b.tab] ? live[b.tab].indexOf(key) : -1;
            if (kc === -1) return;
            var mine = {}; b.rows.forEach(function (r) { mine[String(r[kc])] = 1; });
            var now = grid.readLive ? grid.readLive(b.tab) : grid.read(b.tab);
            for (var i = now.length - 1; i >= 1 && i >= now.length - b.rows.length - 50; i--) {
              if (now[i] && now[i][kc] !== '' && mine[String(now[i][kc])]) grid.writeRow(b.tab, i, now[i].map(function () { return ''; }));
            }
          } catch (x) { /* best effort */ }
        });
        cache = {}; if (grid.reset) grid.reset();
        throw e;
      }
      places.forEach(function (p) { p.row.__row = p.at; });
      Object.keys(cache).forEach(function (tab) {
        var t = cache[tab];
        var changed = t.pending.length || t.dirty.length;
        if (t.pending.length) {
          var first = firstRows[tab];
          t.pending.forEach(function (r, i) { r.__row = first === null || first === undefined ? -1 : first + i; });
          t.pending = [];
        }
        t.dirty = [];
        // For a tab this request has read in full, hand the cache its exact new content, so the next
        // request does not have to read the Sheet again. Never when the Sheet was found changed by hand.
        if (changed && !unsure[tab] && !t.damaged.length && t.rows && t.rows.every(function (r) { return r.__row > 0; })) {
          var last = t.rows.reduce(function (m, r) { return Math.max(m, r.__row); }, 0), blank = t.headers.map(function () { return ''; });
          var data = [t.headers.slice()];
          for (var i = 1; i <= last; i++) data.push(blank);
          t.rows.forEach(function (r) { data[r.__row] = toArray(tab, t.headers, r); });
          full[tab] = data;
        }
        if (unsure[tab]) { t.rows = null; t.headers = null; } // read again if this request needs the tab once more
      });
      if (grid.commit) grid.commit(full); // retire cached copies of the tabs just written
    }
    var db = {
      rows: function (tab) { return load(tab).rows; },
      insert: function (tab, obj) {
        var headers = headersOf(tab), t = entry(tab), row = {};
        headers.forEach(function (h) { row[h] = decode(tab, h, encode(tab, h, obj[h])); });
        Object.defineProperty(row, '__row', { value: 0, enumerable: false, writable: true }); // 0 = not written yet
        t.pending.push(row);
        if (t.rows) t.rows.push(row);
        if (!buffer) flush();
      },
      update: function (tab, key, patch) {
        var t = load(tab);
        var keyCol = has(t.headers, Schema.TABS[tab][0]) ? Schema.TABS[tab][0] : t.headers[0]; // by name, wherever the column stands
        var row = t.rows.filter(function (r) { return String(r[keyCol]) === String(key); })[0];
        if (!row) throw new Error('update: no row in ' + tab + ' for ' + key);
        Object.keys(patch).forEach(function (k) {
          if (!has(t.headers, k)) {
            // A column of the current schema that this Sheet does not have yet (upgrade not run): skipped, never a crash.
            if (has(Schema.TABS[tab], k)) return;
            throw new Error('update: unknown column ' + tab + '.' + k);
          }
          row[k] = decode(tab, k, encode(tab, k, patch[k]));
        });
        if (row.__row > 0 && t.dirty.indexOf(row) === -1) t.dirty.push(row); // a not-yet-written row is simply written with its new values
        if (!buffer) flush();
      },
      /** The last n rows of a tab without reading the whole tab (used for today's thumbnails). */
      tail: function (tab, n) {
        var t = entry(tab);
        if (t.rows) return t.rows.slice(-n);
        var headers = headersOf(tab), data = grid.tail ? grid.tail(tab, n) : grid.read(tab).slice(1).slice(-n);
        var out = data.map(function (r) { var o = {}; headers.forEach(function (h, c) { o[h] = decode(tab, h, r[c]); }); return o; });
        return out.concat(t.pending).slice(-n);
      },
      flush: flush,
      /** Tabs and columns of the current schema that the Sheet does not have ([] = ready). */
      schemaProblems: function () {
        var tabs = Object.keys(Schema.TABS), out = [];
        var got = grid.allHeaders ? grid.allHeaders(tabs) : null;
        tabs.forEach(function (tab) {
          var h = (got ? got[tab] : (grid.headers ? grid.headers(tab) : (grid.read(tab)[0] || []))) || [];
          h = h.map(function (x) { return String(x).replace(/^\s+|\s+$/g, ''); });
          if (!h.length) { out.push(tab); return; }
          Schema.TABS[tab].forEach(function (c) { if (!has(h, c)) out.push(tab + '.' + c); });
        });
        return out;
      },
      /** Rows left out because a hand edit damaged them, as "Tab row N". */
      damaged: function () { var out = []; Object.keys(cache).forEach(function (tab) { out = out.concat(cache[tab].damaged); }); return out; },
      /** Called as the first thing inside the server lock: whatever was read while waiting is stale. */
      reset: function () { flush(); discard(); },
      discard: discard
    };
    return db;
  }

  var api = { setup: setup, open: open, encode: encode, decode: decode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
