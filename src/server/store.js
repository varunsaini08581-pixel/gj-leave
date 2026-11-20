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

  /** Open a db over the grid. Each tab is read at most once per request and cached. */
  function open(grid) {
    var cache = {};
    function load(tab) {
      if (cache[tab]) return cache[tab];
      var data = grid.read(tab);
      var headers = data.length ? data[0].map(String) : Schema.TABS[tab].slice();
      var rows = [];
      for (var i = 1; i < data.length; i++) {
        var obj = {};
        var empty = true;
        for (var c = 0; c < headers.length; c++) {
          var cell = data[i][c];
          if (cell !== '' && cell !== undefined && cell !== null) empty = false;
          obj[headers[c]] = decode(tab, headers[c], cell);
        }
        if (empty) continue;
        Object.defineProperty(obj, '__row', { value: i, enumerable: false, writable: true });
        rows.push(obj);
      }
      cache[tab] = { headers: headers, rows: rows, nextRow: data.length || 1 };
      return cache[tab];
    }
    function toArray(tab, headers, obj) { return headers.map(function (h) { return encode(tab, h, obj[h]); }); }
    return {
      rows: function (tab) { return load(tab).rows; },
      insert: function (tab, obj) {
        var t = load(tab);
        var row = {};
        t.headers.forEach(function (h) { row[h] = decode(tab, h, encode(tab, h, obj[h])); });
        grid.append(tab, toArray(tab, t.headers, obj));
        Object.defineProperty(row, '__row', { value: t.nextRow, enumerable: false, writable: true });
        t.nextRow += 1;
        t.rows.push(row);
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
        grid.writeRow(tab, row.__row, toArray(tab, t.headers, row));
      }
    };
  }

  var api = { setup: setup, open: open, encode: encode, decode: decode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
