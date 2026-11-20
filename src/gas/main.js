/**
 * Apps Script glue (runs only inside Google Apps Script, bound to the "GJ Leave" Sheet).
 * Everything with logic lives in the tested modules above; this file only connects them
 * to SpreadsheetApp, LockService and the web app entry points.
 */

/** Real Sheet behind the grid interface used by the store. */
function gjGrid_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return {
    tabNames: function () { return ss.getSheets().map(function (s) { return s.getName(); }); },
    addTab: function (name) {
      var sh = ss.insertSheet(name);
      if (sh.getMaxColumns() < 40) sh.insertColumnsAfter(sh.getMaxColumns(), 40 - sh.getMaxColumns());
      sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@'); // plain text everywhere
    },
    read: function (name) {
      gjReads_ += 1;
      var sh = ss.getSheetByName(name);
      if (!sh || sh.getLastRow() === 0) return [];
      return sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
    },
    append: function (name, row) { return this.appendRows(name, [row]); },
    headers: function (name) {
      var sh = ss.getSheetByName(name);
      if (!sh || sh.getLastRow() === 0) return [];
      return sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
    },
    /** The last n data rows of a tab, without reading the whole tab. */
    tail: function (name, n) {
      var sh = ss.getSheetByName(name), last = sh ? sh.getLastRow() : 0;
      if (last < 2) return [];
      var from = Math.max(2, last - n + 1);
      return sh.getRange(from, 1, last - from + 1, sh.getLastColumn()).getDisplayValues();
    },
    appendRows: function (name, rows) { return this.appendMany([{ tab: name, rows: rows }])[name]; },
    /**
     * Appends rows to several tabs. All reads (where does each tab end?) happen first, then all
     * writes, so Apps Script sends the writes together. Returns { tab: 0-based index of the first row }.
     */
    appendMany: function (batch) {
      var plan = batch.map(function (b) {
        var sh = ss.getSheetByName(b.tab);
        return { b: b, sh: sh, at: sh.getLastRow() + 1, max: sh.getMaxRows() };
      });
      var first = {};
      plan.forEach(function (p) {
        var need = p.at + p.b.rows.length - 1;
        if (need > p.max) { // grow the tab; new rows are plain text like the rest
          p.sh.insertRowsAfter(p.max, Math.max(500, need - p.max));
          p.sh.getRange(p.max + 1, 1, p.sh.getMaxRows() - p.max, p.sh.getMaxColumns()).setNumberFormat('@');
        }
        p.sh.getRange(p.at, 1, p.b.rows.length, p.b.rows[0].length).setValues(p.b.rows);
        first[p.b.tab] = p.at - 1;
      });
      return first;
    },
    /** One row as the Sheet shows it now (0-based index, 0 = headers); null when there is no such row. */
    readRow: function (name, index) {
      var sh = ss.getSheetByName(name);
      if (!sh || index + 1 > sh.getLastRow()) return null;
      return sh.getRange(index + 1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
    },
    /**
     * Writes the given cells of one row. The row array may have gaps: a gap is a column that is not
     * the app's own (something the owner added), and it is not touched.
     */
    writeRow: function (name, index, row) {
      var sh = ss.getSheetByName(name), start = -1, run = [];
      for (var c = 0; c <= row.length; c++) {
        if (c < row.length && row[c] !== undefined) { if (start === -1) start = c; run.push(row[c]); continue; }
        if (start !== -1) { sh.getRange(index + 1, start + 1, 1, run.length).setNumberFormat('@').setValues([run]); start = -1; run = []; }
      }
    }
  };
}

var gjReads_ = 0;
var gjT_ = {}; // where the time of a request went (returned as _t, for tuning)
function gjTime_(key, fn) { var a = Date.now(); try { return fn(); } finally { gjT_[key] = (gjT_[key] || 0) + Date.now() - a; } }
var gjLockDepth_ = 0;
var gjDb_ = null; // the request's db, so buffered writes are flushed before the lock is released

function gjEnv_() {
  return {
    sha256: function (s) {
      var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
      return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
    },
    randomId: function () { return Utilities.getUuid().replace(/-/g, ''); },
    savePhoto: function (name, data) { return gjTime_('drive', function () { return gjSavePhoto_(name, data); }); },
    readPhoto: function (id) { return gjReadPhoto_(id); },
    withLock: function (fn) {
      if (gjLockDepth_ > 0) return fn(); // already inside the lock in this run
      var lock = LockService.getScriptLock();
      gjTime_('lockWait', function () { lock.waitLock(25000); });
      gjLockDepth_ += 1;
      // Writes are flushed while the lock is still held. A refused action has already thrown its
      // writes away (GJApi.locked), except a wrong PIN, which must still be counted.
      try { return fn(); } finally { try { if (gjDb_) gjTime_('flush', function () { gjDb_.flush(); }); } finally { gjLockDepth_ -= 1; lock.releaseLock(); } }
    }
  };
}

