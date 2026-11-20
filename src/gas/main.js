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
    writeRow: function (name, index, row) {
      var sh = ss.getSheetByName(name);
      sh.getRange(index + 1, 1, 1, row.length).setNumberFormat('@').setValues([row]);
    }
  };
}

function gjEnv_() {
  return {
    sha256: function (s) {
      var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
      return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
    },
    randomId: function () { return Utilities.getUuid().replace(/-/g, ''); },
    withLock: function (fn) {
      var lock = LockService.getScriptLock();
      lock.waitLock(25000);
      try { return fn(); } finally { lock.releaseLock(); }
    }
  };
}

function gjCtx_() {
  return { db: GJStore.open(gjGrid_()), now: Date.now(), env: gjEnv_() }; // server time only
}

/** Run once from the editor after pasting the code. Safe to run again. */
function setupOrUpgrade() {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var done = GJStore.setup(gjGrid_());
    Logger.log(done.length ? done.join('\n') : 'Nothing to do. Already up to date.');
    return done;
  } finally { lock.releaseLock(); }
}

function doPost(e) {
  var request = {};
  try { request = JSON.parse(e.postData.contents); } catch (err) { request = {}; }
  var reply = GJApi.handle(gjCtx_(), request);
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
  return GJJobs.run(ctx, name, gjMailer_());
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
