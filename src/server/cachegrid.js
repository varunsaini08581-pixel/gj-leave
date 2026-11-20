/**
 * Read cache in front of the Sheet. Reading a tab from the Sheet costs about half a second;
 * a screen needs up to ten tabs. With this cache a tab is read from the Sheet once and then
 * served from memory until something writes to it.
 *
 * Safety comes from a VERSION per tab:
 *   - the data of a tab is cached under  d:<tab>:<version>
 *   - a writer, after its writes are on the Sheet and still inside the server lock, moves the
 *     tab to a new version. Whatever was cached under the old version is never read again.
 * So a reader can never keep serving rows from before a write, even when two requests overlap.
 * Cached data also expires by itself after TTL seconds, which bounds the effect of a manual
 * edit made directly in the Sheet (the owner is told not to do that).
 *
 * cache = { getAll(keys) -> {key: text}, put(key, text, ttlSeconds), putAll(map, ttlSeconds) }
 */
(function (root) {
  'use strict';
  var DATA_TTL = 600;       // 10 minutes
  var VERSION_TTL = 21600;  // 6 hours (the longest Apps Script allows)
  var MAX_CHARS = 90000;    // one cache value may hold 100 KB; a bigger tab is kept in several pieces
  var MAX_PIECES = 12;      // about 1 MB of text per tab; beyond that the tab is read from the Sheet

  function wrap(grid, cache, tabNames, newVersion) {
    var versions = null, dirty = {}, readAt = {};
    function vkey(tab) { return 'v:' + tab; }
    function loadVersions() {
      if (versions) return versions;
      var got = {};
      try { got = cache.getAll(tabNames.map(vkey)) || {}; } catch (e) { got = {}; }
      versions = {};
      var fresh = {};
      tabNames.forEach(function (t) {
        if (got[vkey(t)]) versions[t] = got[vkey(t)];
        else { versions[t] = newVersion(); fresh[vkey(t)] = versions[t]; }
      });
      if (Object.keys(fresh).length) { try { cache.putAll(fresh, VERSION_TTL); } catch (e) { /* cache is optional */ } }
      return versions;
    }
    function dkey(tab) { return 'd:' + tab + ':' + (loadVersions()[tab] || 'x'); }
    /** Store a tab's text under key; a long text goes in numbered pieces with a small index entry. */
    function putText(key, json) {
      try {
        if (json.length <= MAX_CHARS) { cache.put(key, json, DATA_TTL); return; }
        var n = Math.ceil(json.length / MAX_CHARS);
        if (n > MAX_PIECES) return; // too big to keep: it is read from the Sheet
        var map = {};
        for (var i = 0; i < n; i++) map[key + ':' + i] = json.substr(i * MAX_CHARS, MAX_CHARS);
        map[key] = '#pieces:' + n + ':' + json.length;
        cache.putAll(map, DATA_TTL);
      } catch (e) { /* cache down or full: fine */ }
    }
    function getText(key) {
      var text = null;
      try { text = (cache.getAll([key]) || {})[key]; } catch (e) { return null; }
      if (!text || text.indexOf('#pieces:') !== 0) return text || null;
      var a = text.split(':'), n = +a[1], len = +a[2], keys = [], out = '';
      for (var i = 0; i < n; i++) keys.push(key + ':' + i);
      var got = {}; try { got = cache.getAll(keys) || {}; } catch (e) { return null; }
      for (var j = 0; j < n; j++) { if (typeof got[keys[j]] !== 'string') return null; out += got[keys[j]]; }
      return out.length === len ? out : null; // a missing or half-expired piece = not cached
    }
    function read(tab) {
      var key = dkey(tab), text = null;
      readAt[tab] = loadVersions()[tab];
      text = getText(key);
      if (text) { try { return JSON.parse(text); } catch (e) { /* fall through to the Sheet */ } }
      var data = grid.read(tab);
      try { putText(key, JSON.stringify(data)); } catch (e) { /* fine */ }
      return data;
    }
    return {
      /** Forget the versions seen so far: the next read asks the cache which copy is current. */
      reset: function () { versions = null; readAt = {}; },
      tabNames: function () { return grid.tabNames(); },
      addTab: function (name) { dirty[name] = true; return grid.addTab(name); },
      read: read,
      // Headers change only in setup, so they have their own long-lived entry and inserting a row
      // never needs the whole tab.
      headers: function (tab) {
        var key = 'h:' + tab, text = null;
        try { text = (cache.getAll([key]) || {})[key]; } catch (e) { text = null; }
        if (text) { try { return JSON.parse(text); } catch (e) { /* fall through */ } }
        var h = grid.headers ? grid.headers(tab) : (grid.read(tab)[0] || []);
        try { if (h.length) cache.put(key, JSON.stringify(h), VERSION_TTL); } catch (e) { /* optional */ }
        return h;
      },
      /** The header row straight from the Sheet; the remembered copy is refreshed with it. */
      liveHeaders: function (tab) {
        var h = grid.headers ? grid.headers(tab) : (grid.read(tab)[0] || []);
        try { if (h.length) cache.put('h:' + tab, JSON.stringify(h), VERSION_TTL); } catch (e) { /* optional */ }
        return h;
      },
      /** Header rows of many tabs with one cache call (used by the "is the Sheet upgraded?" check). */
      allHeaders: function (tabs) {
        var got = {}, out = {};
        try { got = cache.getAll(tabs.map(function (t) { return 'h:' + t; })) || {}; } catch (e) { got = {}; }
        tabs.forEach(function (t) {
          var text = got['h:' + t];
          if (text) { try { out[t] = JSON.parse(text); return; } catch (e) { /* read it */ } }
          var h = grid.headers ? grid.headers(t) : (grid.read(t)[0] || []);
          try { if (h.length) cache.put('h:' + t, JSON.stringify(h), VERSION_TTL); } catch (e) { /* optional */ }
          out[t] = h;
        });
        return out;
      },
      /** One row and the whole tab, straight from the Sheet (to check where a row stands before it is written). */
      readRow: function (tab, i) { return grid.readRow ? grid.readRow(tab, i) : (grid.read(tab)[i] || null); },
      readLive: function (tab) { return grid.read(tab); },
      tail: function (tab, n) { return grid.tail ? grid.tail(tab, n) : grid.read(tab).slice(1).slice(-n); },
      appendMany: function (batch) {
        batch.forEach(function (b) { dirty[b.tab] = true; });
        if (grid.appendMany) return grid.appendMany(batch);
        var first = {}; batch.forEach(function (b) { first[b.tab] = grid.appendRows(b.tab, b.rows); }); return first;
      },
      append: function (tab, row) { dirty[tab] = true; return grid.append(tab, row); },
      appendRows: function (tab, rows) { dirty[tab] = true; return grid.appendRows(tab, rows); },
      writeRow: function (tab, i, row) { dirty[tab] = true; return grid.writeRow(tab, i, row); },
      /** Called by the store after its writes are on the Sheet (inside the lock): retire the old versions. */
      commit: function (full) {
        var names = Object.keys(dirty);
        if (!names.length) return;
        var map = {}, current = {};
        loadVersions();
        // The writer holds the server lock here. If nobody else has written a tab since this
        // request read it, the request knows the tab's exact new content and can cache it.
        try { current = cache.getAll(names.map(vkey)) || {}; } catch (e) { current = {}; }
        names.forEach(function (t) {
          var untouched = readAt[t] && current[vkey(t)] === readAt[t];
          versions[t] = newVersion(); map[vkey(t)] = versions[t];
          if (full && full[t] && untouched) {
            try { putText('d:' + t + ':' + versions[t], JSON.stringify(full[t])); } catch (e) { /* optional */ }
          }
          readAt[t] = versions[t];
        });
        dirty = {};
        // The new versions MUST reach the cache: otherwise other requests keep reading the copy from before this write.
        try { cache.putAll(map, VERSION_TTL); }
        catch (e) {
          Object.keys(map).forEach(function (k) {
            try { cache.put(k, map[k], VERSION_TTL); }
            catch (e2) { try { if (cache.remove) cache.remove(k); } catch (e3) { /* the data TTL (10 min) is the last bound */ } }
          });
        }
      }
    };
  }

  var api = { wrap: wrap, DATA_TTL: DATA_TTL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJCacheGrid = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