function gjCache_() {
  var c = CacheService.getScriptCache();
  return {
    getAll: function (keys) { return c.getAll(keys); },
    put: function (k, v, ttl) { c.put(k, v, ttl); },
    putAll: function (map, ttl) { c.putAll(map, ttl); },
    remove: function (k) { c.remove(k); }
  };
}
function gjCachedGrid_() {
  return GJCacheGrid.wrap(gjGrid_(), gjCache_(), Object.keys(GJSchema.TABS), function () { return Utilities.getUuid().slice(0, 8); });
}
function gjCtx_() {
  var ctx = { db: GJStore.open(gjCachedGrid_(), { buffer: true }), now: Date.now(), env: gjEnv_() }; // server time only
  gjDb_ = ctx.db;
  return ctx;
}

/** Run once from the editor after pasting the code. Safe to run again. */
function setupOrUpgrade() {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var done = GJStore.setup(gjGrid_(), { today: Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd') });
    // Setup may have changed columns: retire every cached copy.
    var all = {}; Object.keys(GJSchema.TABS).forEach(function (t) { all['v:' + t] = Utilities.getUuid().slice(0, 8); });
    CacheService.getScriptCache().putAll(all, 21600);
    CacheService.getScriptCache().removeAll(Object.keys(GJSchema.TABS).map(function (t) { return 'h:' + t; }));
    Logger.log(done.length ? done.join('\n') : 'Nothing to do. Already up to date.');
    return done;
  } finally { lock.releaseLock(); }
}

function doPost(e) {
  var request = {};
  try { request = JSON.parse(e.postData.contents); } catch (err) { request = {}; }
  var t0 = Date.now(); gjT_ = {};
  var ctx = gjCtx_();
  var reply = GJApi.handle(ctx, request);
  ctx.db.flush(); // anything written outside a locked action
  gjT_.total = Date.now() - t0; gjT_.sheetReads = gjReads_; reply._t = gjT_;
  return ContentService.createTextOutput(JSON.stringify(reply)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, data: { app: 'GJ Leave & Attendance', time: Date.now() } }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Lists every Google service the app will ever use, so Google asks the owner for
 * permission ONCE (Sheet, email alerts, the private photo folder, timed jobs).
 */
function authorizeAll() {
  SpreadsheetApp.getActiveSpreadsheet().getName();
  MailApp.getRemainingDailyQuota();
  DriveApp.getRootFolder().getName();
  ScriptApp.getProjectTriggers();
  return 'Authorized.';
}

// ---------- Timed jobs ----------

function gjMailer_() {
  return {
    quota: function () { return MailApp.getRemainingDailyQuota(); },
    send: function (to, subject, body) { MailApp.sendEmail(to, subject, body, { name: 'GJ Leave & Attendance' }); }
  };
}
function gjJob_(name) {
  var ctx = gjCtx_();
  ctx.env.ownerEmail = Session.getEffectiveUser().getEmail();
  try { return GJJobs.run(ctx, name, gjMailer_()); }
  finally { ctx.db.flush(); } // whatever the job managed to do is saved, also when it stopped half-way
}
function jobEmails() { return gjJob_('emails'); }
function jobHourly() { return gjJob_('hourly'); }
function jobEvening() { return gjJob_('evening'); }
function jobEndOfDay() { return gjJob_('endOfDay'); }

/** Run once from the editor. Removes this project's old timers and installs the four jobs. Safe to run again. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('jobEmails').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('jobHourly').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('jobEvening').timeBased().atHour(19).everyDays(1).inTimezone('Asia/Kolkata').create();
  ScriptApp.newTrigger('jobEndOfDay').timeBased().atHour(21).everyDays(1).inTimezone('Asia/Kolkata').create();
  return 'Timers installed.';
}

// ---------- Photos (private Drive folder; the Sheet keeps only the file id) ----------

function gjPhotoFolder_() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('photoFolderId');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* folder was removed: make a new one */ } }
  var folder = DriveApp.createFolder('GJ Leave - check-in photos (private)');
  props.setProperty('photoFolderId', folder.getId());
  return folder;
}
function gjSavePhoto_(name, base64) {
  var blob = Utilities.newBlob(Utilities.base64Decode(String(base64).replace(/^data:image\/jpeg;base64,/, '')), 'image/jpeg', name);
  return gjPhotoFolder_().createFile(blob).getId(); // not shared with anyone
}
function gjReadPhoto_(id) {
  return 'data:image/jpeg;base64,' + Utilities.base64Encode(DriveApp.getFileById(id).getBlob().getBytes());
}
