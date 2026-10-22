/**
 * khatib-status.js — وظائف مشتركة لعرض وتصفية وتصدير حالات وجاهزية الخطباء والتكليفات
 * وحدة مستقلة وقابلة للاختبار في المتصفح وبيئة Node.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.KhatibStatus = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STATUS_KEYS = {
    READY: 'ready',
    EXCUSED: 'excused',
    NO_REPLY: 'no_reply',
    UNAVAILABLE: 'unavailable',
  };

  var STATUS_LABELS = {
    ready: 'مستعد',
    excused: 'معتذر',
    no_reply: 'لم يرد',
    unavailable: 'غير متواجد',
  };

  var STATUS_BADGES = {
    ready: '<span class="badge badge-volunteer">🟢 مستعد</span>',
    excused: '<span class="badge badge-excused">🚫 معتذر</span>',
    no_reply: '<span class="badge badge-off">⚪ لم يرد</span>',
    unavailable: '<span class="badge badge-off" style="background:#f1f5f9;color:#64748b">⛔ غير متواجد</span>',
  };

  // Structured availability helper hook (نقطة ربط للمرحلة المستقبلية للجاهزية الشهرية/المتكررة)
  var availabilityHelper = null;

  function setAvailabilityHelper(fn) {
    availabilityHelper = fn;
  }

  function getStructuredAvailability(khatib, date) {
    if (typeof availabilityHelper === 'function') {
      var res = availabilityHelper(khatib, date);
      if (res === 'unavailable' || res === false) return STATUS_KEYS.UNAVAILABLE;
    }
    return null;
  }

  function isExcusedStatus(status) {
    return String(status || '').trim().toLowerCase() === 'excused';
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * استخراج حالة الخطيب وسياق تكليفه لتاريخ محدد للقراءة فقط
   * @param {Object} khatib - كائن الخطيب من قائمة الخطباء
   * @param {Object} schedRes - استجابة الجدول getSchedule { rows, khatibReadiness, exists, date }
   * @returns {Object} بيانات الخطيب المحسوبة للعرض والتصفية والتصدير
   */
  function resolveKhatibState(khatib, schedRes) {
    var kId = String((khatib && khatib.id) || '');
    var schedRows = (schedRes && schedRes.rows) || [];
    var readinessMap = (schedRes && schedRes.khatibReadiness) || {};
    var rawReadiness = String(readinessMap[kId] || '').trim().toLowerCase();

    // فحص صفوف التكليفات في هذا التاريخ
    var assignedRows = schedRows.filter(function (r) {
      return String(r.khatibId || '') === kId;
    });

    var excusedMosques = [];
    var activeAssignment = null;

    assignedRows.forEach(function (r) {
      var mName = r.mosque || ('مسجد ' + r.mosqueId);
      if (isExcusedStatus(r.status)) {
        if (excusedMosques.indexOf(mName) === -1) {
          excusedMosques.push(mName);
        }
      } else {
        // تكليف قائم (مؤكد أو غير مؤكد/قيد التأكيد)
        activeAssignment = {
          mosqueId: r.mosqueId,
          mosque: mName,
          status: r.status || 'unassigned',
        };
      }
    });

    var excuseDetail = excusedMosques.length > 0
      ? ('معتذر عن ' + excusedMosques.join('، '))
      : '';

    // حل الحالة (Status Resolution):
    // 1. أولوية الأدلة الأسبوعية الصريحة: اعتذار تكليف أو اعتذار عام في الجاهزية => معتذر
    // 2. رد أسبوعي صريح بالاستعداد => مستعد
    // 3. قاعدة عدم التواجد الشهرية/الهيكلية المستمرة => غير متواجد (فقط إذا لم يكن هناك رد صريح هذا الأسبوع)
    // 4. عدم وجود رد => لم يرد
    var statusKey = STATUS_KEYS.NO_REPLY;

    if (rawReadiness === 'excused' || (excusedMosques.length > 0 && !activeAssignment)) {
      statusKey = STATUS_KEYS.EXCUSED;
    } else if (rawReadiness === 'ready') {
      statusKey = STATUS_KEYS.READY;
    } else if (getStructuredAvailability(khatib, schedRes ? schedRes.date : '') === STATUS_KEYS.UNAVAILABLE) {
      statusKey = STATUS_KEYS.UNAVAILABLE;
    } else {
      statusKey = STATUS_KEYS.NO_REPLY;
    }

    var statusLabel = STATUS_LABELS[statusKey] || 'لم يرد';
    var statusBadgeHtml = STATUS_BADGES[statusKey] || STATUS_BADGES.no_reply;

    // خطيب غير مكلف (Free khatib):
    // الخطيب قيد التكليف غير المؤكد لا يُعتبر متاحاً كبديل
    // pending assigned khatibs must not be counted as free!
    var isAssigned = !!activeAssignment;
    var isFree = !isAssigned;

    var activeMosque = isAssigned ? activeAssignment.mosque : '';
    var assignmentStatus = isAssigned ? activeAssignment.status : '';
    var assignmentStatusLabel = assignmentStatus === 'confirmed' ? 'مؤكد' : 'لم يتم التأكيد';

    // سياق التكليف (Assignment context):
    // الخطيب المستعد المكلف/المؤكد بمسجد يُوسم بمسجده ولا يُعلن عنه كبديل حر
    var assignmentContextLabel = '';
    var assignmentContextHtml = '';

    if (isAssigned) {
      assignmentContextLabel = activeMosque + ' (' + assignmentStatusLabel + ')';
      assignmentContextHtml = '<span class="badge ' +
        (assignmentStatus === 'confirmed' ? 'badge-volunteer' : 'badge-off') +
        '">🕌 ' + escHtml(activeMosque) + ' (' + escHtml(assignmentStatusLabel) + ')</span>';
    } else {
      if (statusKey === STATUS_KEYS.READY) {
        assignmentContextLabel = 'متاح كبديل (غير مكلف)';
        assignmentContextHtml = '<span class="badge badge-volunteer">متاح كبديل (غير مكلف)</span>';
      } else if (statusKey === STATUS_KEYS.EXCUSED) {
        if (excuseDetail) {
          assignmentContextLabel = excuseDetail;
          assignmentContextHtml = '<span class="badge badge-warn">' + escHtml(excuseDetail) + '</span>';
        } else {
          assignmentContextLabel = 'غير مكلف (معتذر)';
          assignmentContextHtml = '<span class="badge badge-excused">غير مكلف (معتذر)</span>';
        }
      } else if (statusKey === STATUS_KEYS.UNAVAILABLE) {
        assignmentContextLabel = 'غير متواجد';
        assignmentContextHtml = '<span class="muted">غير متواجد</span>';
      } else {
        assignmentContextLabel = 'غير مكلف';
        assignmentContextHtml = '<span class="muted">غير مكلف</span>';
      }
    }

    // نص الحالة المخصص للتصدير (Word / PDF):
    var exportStatusText = statusLabel;
    if (statusKey === STATUS_KEYS.EXCUSED && excuseDetail) {
      exportStatusText = statusLabel + ' (' + excuseDetail + ')';
    }

    return {
      id: (khatib && khatib.id) || '',
      name: (khatib && khatib.name) || '',
      phone: (khatib && khatib.phone) || '',
      type: (khatib && khatib.type) || 'primary',
      active: khatib ? (khatib.active !== false && khatib.active !== 0) : true,
      statusKey: statusKey,
      statusLabel: statusLabel,
      statusBadgeHtml: statusBadgeHtml,
      isAssigned: isAssigned,
      activeMosque: activeMosque,
      assignmentStatus: assignmentStatus,
      assignmentStatusLabel: assignmentStatusLabel,
      excusedMosques: excusedMosques,
      excuseDetail: excuseDetail,
      isFree: isFree,
      assignmentContextLabel: assignmentContextLabel,
      assignmentContextHtml: assignmentContextHtml,
      exportStatusText: exportStatusText,
    };
  }

  function filterKhatibs(list, query, statusFilter, matcherFn) {
    var q = String(query || '').trim();
    var sf = String(statusFilter || '').trim();
    var match = typeof matcherFn === 'function' ? matcherFn : function (text, needle) {
      return String(text || '').toLowerCase().indexOf(String(needle || '').toLowerCase()) >= 0;
    };

    return (list || []).filter(function (k) {
      var matchesQuery = !q || match(k.name, q) || (k.phone && k.phone.indexOf(q) >= 0);
      var matchesStatus = !sf || k.statusKey === sf;
      return matchesQuery && matchesStatus;
    });
  }

  return {
    STATUS_KEYS: STATUS_KEYS,
    STATUS_LABELS: STATUS_LABELS,
    STATUS_BADGES: STATUS_BADGES,
    setAvailabilityHelper: setAvailabilityHelper,
    getStructuredAvailability: getStructuredAvailability,
    isExcusedStatus: isExcusedStatus,
    resolveKhatibState: resolveKhatibState,
    filterKhatibs: filterKhatibs,
    escHtml: escHtml,
  };
});
