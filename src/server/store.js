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

  function has(list, x) { return list.indexOf(x) !== -1; }

  function encode(tab, col, v) {
    if (v === undefined || v === null) return '';
    if (has(Schema.JSON_COLS[tab] || [], col)) return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  }
  function decode(tab, col, text) {
    if (text === '' || text === undefined || text === null) return has(Schema.JSON_COLS[tab] || [], col) ? null : '';
    text = String(text);
    if (has(Schema.JSON_COLS[tab] || [], col)) { try { return JSON.parse(text); } catch (e) { return null; } }
    if (has(Schema.BOOL_COLS, col)) return text.toUpperCase() === 'TRUE';
    if (has(Schema.NUM_COLS, col)) { var n = Number(text); return isNaN(n) ? '' : n; }
    return text;
  }

  /**
   * Create missing tabs and add missing columns. Safe to run twice: it never removes or
   * reorders anything that exists and never touches data rows.
   */
  function setup(grid) {
    var done = [];
    var names = grid.tabNames();
    Object.keys(Schema.TABS).forEach(function (tab) {
      if (!has(names, tab)) { grid.addTab(tab); grid.append(tab, Schema.TABS[tab].slice()); done.push('created ' + tab); return; }
      var data = grid.read(tab);
      if (!data.length) { grid.append(tab, Schema.TABS[tab].slice()); done.push('headers ' + tab); return; }
      var headers = data[0].map(String);
      var missing = Schema.TABS[tab].filter(function (c) { return !has(headers, c); });
      if (missing.length) { grid.writeRow(tab, 0, headers.concat(missing)); done.push('columns ' + tab + ': ' + missing.join(', ')); }
    });
    var db = open(grid);
    if (!db.rows('Rules').length) {
      Clash.DEFAULT_RULES.forEach(function (r) { db.insert('Rules', r); });
      done.push('seeded Rules');
    }
    if (!db.rows('Settings').some(function (s) { return s.key === 'schemaVersion'; })) {
      db.insert('Settings', { key: 'schemaVersion', value: String(Schema.SCHEMA_VERSION), updatedAt: '', updatedBy: 'setup' });
      done.push('schemaVersion');
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
      if (!cache[tab]) cache[tab] = { headers: null, rows: null, pending: [], dirty: [] };
      return cache[tab];
    }
    function headersOf(tab) {
      var t = entry(tab);
      if (!t.headers) {
        var h = grid.headers ? grid.headers(tab) : (grid.read(tab)[0] || []);
        t.headers = h && h.length ? h.map(String) : Schema.TABS[tab].slice();
      }
      return t.headers;
    }
    function load(tab) {
      var t = entry(tab);
      if (t.rows) return t;
      var data = grid.read(tab);
      t.headers = data.length ? data[0].map(String) : Schema.TABS[tab].slice();
      var rows = [];
      for (var i = 1; i < data.length; i++) {
        var obj = {}, empty = true;
        for (var c = 0; c < t.headers.length; c++) {
          var cell = data[i][c];
          if (cell !== '' && cell !== undefined && cell !== null) empty = false;
          obj[t.headers[c]] = decode(tab, t.headers[c], cell);
        }
        if (empty) continue;
        Object.defineProperty(obj, '__row', { value: i, enumerable: false, writable: true });
        rows.push(obj);
      }
      t.rows = rows.concat(t.pending); // rows inserted earlier in this request, before the tab was read
      return t;
    }
    function toArray(tab, headers, obj) { return headers.map(function (h) { return encode(tab, h, obj[h]); }); }
    function flush() {
      Object.keys(cache).forEach(function (tab) {
        var t = cache[tab];
        if (t.pending.length) {
          var arrays = t.pending.map(function (r) { return toArray(tab, t.headers, r); });
          var first = grid.appendRows ? grid.appendRows(tab, arrays) : null;
          if (first === null || first === undefined) { first = null; arrays.forEach(function (a) { grid.append(tab, a); }); }
          t.pending.forEach(function (r, i) { r.__row = first === null ? -1 : first + i; });
          t.pending = [];
        }
        t.dirty.forEach(function (r) { if (r.__row > 0) grid.writeRow(tab, r.__row, toArray(tab, t.headers, r)); });
        t.dirty = [];
      });
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
        var keyCol = t.headers[0];
        var row = t.rows.filter(function (r) { return String(r[keyCol]) === String(key); })[0];
        if (!row) throw new Error('update: no row in ' + tab + ' for ' + key);
        Object.keys(patch).forEach(function (k) {
          if (!has(t.headers, k)) throw new Error('update: unknown column ' + tab + '.' + k);
          row[k] = decode(tab, k, encode(tab, k, patch[k]));
        });
        if (row.__row > 0 && t.dirty.indexOf(row) === -1) t.dirty.push(row); // a not-yet-written row is simply written with its new values
        if (!buffer) flush();
      },
      flush: flush
    };
    return db;
  }

  var api = { setup: setup, open: open, encode: encode, decode: decode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
