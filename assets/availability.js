/**
 * أوقاف 15 مايو والتبين — محرك وقواعد التوفر الشهري المتكرر للخطباء
 * واجهة المتصفح والبيئات المشتركة تحت نطاق KhatibAvailability
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.KhatibAvailability = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  var HIJRI_CALENDAR_POLICY = 'islamic-umalqura';
  var CAIRO_TIMEZONE = 'Africa/Cairo';

  var WEEK_ORDINAL_NAMES_AR = {
    1: 'الأولى',
    2: 'الثانية',
    3: 'الثالثة',
    4: 'الرابعة',
    5: 'الخامسة'
  };

  /**
   * تحليل تاريخ مدني ISO (YYYY-MM-DD) مع التحقق الصارم من التقويم
   */
  function parseCivilDate(isoDate) {
    if (typeof isoDate !== 'string') {
      throw new Error('تاريخ غير صالح: يجب إدخال نص بصيغة YYYY-MM-DD');
    }
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
    if (!match) {
      throw new Error('صيغة التاريخ غير صحيحة (المطلوب YYYY-MM-DD): "' + isoDate + '"');
    }

    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);

    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new Error('قيم التاريخ خارج النطاق المقبول: "' + isoDate + '"');
    }

    // 12:00:00 UTC لتفادي أي فروق في المناطق الزمنية
    var utcDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

    if (
      utcDate.getUTCFullYear() !== year ||
      utcDate.getUTCMonth() + 1 !== month ||
      utcDate.getUTCDate() !== day
    ) {
      throw new Error('تاريخ تقويمي مستحيل: "' + isoDate + '"');
    }

    return { year: year, month: month, day: day, utcDate: utcDate };
  }

  /**
   * التحقق من أن التاريخ جمعة فعلاً
   */
  function assertFriday(isoDate) {
    var parsed = parseCivilDate(isoDate);
    if (parsed.utcDate.getUTCDay() !== 5) {
      throw new Error('التاريخ المحدد لا يوافق يوم جمعة: "' + isoDate + '"');
    }
    return parsed;
  }

  /**
   * تحديد نوع التقويم حسب المنطقة أو الرمز
   */
  function resolveCalendar(regionOrCalendar) {
    if (regionOrCalendar === '15may' || regionOrCalendar === 'gregory') {
      return 'gregory';
    }
    if (regionOrCalendar === 'tebeen' || regionOrCalendar === 'islamic-umalqura') {
      return 'islamic-umalqura';
    }
    throw new Error('منطقة أو تقويم غير مدعوم: "' + regionOrCalendar + '"');
  }

  /**
   * استخراج أجزاء التاريخ للتقويم المحدد
   */
  function getCalendarDateParts(isoDate, regionOrCalendar) {
    var parsed = parseCivilDate(isoDate);
    var calendar = resolveCalendar(regionOrCalendar);

    if (calendar === 'gregory') {
      return {
        calendar: 'gregory',
        year: parsed.year,
        month: parsed.month,
        day: parsed.day,
        dayOfWeek: parsed.utcDate.getUTCDay()
      };
    }

    var dtf;
    try {
      dtf = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
        timeZone: CAIRO_TIMEZONE,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric'
      });
    } catch (e) {
      throw new Error('فشل تهيئة التقويم الهجري: ' + e.message);
    }

    var resolved = dtf.resolvedOptions();
    if (resolved.calendar !== 'islamic-umalqura') {
      throw new Error('التقويم الهجري المحدد (' + HIJRI_CALENDAR_POLICY + ') غير مدعوم في بيئة التشغيل الحالية');
    }

    var parts = dtf.formatToParts(parsed.utcDate);
    var pMap = {};
    for (var i = 0; i < parts.length; i++) {
      pMap[parts[i].type] = parts[i].value;
    }

    var hYear = Number(pMap.year);
    var hMonth = Number(pMap.month);
    var hDay = Number(pMap.day);

    if (!isFinite(hYear) || !isFinite(hMonth) || !isFinite(hDay)) {
      throw new Error('فشل قراءة تفاصيل التاريخ الهجري للتاريخ: "' + isoDate + '"');
    }

    return {
      calendar: 'islamic-umalqura',
      year: hYear,
      month: hMonth,
      day: hDay,
      dayOfWeek: parsed.utcDate.getUTCDay()
    };
  }

  /**
   * حساب ترتيب الجمعة الفعلي داخل شهرها (1 إلى 5)
   */
  function getFridayOrdinal(isoDate, regionOrCalendar) {
    assertFriday(isoDate);
    var parts = getCalendarDateParts(isoDate, regionOrCalendar);
    var ordinal = Math.floor((parts.day - 1) / 7) + 1;

    if (ordinal < 1 || ordinal > 5) {
      throw new Error('ترتيب الجمعة المحسوب خارج النطاق المقبول (1-5): ' + ordinal);
    }

    return ordinal;
  }

  /**
   * التحقق الصارم من صحة كائن التوفر.
   * يرفض null الصريح.
   * يتحقق من الجمع حتى لو كان النمط 'all' إن تم تمرير مصفوفة.
   */
  function validateAvailability(raw) {
    if (raw === null) {
      return {
        valid: false,
        error: 'بيانات التوفر الشهري لا يمكن أن تكون فارغة (null)'
      };
    }

    if (raw === undefined) {
      return {
        valid: true,
        value: { mode: 'all', weeks: [1, 2, 3, 4, 5] }
      };
    }

    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        valid: false,
        error: 'بيانات التوفر الشهري يجب أن تكون كائناً صحيحاً'
      };
    }

    var mode = raw.mode || raw.type;
    if (mode !== 'all' && mode !== 'custom') {
      return {
        valid: false,
        error: 'نوع التوفر الشهري يجب أن يكون "all" أو "custom"'
      };
    }

    if (mode === 'all') {
      // إن تم تمرير weeks في نمط all، يجب أن تكون مصفوفة صالحة بدون بيانات مشوهة
      if (raw.weeks !== undefined && raw.weeks !== null) {
        if (!Array.isArray(raw.weeks)) {
          return {
            valid: false,
            error: 'قائمة الجمع المحددة يجب أن تكون مصفوفة'
          };
        }
        var seenAll = {};
        for (var i = 0; i < raw.weeks.length; i++) {
          var w = raw.weeks[i];
          if (typeof w !== 'number' || Math.floor(w) !== w || w < 1 || w > 5) {
            return {
              valid: false,
              error: 'أرقام الجمع يجب أن تكون أرقاماً صحيحة بين 1 و 5'
            };
          }
          if (seenAll[w]) {
            return {
              valid: false,
              error: 'تكرار أرقام الجمع غير مسموح'
            };
          }
          seenAll[w] = true;
        }
      }
      return {
        valid: true,
        value: { mode: 'all', weeks: [1, 2, 3, 4, 5] }
      };
    }

    // mode === 'custom'
    if (!Array.isArray(raw.weeks)) {
      return {
        valid: false,
        error: 'قائمة الجمع المحددة يجب أن تكون مصفوفة أرقام'
      };
    }

    if (raw.weeks.length === 0) {
      return {
        valid: false,
        error: 'يجب اختيار جمعة واحدة على الأقل في النمط المخصص'
      };
    }

    var seen = {};
    var sortedWeeks = [];

    for (var j = 0; j < raw.weeks.length; j++) {
      var item = raw.weeks[j];
      if (typeof item !== 'number' || Math.floor(item) !== item || item < 1 || item > 5) {
        return {
          valid: false,
          error: 'أرقام الجمع يجب أن تكون أرقاماً صحيحة بين 1 و 5'
        };
      }
      if (seen[item]) {
        return {
          valid: false,
          error: 'تكرار أرقام الجمع غير مسموح (الجمعة ' + item + ' مكررة)'
        };
      }
      seen[item] = true;
      sortedWeeks.push(item);
    }

    sortedWeeks.sort(function (a, b) { return a - b; });

    return {
      valid: true,
      value: {
        mode: 'custom',
        weeks: sortedWeeks
      }
    };
  }

  function normalizeAvailability(raw) {
    var result = validateAvailability(raw);
    if (!result.valid) {
      throw new Error(result.error);
    }
    return result.value;
  }

  /**
   * استخراج وتدقيق قاعدة التوفر المخزنة في قاعدة البيانات.
   * - السجلات القديمة المحذوفة/الفارغة تُعامل كـ 'all'.
   * - السجلات المخصصة المشوهة أو التالفة تُعاد كـ 'invalid' بدلاً من اعتبارها متاحة في كل الجمعات.
   */
  function parseStoredAvailability(k) {
    if (!k || k.availability_mode === null || k.availability_mode === undefined) {
      return { mode: 'all', weeks: [1, 2, 3, 4, 5] };
    }

    var mode = k.availability_mode;
    if (mode === 'all') {
      if (!k.availability_weeks) {
        return { mode: 'all', weeks: [1, 2, 3, 4, 5] };
      }
      try {
        var parsedAll = typeof k.availability_weeks === 'string'
          ? JSON.parse(k.availability_weeks)
          : k.availability_weeks;
        var valAll = validateAvailability({ mode: 'all', weeks: parsedAll });
        if (!valAll.valid) {
          return {
            mode: 'invalid',
            weeks: [],
            error: valAll.error,
            rawMode: mode,
            rawWeeks: k.availability_weeks
          };
        }
        return valAll.value;
      } catch (e) {
        return {
          mode: 'invalid',
          weeks: [],
          error: 'صيغة JSON غير صحيحة للجمع المخزنة',
          rawMode: mode,
          rawWeeks: k.availability_weeks
        };
      }
    }

    if (mode === 'custom') {
      if (!k.availability_weeks) {
        return {
          mode: 'invalid',
          weeks: [],
          error: 'النمط المخصص يتطلب تحديد الجمع المتاحة',
          rawMode: mode,
          rawWeeks: null
        };
      }
      try {
        var parsedCustom = typeof k.availability_weeks === 'string'
          ? JSON.parse(k.availability_weeks)
          : k.availability_weeks;
        var valCustom = validateAvailability({ mode: 'custom', weeks: parsedCustom });
        if (!valCustom.valid) {
          return {
            mode: 'invalid',
            weeks: [],
            error: valCustom.error,
            rawMode: mode,
            rawWeeks: k.availability_weeks
          };
        }
        return valCustom.value;
      } catch (e) {
        return {
          mode: 'invalid',
          weeks: [],
          error: 'صيغة JSON غير صحيحة للجمع المخزنة',
          rawMode: mode,
          rawWeeks: k.availability_weeks
        };
      }
    }

    return {
      mode: 'invalid',
      weeks: [],
      error: 'نوع التوفر المخزن غير معروف: "' + mode + '"',
      rawMode: mode,
      rawWeeks: k.availability_weeks
    };
  }

  /**
   * صياغة نص عربي مقروء لقاعدة التوفر
   */
  function formatAvailabilityRule(availability, options) {
    options = options || {};
    if (!availability) return 'غير محدد';
    if (availability.mode === 'invalid') {
      return 'قاعدة تالفة (غير صالحة)';
    }

    var norm = validateAvailability(availability);
    if (!norm.valid) return 'غير محدد';

    var val = norm.value;
    if (val.mode === 'all' || val.weeks.length === 5) {
      return 'كل جمعة';
    }

    var names = val.weeks.map(function (w) {
      return WEEK_ORDINAL_NAMES_AR[w] || String(w);
    });

    var joinedText = '';
    if (names.length === 1) {
      joinedText = names[0];
    } else if (names.length === 2) {
      joinedText = names[0] + ' و' + names[1];
    } else {
      joinedText = names.slice(0, -1).join('، ') + ' و' + names[names.length - 1];
    }

    if (options.short) {
      return joinedText;
    }

    var prefix = options.prefix !== undefined ? options.prefix : 'الجمعة ';
    var suffix = options.suffix !== undefined ? options.suffix : ' من كل شهر';
    return prefix + joinedText + suffix;
  }

  /**
   * فحص مطابقة التوفر لخطيب في تاريخ جمعة محدد ومنطقة محددة.
   * إذا كانت القاعدة المخزنة تالفة أو غير صالحة، تعيد false دائماً.
   */
  function isKhatibAvailable(availabilityOrKhatib, isoDate, regionOrCalendar) {
    assertFriday(isoDate);

    var avail = availabilityOrKhatib;
    if (avail && typeof avail === 'object' && avail.availability) {
      avail = avail.availability;
    }

    if (!avail || avail.mode === 'invalid') {
      return false;
    }

    var norm = normalizeAvailability(avail);
    if (norm.mode === 'all') {
      return true;
    }

    var ordinal = getFridayOrdinal(isoDate, regionOrCalendar);
    return norm.weeks.indexOf(ordinal) >= 0;
  }

  return {
    HIJRI_CALENDAR_POLICY: HIJRI_CALENDAR_POLICY,
    WEEK_ORDINAL_NAMES_AR: WEEK_ORDINAL_NAMES_AR,
    parseCivilDate: parseCivilDate,
    assertFriday: assertFriday,
    resolveCalendar: resolveCalendar,
    getCalendarDateParts: getCalendarDateParts,
    getFridayOrdinal: getFridayOrdinal,
    validateAvailability: validateAvailability,
    normalizeAvailability: normalizeAvailability,
    parseStoredAvailability: parseStoredAvailability,
    formatAvailabilityRule: formatAvailabilityRule,
    isKhatibAvailable: isKhatibAvailable
  };
}));
