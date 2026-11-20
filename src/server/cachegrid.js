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
  var MAX_CHARS = 95000;    // one cache value may hold 100 KB

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
    function read(tab) {
      var key = dkey(tab), text = null;
      readAt[tab] = loadVersions()[tab];
      try { text = (cache.getAll([key]) || {})[key]; } catch (e) { text = null; }
      if (text) { try { return JSON.parse(text); } catch (e) { /* fall through to the Sheet */ } }
      var data = grid.read(tab);
      try { var json = JSON.stringify(data); if (json.length <= MAX_CHARS) cache.put(key, json, DATA_TTL); } catch (e) { /* too big or cache down: fine */ }
      return data;
    }
    return {
      tabNames: function () { return grid.tabNames(); },
      addTab: function (name) { dirty[name] = true; return grid.addTab(name); },
      read: read,
      headers: function (tab) { var d = read(tab); return d.length ? d[0] : []; },
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
            try { var json = JSON.stringify(full[t]); if (json.length <= MAX_CHARS) cache.put('d:' + t + ':' + versions[t], json, DATA_TTL); } catch (e) { /* optional */ }
          }
          readAt[t] = versions[t];
        });
        dirty = {};
        try { cache.putAll(map, VERSION_TTL); } catch (e) { /* if this fails the data TTL still bounds staleness */ }
      }
    };
  }

  var api = { wrap: wrap, DATA_TTL: DATA_TTL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJCacheGrid = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
