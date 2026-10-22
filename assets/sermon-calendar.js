/**
 * sermon-calendar.js — مغلّف العرض والتقويم المشترك بين شاشات خطب الجمعة
 * يتعامل مع التقويم الهجري (أم القرى) لمنطقة التبين والميلادي لمنطقة 15 مايو
 * بالاعتماد الحصري على وحدة KhatibAvailability الأساسية دون تكرار خوارزميات التقويم.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SermonCalendar = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  var HIJRI_MONTHS_AR = [
    'المحرّم', 'صفر', 'ربيع الأول', 'ربيع الآخر',
    'جمادى الأولى', 'جمادى الآخرة', 'رجب', 'شعبان',
    'رمضان', 'شوّال', 'ذو القعدة', 'ذو الحجة'
  ];

  var GREGORIAN_MONTHS_AR = [
    'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'
  ];

  var HIJRI_FAILURE_NOTE = ' (تعذر عرض التاريخ الهجري)';

  var customFoundation = null;

  function setFoundation(foundation) {
    customFoundation = foundation;
  }

  function getFoundation() {
    if (customFoundation) return customFoundation;
    if (typeof KhatibAvailability !== 'undefined' && KhatibAvailability) {
      return KhatibAvailability;
    }
    if (typeof globalThis !== 'undefined' && globalThis.KhatibAvailability) {
      return globalThis.KhatibAvailability;
    }
    if (typeof window !== 'undefined' && window.KhatibAvailability) {
      return window.KhatibAvailability;
    }
    return null;
  }

  function getActiveRegion() {
    if (typeof REGION_ID !== 'undefined' && REGION_ID) {
      return REGION_ID;
    }
    return '15may';
  }

  function isTebeen(region) {
    var r = region || getActiveRegion();
    return r === 'tebeen';
  }

  function formatGregorian(isoDate) {
    if (!isoDate || typeof isoDate !== 'string') return '';
    if (typeof formatDate === 'function') {
      try {
        return formatDate(isoDate);
      } catch (e) {}
    }
    var p = String(isoDate).trim().split('-');
    if (p.length !== 3) return isoDate;
    var day = Number(p[2]);
    var month = Number(p[1]);
    var year = Number(p[0]);
    var mName = GREGORIAN_MONTHS_AR[month - 1] || String(month);
    return day + ' ' + mName + ' ' + year;
  }

  function isFriday(isoDate) {
    if (!isoDate || typeof isoDate !== 'string') return false;
    var foundation = getFoundation();
    if (foundation && typeof foundation.parseCivilDate === 'function') {
      try {
        var parsed = foundation.parseCivilDate(isoDate);
        return parsed.utcDate.getUTCDay() === 5;
      } catch (e) {
        return false;
      }
    }
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
    if (!m) return false;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0));
    return d.getUTCDay() === 5;
  }

  function isSpecialDate(isoDate) {
    return !isFriday(isoDate);
  }

  /**
   * تنسيق التاريخ وفق سياسة المنطقة:
   * - التبين: هجري + ترتيب الجمعة + سياق ميلادي
   * - 15 مايو: ميلادي دون تغيير
   * - المناسبات الخاصة (غير الجمعة): هجري + سياق ميلادي بدون ترتيب جمعة، ولا تسبب أي خطأ
   */
  function formatDatePresentation(isoDate, region) {
    if (!isoDate || typeof isoDate !== 'string') return '';
    var r = region || getActiveRegion();

    if (!isTebeen(r)) {
      return formatGregorian(isoDate);
    }

    var foundation = getFoundation();
    if (!foundation || typeof foundation.getCalendarDateParts !== 'function') {
      return formatGregorian(isoDate) + HIJRI_FAILURE_NOTE;
    }

    try {
      var parts = foundation.getCalendarDateParts(isoDate, 'tebeen');
      var mName = HIJRI_MONTHS_AR[parts.month - 1] || ('شهر ' + parts.month);
      var hijriText = parts.day + ' ' + mName + ' ' + parts.year + ' هـ';
      var gregContext = formatGregorian(isoDate);

      // في حال كانت جمعة عادية، يُضاف ترتيب الجمعة داخل الشهر الهجري
      if (isFriday(isoDate) && typeof foundation.getFridayOrdinal === 'function') {
        var ord = foundation.getFridayOrdinal(isoDate, 'tebeen');
        var ordName = (foundation.WEEK_ORDINAL_NAMES_AR && foundation.WEEK_ORDINAL_NAMES_AR[ord]) || String(ord);
        return 'الجمعة ' + ordName + ' — ' + hijriText + ' (الموافق ' + gregContext + ')';
      }

      // مناسبة خاصة غير يوم الجمعة: عرض هجري مع سياق ميلادي بدون خطأ وبدون ترتيب جمعة
      return hijriText + ' (الموافق ' + gregContext + ')';
    } catch (e) {
      return formatGregorian(isoDate) + HIJRI_FAILURE_NOTE;
    }
  }

  /**
   * فحص توفر الخطيب وفق قاعدته الشهرية
   * - التواريخ الخاصة غير الجمعة: تعيد true محايداً دون تطبيق التكرار الأسبوعي
   */
  function isKhatibAvailable(khatib, isoDate, region) {
    if (!isoDate) return true;
    if (isSpecialDate(isoDate)) {
      return true; // المناسبات الخاصة لا تطبق تكرار الجمعات
    }

    var foundation = getFoundation();
    if (!foundation || typeof foundation.isKhatibAvailable !== 'function') {
      throw new Error('وحدة التوفر الأساسية (KhatibAvailability) غير متوفرة');
    }

    var r = region || getActiveRegion();
    return foundation.isKhatibAvailable(khatib, isoDate, r);
  }

  function formatRule(ruleOrKhatib, options) {
    var foundation = getFoundation();
    if (!foundation || typeof foundation.formatAvailabilityRule !== 'function') {
      throw new Error('وحدة التوفر الأساسية (KhatibAvailability) غير متوفرة');
    }
    var rule = ruleOrKhatib;
    if (rule && typeof rule === 'object' && rule.availability) {
      rule = rule.availability;
    }
    return foundation.formatAvailabilityRule(rule, options);
  }

  return {
    setFoundation: setFoundation,
    getFoundation: getFoundation,
    getActiveRegion: getActiveRegion,
    isTebeen: isTebeen,
    isFriday: isFriday,
    isSpecialDate: isSpecialDate,
    formatDate: formatDatePresentation,
    isKhatibAvailable: isKhatibAvailable,
    formatRule: formatRule,
  };
});
