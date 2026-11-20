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
      sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@'); // plain text everywhere
    },
    read: function (name) {
      var sh = ss.getSheetByName(name);
      if (!sh || sh.getLastRow() === 0) return [];
      return sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
    },
    append: function (name, row) {
      var sh = ss.getSheetByName(name);
      var r = sh.getLastRow() + 1;
      sh.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row]);
    },
    headers: function (name) {
      var sh = ss.getSheetByName(name);
      if (!sh || sh.getLastRow() === 0) return [];
      return sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
    },
    /** Writes many rows in one call. Returns the 0-based index of the first row written. */
    appendRows: function (name, rows) {
      var sh = ss.getSheetByName(name);
      var r = sh.getLastRow() + 1;
      sh.getRange(r, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
      return r - 1;
    },
    writeRow: function (name, index, row) {
      var sh = ss.getSheetByName(name);
      sh.getRange(index + 1, 1, 1, row.length).setNumberFormat('@').setValues([row]);
    }
  };
}

var gjLockDepth_ = 0;
var gjDb_ = null; // the request's db, so buffered writes are flushed before the lock is released

function gjEnv_() {
  return {
    sha256: function (s) {
      var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
      return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
    },
    randomId: function () { return Utilities.getUuid().replace(/-/g, ''); },
    savePhoto: function (name, data) { return gjSavePhoto_(name, data); },
    readPhoto: function (id) { return gjReadPhoto_(id); },
    withLock: function (fn) {
      if (gjLockDepth_ > 0) return fn(); // already inside the lock in this run
      var lock = LockService.getScriptLock();
      lock.waitLock(25000);
      gjLockDepth_ += 1;
      // Writes are flushed while the lock is still held, also when the action ends with an error
      // (for example a wrong PIN must still be counted).
      try { return fn(); } finally { try { if (gjDb_) gjDb_.flush(); } finally { gjLockDepth_ -= 1; lock.releaseLock(); } }
    }
  };
}

function gjCache_() {
  var c = CacheService.getScriptCache();
  return {
    getAll: function (keys) { return c.getAll(keys); },
    put: function (k, v, ttl) { c.put(k, v, ttl); },
    putAll: function (map, ttl) { c.putAll(map, ttl); }
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
    var done = GJStore.setup(gjGrid_());
    // Setup may have changed columns: retire every cached copy.
    var all = {}; Object.keys(GJSchema.TABS).forEach(function (t) { all['v:' + t] = Utilities.getUuid().slice(0, 8); });
    CacheService.getScriptCache().putAll(all, 21600);
    Logger.log(done.length ? done.join('\n') : 'Nothing to do. Already up to date.');
    return done;
  } finally { lock.releaseLock(); }
}

function doPost(e) {
  var request = {};
  try { request = JSON.parse(e.postData.contents); } catch (err) { request = {}; }
  var ctx = gjCtx_();
  var reply = GJApi.handle(ctx, request);
  ctx.db.flush(); // anything written outside a locked action (login, reads that log)
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
  var result = GJJobs.run(ctx, name, gjMailer_());
  ctx.db.flush();
  return result;
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
