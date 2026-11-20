/**
 * Sheet schema (handoff Part 5). One tab per table. Row 1 = headers.
 * Columns listed in JSON_COLS hold JSON text in the Sheet and objects in code.
 * Rows are never deleted. Cancel is a status.
 */
(function (root) {
  'use strict';

  var TABS = {
    People: ['id', 'name', 'group', 'role', 'dutyStart', 'dutyEnd', 'sundayOff', 'noApproval', 'noClash', 'noQuota',
      'dressExempt', 'active', 'email', 'phone', 'pinSalt', 'pinHash', 'pinTries', 'pinLockedUntil'],
    Devices: ['id', 'personId', 'tokenHash', 'label', 'status', 'requestedAt', 'decidedAt', 'decidedBy'],
    PayInfo: ['personId', 'fixedSalary', 'targetAllowance', 'disciplineBonus', 'dutyHours', 'updatedAt', 'updatedBy'],
    Rules: ['id', 'on', 'label', 'members', 'minPresent', 'rosterSundayException', 'emergencyIfAllPresent'],
    Restrictions: ['id', 'from', 'to', 'note', 'rule', 'appliesTo', 'on', 'createdBy', 'createdAt'],
    LeaveRequests: ['id', 'personId', 'kind', 'dates', 'halfStart', 'reasonCode', 'reasonText', 'submittedAt', 'type',
      'noticeHours', 'run', 'route', 'status', 'approvals', 'extremeEmergency', 'emergencyNo', 'penaltyEmergency',
      'restrictionViolation', 'enteredBy', 'decidedAt', 'decidedBy', 'decisionReason', 'history'],
    Punches: ['id', 'personId', 'date', 'kind', 'at', 'photoId', 'lat', 'lng', 'accuracy', 'distance', 'deviceId', 'flag', 'note'],
    DayMinutes: ['id', 'personId', 'date', 'kind', 'minutes', 'informed', 'statedMinutes', 'source', 'note'],
    Violations: ['id', 'personId', 'date', 'rule', 'source', 'proof', 'note', 'createdBy', 'createdAt', 'disputeState',
      'disputeAt', 'disputeText', 'disputeDecidedBy', 'disputeDecidedAt'],
    MonthSheet: ['id', 'month', 'personId', 'result', 'lockedBy', 'lockedAt'],
    Notifications: ['id', 'to', 'kind', 'title', 'body', 'ref', 'createdAt', 'readAt', 'emailedAt'],
    Audit: ['id', 'at', 'actor', 'action', 'ref', 'detail'],
    Settings: ['key', 'value', 'updatedAt', 'updatedBy']
  };

  var JSON_COLS = {
    People: ['sundayOff'], Rules: ['members', 'rosterSundayException', 'emergencyIfAllPresent'],
    Restrictions: ['appliesTo'], LeaveRequests: ['dates', 'approvals', 'history'], MonthSheet: ['result'], Audit: ['detail']
  };

  // Every cell is stored as plain text (so Sheets never turns '2026-11-25' or '09:30' into a date).
  // These lists tell the store how to turn text back into numbers and booleans.
  var NUM_COLS = ['pinTries', 'pinLockedUntil', 'requestedAt', 'decidedAt', 'submittedAt', 'noticeHours', 'run', 'emergencyNo',
    'at', 'lat', 'lng', 'accuracy', 'distance', 'minutes', 'statedMinutes', 'createdAt', 'disputeAt', 'disputeDecidedAt',
    'lockedAt', 'readAt', 'emailedAt', 'updatedAt', 'minPresent', 'fixedSalary', 'targetAllowance', 'disciplineBonus', 'dutyHours'];
  var BOOL_COLS = ['noApproval', 'noClash', 'noQuota', 'dressExempt', 'active', 'on', 'extremeEmergency', 'penaltyEmergency',
    'restrictionViolation', 'informed'];

  var SCHEMA_VERSION = 1;

  var api = { TABS: TABS, JSON_COLS: JSON_COLS, NUM_COLS: NUM_COLS, BOOL_COLS: BOOL_COLS, SCHEMA_VERSION: SCHEMA_VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJSchema = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
