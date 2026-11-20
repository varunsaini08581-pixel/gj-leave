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

  var SCHEMA_VERSION = 1;

  var api = { TABS: TABS, JSON_COLS: JSON_COLS, SCHEMA_VERSION: SCHEMA_VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJSchema = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
