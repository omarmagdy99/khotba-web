/**
 * أوقاف 15 مايو — تنسيق خطب الجمعة
 * Apps Script backend. See docs/API.md and docs/DATA-MODEL.md.
 *
 * FIRST RUN: open this file in the Apps Script editor, pick `setup` from the
 * function dropdown, and press Run. It creates every tab with its headers,
 * formats, and seed settings. It is safe to run again — it never touches a tab
 * that already exists.
 */

// ─────────────────────────────────────────────────────────── schema

var TABS = {
  mosques: ['id', 'name', 'mujawra', 'address', 'permanent_khatib_id', 'active', 'created_at'],
  khatibs: ['id', 'name', 'phone', 'type', 'notes', 'active', 'created_at'],
  preferences: ['khatib_id', 'mosque_id'],
  assignments: ['id', 'date', 'mosque_id', 'khatib_id', 'status', 'date_type', 'label', 'updated_by', 'updated_at'],
  users: ['username', 'display_name', 'password_hash', 'salt', 'active', 'created_at'],
  sessions: ['token', 'username', 'expires_at'],
  settings: ['key', 'value'],
};

// Columns that must stay plain text so Sheets cannot reinterpret them.
var TEXT_COLUMNS = {
  mosques: ['id', 'permanent_khatib_id', 'created_at'],
  khatibs: ['id', 'phone', 'created_at'],
  preferences: ['khatib_id', 'mosque_id'],
  assignments: ['id', 'date', 'mosque_id', 'khatib_id', 'updated_at'],
  users: ['created_at'],
  sessions: ['expires_at'],
  settings: ['value'],
};

var SESSION_DAYS = 7;
var LOCK_MS = 20000;

/**
 * رقم النسخة. غيّره مع أي تعديل تنشره.
 *
 * افتح عنوان النشر وحط ?ping=1 في آخره عشان تشوف النسخة المنشورة فعلاً
 * وقائمة الإجراءات اللي فيها. لو الرقم قديم يبقى النشر مأخدش الكود الجديد —
 * وده بيحصل لما تحفظ في المحرر من غير ما تعمل Deploy → New version.
 */
var SCRIPT_VERSION = '2026-07-26';

// ─────────────────────────────────────────────────────────── setup

function setup() {
  var ss = SpreadsheetApp.getActive();
  var made = [], skipped = [];

  Object.keys(TABS).forEach(function (name) {
    if (ss.getSheetByName(name)) { skipped.push(name); return; }

    var sh = ss.insertSheet(name);
    var headers = TABS[name];

    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#1e3c5c').setFontColor('#ffffff');
    sh.setFrozenRows(1);

    // Plain-text format on whole columns, so manual entry behaves too.
    (TEXT_COLUMNS[name] || []).forEach(function (col) {
      var i = headers.indexOf(col);
      if (i >= 0) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });

    sh.autoResizeColumns(1, headers.length);
    made.push(name);
  });

  // sessions and users hold credentials — keep them out of sight.
  ['users', 'sessions'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh && !sh.isSheetHidden()) sh.hideSheet();
  });

  seedSettings_();

  var d = ss.getSheetByName('Sheet1') || ss.getSheetByName('ورقة1');
  if (d && ss.getSheets().length > 1 && d.getLastRow() === 0) ss.deleteSheet(d);

  var msg = 'تم إنشاء: ' + (made.join('، ') || 'لا شيء') +
    (skipped.length ? '\nموجودة بالفعل ولم تُمس: ' + skipped.join('، ') : '');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  return msg;
}

function seedSettings_() {
  var sh = sheet_('settings');
  var have = {};
  readTab_('settings').forEach(function (r) { have[r.key] = true; });

  var defaults = [
    ['publish_from', ''],
    ['publish_to', ''],
    ['next_mosque_seq', '86'],
    ['next_khatib_seq', '132'],
  ];
  var add = defaults.filter(function (d) { return !have[d[0]]; });
  if (!add.length) return;

  var start = sh.getLastRow() + 1;
  sh.getRange(start, 1, add.length, 2).setNumberFormat('@').setValues(add);
}

/**
 * Run once per staff member, then clear the values. Never commit a password.
 */
function createUser() {
  var username = 'admin';
  var displayName = 'المشرف';
  var password = 'CHANGE-ME';

  if (password === 'CHANGE-ME') throw new Error('غيّر كلمة المرور في الكود قبل التشغيل');

  var salt = Utilities.getUuid().replace(/-/g, '');
  var sh = sheet_('users');
  sh.appendRow([username, displayName, sha256_(salt + password), salt, 'TRUE', nowIso_()]);
  Logger.log('تم إنشاء المستخدم: ' + username);
}

// ─────────────────────────────────────────────────────────── entry points

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    return json_(route_(body));
  } catch (err) {
    console.error(err.stack || String(err));
    return json_(err_('INTERNAL', String(err && err.message || err)));
  }
}

function doGet(e) {
  try {
    if (e && e.parameter && e.parameter.ping) {
      return json_(ok_({ version: SCRIPT_VERSION, actions: KNOWN_ACTIONS }));
    }
    return json_(publicSchedule_((e && e.parameter && e.parameter.date) || ''));
  } catch (err) {
    console.error(err.stack || String(err));
    return json_(err_('INTERNAL', String(err && err.message || err)));
  }
}

var KNOWN_ACTIONS = [
  'login', 'logout', 'whoami',
  'listMosques', 'listKhatibs', 'getSchedule', 'getKhatibSchedule', 'listDates',
  'getLoadCounts', 'getSettings',
  'createMosque', 'updateMosque', 'deactivateMosque',
  'createKhatib', 'updateKhatib', 'deactivateKhatib', 'setPreferences',
  'generateDate', 'regenerateDate', 'saveSchedule', 'publishRange',
];

function getCachedJson_(key, fetchFn, ttlSeconds) {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(key);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }
  var data = fetchFn();
  try {
    cache.put(key, JSON.stringify(data), ttlSeconds || 600);
  } catch (e) {}
  return data;
}

function invalidateServerCache_() {
  try {
    var cache = CacheService.getScriptCache();
    cache.removeAll(['mosques_inc', 'mosques_act', 'khatibs_inc', 'khatibs_act', 'settings_map']);
  } catch (e) {}
}

function route_(b) {
  var a = b.action;

  if (a === 'login') return login_(b);
  if (a === 'logout') return logout_(b);

  var user = auth_(b.token);
  if (!user) return err_('UNAUTHENTICATED', 'انتهت الجلسة، سجّل الدخول من جديد');

  switch (a) {
    case 'whoami':            return ok_({ username: user.username, displayName: user.display_name });
    case 'listMosques':       
      var mKey = 'mosques_' + (b.includeInactive ? 'inc' : 'act');
      var mRes = getCachedJson_(mKey, function () { return { mosques: listMosques_(b.includeInactive).map(publicMosque_) }; }, 600);
      return ok_(mRes);
    case 'listKhatibs':       
      var kKey = 'khatibs_' + (b.includeInactive ? 'inc' : 'act');
      var kRes = getCachedJson_(kKey, function () { return { khatibs: listKhatibs_(b.includeInactive).map(publicKhatib_) }; }, 600);
      return ok_(kRes);
    case 'getSchedule':       return getSchedule_(b.date);
    case 'getKhatibSchedule': return getKhatibSchedule_(b.khatibId, b.from, b.to);
    case 'listDates':         return ok_({ dates: listDates_() });
    case 'getLoadCounts':     return ok_({ counts: loadCounts_(b.from, b.to) });
    case 'createMosque':      invalidateServerCache_(); return saveMosque_(b, user, true);
    case 'updateMosque':      invalidateServerCache_(); return saveMosque_(b, user, false);
    case 'deactivateMosque':  invalidateServerCache_(); return deactivate_('mosques', b.id, user);
    case 'createKhatib':      invalidateServerCache_(); return saveKhatib_(b, user, true);
    case 'updateKhatib':      invalidateServerCache_(); return saveKhatib_(b, user, false);
    case 'deactivateKhatib':  invalidateServerCache_(); return deactivate_('khatibs', b.id, user);
    case 'setPreferences':    invalidateServerCache_(); return setPreferences_(b.khatibId, b.mosqueIds);
    case 'generateDate':      return generateDate_(b, user);
    case 'regenerateDate':    return regenerateDate_(b, user);
    case 'saveSchedule':      return saveSchedule_(b, user);
    case 'publishRange':      invalidateServerCache_(); return publishRange_(b.from, b.to);
    case 'getSettings':       
      var sRes = getCachedJson_('settings_map', function () { return { settings: settingsMap_() }; }, 600);
      return ok_(sRes);
  }
  // الإجراء موجود في القائمة بس مفيش له case — يعني الكود اتنشر ناقص.
  var hint = KNOWN_ACTIONS.indexOf(a) >= 0
    ? ' — الكود المنشور نسخة قديمة. أعد النشر: Deploy → Manage deployments → New version'
    : '';
  return err_('BAD_REQUEST', 'إجراء غير معروف: ' + a + hint);
}

// ─────────────────────────────────────────────────────────── auth

function login_(b) {
  var u = readTab_('users').filter(function (r) {
    return r.username === String(b.username || '').trim() && isTrue_(r.active);
  })[0];

  // Same message either way — never reveal which half was wrong.
  var bad = err_('UNAUTHENTICATED', 'اسم المستخدم أو كلمة المرور غير صحيحة');
  if (!u) return bad;
  if (sha256_(u.salt + String(b.password || '')) !== u.password_hash) return bad;

  var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  sheet_('sessions').appendRow([token, u.username, expires]);

  return ok_({ token: token, displayName: u.display_name, expiresAt: expires });
}

function logout_(b) {
  var rows = readTab_('sessions');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].token === b.token) { sheet_('sessions').deleteRow(i + 2); break; }
  }
  return ok_({});
}

function auth_(token) {
  if (!token) return null;
  var s = readTab_('sessions').filter(function (r) { return r.token === token; })[0];
  if (!s) return null;
  // Expiry is checked independently of cleanup, so a missed sweep is never a hole.
  if (new Date(s.expires_at) < new Date()) return null;
  return readTab_('users').filter(function (r) {
    return r.username === s.username && isTrue_(r.active);
  })[0] || null;
}

/** Optional nightly trigger. */
function purgeSessions() {
  var sh = sheet_('sessions'), rows = readTab_('sessions'), now = new Date();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (new Date(rows[i].expires_at) < now) sh.deleteRow(i + 2);
  }
}

// ─────────────────────────────────────────────────────────── mosques & khatibs

/**
 * الشيت snake_case والـ JSON camelCase. التحويل بيحصل عند حدود الـ API فقط —
 * الدوال الداخلية زي generateDate_ بتفضل تشتغل على صفوف الشيت الخام.
 */
function publicMosque_(m) {
  return {
    id: m.id, name: m.name, mujawra: m.mujawra, address: m.address,
    permanentKhatibId: m.permanent_khatib_id, active: isTrue_(m.active),
  };
}

function publicKhatib_(k) {
  return {
    id: k.id, name: k.name, phone: k.phone, type: k.type, notes: k.notes,
    active: isTrue_(k.active), preferences: k.preferences || [],
  };
}

function listMosques_(includeInactive) {
  return readTab_('mosques').filter(function (m) {
    return includeInactive || isTrue_(m.active);
  });
}

function listKhatibs_(includeInactive) {
  var prefs = {};
  readTab_('preferences').forEach(function (p) {
    (prefs[p.khatib_id] = prefs[p.khatib_id] || []).push(p.mosque_id);
  });
  return readTab_('khatibs')
    .filter(function (k) { return includeInactive || isTrue_(k.active); })
    .map(function (k) { k.preferences = prefs[k.id] || []; return k; });
}

function saveMosque_(b, user, isNew) {
  var name = String(b.name || '').trim();
  var mujawra = String(b.mujawra || '').trim();
  if (!name || !mujawra) return err_('BAD_REQUEST', 'اسم المسجد والمجاورة مطلوبان');

  var rows = readTab_('mosques');

  // Identity is (name, mujawra): the same name may repeat across zones,
  // but never twice inside one zone.
  var clash = rows.filter(function (m) {
    return m.id !== b.id &&
      norm_(m.name) === norm_(name) && norm_(m.mujawra) === norm_(mujawra);
  })[0];
  if (clash) return err_('DUPLICATE', 'يوجد مسجد بنفس الاسم في نفس المجاورة');

  var pk = String(b.permanentKhatibId || '').trim();
  if (pk) {
    var taken = rows.filter(function (m) {
      return m.id !== b.id && m.permanent_khatib_id === pk;
    })[0];
    if (taken) return err_('PERMANENT_CONFLICT', 'هذا الخطيب ثابت بالفعل في: ' + taken.name + ' ' + taken.mujawra);
  }

  var sh = sheet_('mosques');
  if (isNew) {
    var id = nextId_('next_mosque_seq', 'M');
    appendRow_(sh, 'mosques', [id, name, mujawra, b.address || '', pk, 'TRUE', nowIso_()]);
    return ok_({ id: id });
  }

  var i = indexOf_(rows, 'id', b.id);
  if (i < 0) return err_('NOT_FOUND', 'المسجد غير موجود');
  writeRow_(sh, 'mosques', i + 2, [
    b.id, name, mujawra, b.address || '', pk,
    b.active === false ? 'FALSE' : 'TRUE', rows[i].created_at,
  ]);
  return ok_({ id: b.id });
}

function saveKhatib_(b, user, isNew) {
  var name = String(b.name || '').trim();
  if (!name) return err_('BAD_REQUEST', 'اسم الخطيب مطلوب');

  // Phone is optional for now — the office is still collecting them.
  var phone = String(b.phone || '').replace(/[\s\-()]/g, '');
  if (phone && !/^01\d{9}$/.test(phone)) {
    return err_('BAD_REQUEST', 'رقم الموبايل لازم يكون 11 رقم ويبدأ بـ 01');
  }

  var type = b.type === 'volunteer' ? 'volunteer' : 'primary';
  var rows = readTab_('khatibs');
  var sh = sheet_('khatibs');

  if (isNew) {
    var id = nextId_('next_khatib_seq', 'K');
    appendRow_(sh, 'khatibs', [id, name, phone, type, b.notes || '', 'TRUE', nowIso_()]);
    // Warn on a near-duplicate but never block: two people can share a name.
    var similar = rows.filter(function (k) { return norm_(k.name) === norm_(name); })
                      .map(function (k) { return k.id; });
    return ok_({ id: id, similarTo: similar });
  }

  var i = indexOf_(rows, 'id', b.id);
  if (i < 0) return err_('NOT_FOUND', 'الخطيب غير موجود');
  writeRow_(sh, 'khatibs', i + 2, [
    b.id, name, phone, type, b.notes || '',
    b.active === false ? 'FALSE' : 'TRUE', rows[i].created_at,
  ]);
  return ok_({ id: b.id });
}

/**
 * Deactivation cascades. A flag on its own would leave a deactivated khatib
 * pinned as someone's permanent preacher and quietly re-assigned every week.
 */
function deactivate_(tab, id, user) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) return err_('LOCKED', 'النظام مشغول، حاول بعد لحظات');

  try {
    var rows = readTab_(tab);
    var i = indexOf_(rows, 'id', id);
    if (i < 0) return err_('NOT_FOUND', 'غير موجود');

    var sh = sheet_(tab);
    sh.getRange(i + 2, TABS[tab].indexOf('active') + 1).setValue('FALSE');

    var today = todayIso_();
    var aRows = readTab_('assignments');
    var aSheet = sheet_('assignments');
    var cleared = [], clearedPermanent = [];

    if (tab === 'khatibs') {
      readTab_('mosques').forEach(function (m, mi) {
        if (m.permanent_khatib_id === id) {
          sheet_('mosques').getRange(mi + 2, TABS.mosques.indexOf('permanent_khatib_id') + 1).setValue('');
          clearedPermanent.push(m.name + ' ' + m.mujawra);
        }
      });
      aRows.forEach(function (a, ai) {
        if (a.khatib_id === id && a.date >= today) {
          aSheet.getRange(ai + 2, TABS.assignments.indexOf('khatib_id') + 1).setValue('');
          aSheet.getRange(ai + 2, TABS.assignments.indexOf('status') + 1).setValue('unassigned');
          stamp_(aSheet, ai + 2, user);
          cleared.push({ date: a.date, mosqueId: a.mosque_id });
        }
      });
    } else {
      // المسجد بيتوقف: الخطب القادمة اللي لسه مالهاش خطيب تتشال من الحساب،
      // واللي ليها خطيب تتساب ويترد بعددها عشان الموظف ياخد باله.
      var stillAssigned = 0;
      aRows.forEach(function (a, ai) {
        if (a.mosque_id !== id || a.date < today) return;
        if (a.khatib_id) { stillAssigned++; return; }
        aSheet.getRange(ai + 2, TABS.assignments.indexOf('status') + 1).setValue('unassigned');
        cleared.push({ date: a.date, mosqueId: a.mosque_id });
      });
      return ok_({ clearedAssignments: cleared, clearedPermanentAt: [], stillAssigned: stillAssigned });
    }

    return ok_({ clearedAssignments: cleared, clearedPermanentAt: clearedPermanent });
  } finally {
    lock.releaseLock();
  }
}

function setPreferences_(khatibId, mosqueIds) {
  if (!khatibId) return err_('BAD_REQUEST', 'khatibId مطلوب');
  var ids = (mosqueIds || []).filter(function (v, i, arr) { return v && arr.indexOf(v) === i; });

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) return err_('LOCKED', 'النظام مشغول، حاول بعد لحظات');

  try {
    var sh = sheet_('preferences');
    var rows = readTab_('preferences');
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i].khatib_id === khatibId) sh.deleteRow(i + 2);
    }
    if (ids.length) {
      var start = sh.getLastRow() + 1;
      sh.getRange(start, 1, ids.length, 2).setNumberFormat('@')
        .setValues(ids.map(function (m) { return [khatibId, m]; }));
    }
    return ok_({ count: ids.length });
  } finally {
    lock.releaseLock();
  }
}

// ─────────────────────────────────────────────────────────── scheduling

function getSchedule_(date) {
  if (!isIsoDate_(date)) return err_('BAD_REQUEST', 'تاريخ غير صحيح');

  var mosques = {}; readTab_('mosques').forEach(function (m) { mosques[m.id] = m; });
  var khatibs = {}; readTab_('khatibs').forEach(function (k) { khatibs[k.id] = k; });

  var rows = readTab_('assignments').filter(function (a) { return a.date === date; });
  var version = '';
  var out = rows.map(function (a) {
    if (a.updated_at > version) version = a.updated_at;
    var m = mosques[a.mosque_id] || {};
    return {
      mosqueId: a.mosque_id,
      mosque: m.name || '?',
      mujawra: m.mujawra || '',
      khatibId: a.khatib_id,
      khatib: a.khatib_id ? (khatibs[a.khatib_id] || {}).name || '?' : '',
      status: a.status,
      dateType: a.date_type,
      label: a.label,
      updatedBy: a.updated_by,
      updatedAt: a.updated_at,
    };
  });

  return ok_({ date: date, exists: out.length > 0, version: version, rows: out });
}

function getKhatibSchedule_(khatibId, from, to) {
  if (!khatibId) return err_('BAD_REQUEST', 'khatibId مطلوب');
  var mosques = {}; readTab_('mosques').forEach(function (m) { mosques[m.id] = m; });

  var rows = readTab_('assignments')
    .filter(function (a) {
      return a.khatib_id === khatibId &&
        (!from || a.date >= from) && (!to || a.date <= to);
    })
    .sort(function (x, y) { return x.date < y.date ? -1 : 1; })
    .map(function (a) {
      var m = mosques[a.mosque_id] || {};
      return {
        date: a.date, mosqueId: a.mosque_id, mosque: m.name || '?',
        mujawra: m.mujawra || '', status: a.status, label: a.label,
      };
    });

  return ok_({ khatibId: khatibId, count: rows.length, rows: rows });
}

/**
 * عدد الخطب لكل خطيب في فترة. مسحة واحدة على التبويب — البديل كان
 * الواجهة تطلب كل جمعة على حدة، يعني 8 طلبات وثواني ضايعة على كل تحميل.
 */
function loadCounts_(from, to) {
  var c = {};
  readTab_('assignments').forEach(function (a) {
    if (!a.khatib_id) return;
    if (from && a.date < from) return;
    if (to && a.date > to) return;
    c[a.khatib_id] = (c[a.khatib_id] || 0) + 1;
  });
  return c;
}

function listDates_() {
  var byDate = {};
  readTab_('assignments').forEach(function (a) {
    var d = byDate[a.date] || (byDate[a.date] = { date: a.date, total: 0, filled: 0, label: a.label, dateType: a.date_type });
    d.total++;
    if (a.khatib_id) d.filled++;
  });
  return Object.keys(byDate).sort().map(function (k) { return byDate[k]; });
}

/**
 * Creates one row per active mosque for a date, pre-filling permanent khatibs.
 * The existence check lives INSIDE the lock — without that, two admins clicking
 * at once both see zero rows and both append, leaving duplicate ids.
 */
function generateDate_(b, user) {
  var date = b.date;
  var dateType = b.dateType === 'special' ? 'special' : 'friday';
  var label = String(b.label || '').trim();

  if (!isIsoDate_(date)) return err_('BAD_REQUEST', 'تاريخ غير صحيح');
  if (dateType === 'friday' && !isFriday_(date)) return err_('BAD_REQUEST', 'اختر يوم جمعة');
  if (dateType === 'special' && !label) return err_('BAD_REQUEST', 'اكتب اسم المناسبة');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) return err_('LOCKED', 'النظام مشغول، حاول بعد لحظات');

  try {
    var existing = readTab_('assignments').filter(function (a) { return a.date === date; });
    if (existing.length) return getSchedule_(date);

    var now = nowIso_();
    var rows = listMosques_(false).map(function (m) {
      var pk = m.permanent_khatib_id || '';
      return [date + '_' + m.id, date, m.id, pk, pk ? 'confirmed' : 'unassigned',
              dateType, label, user.username, now];
    });
    if (!rows.length) return err_('BAD_REQUEST', 'لا توجد مساجد نشطة');

    var sh = sheet_('assignments');
    var start = sh.getLastRow() + 1;
    sh.getRange(start, 1, rows.length, TABS.assignments.length).setValues(rows);
    applyTextFormat_(sh, 'assignments', start, rows.length);

    var res = getSchedule_(date);
    res.data.created = rows.length;
    res.data.prefilled = rows.filter(function (r) { return r[3]; }).length;
    return res;
  } finally {
    lock.releaseLock();
  }
}

/**
 * إعادة توليد تاريخ موجود بالفعل.
 *
 * mode = 'fill'  (الافتراضي، غير مدمّر):
 *   - بيضيف صفوف للمساجد اللي اتعملت بعد ما التاريخ اتولّد. من غير ده
 *     المسجد الجديد بيختفي من الجمعة دي تمامًا.
 *   - بيملّي المساجد الفاضية بخطيبها الثابت، لو مش محجوز في مكان تاني.
 *   - مبيلمسش أي توزيع اتعمل بالإيد.
 *
 * mode = 'reset' (مدمّر):
 *   - بيمسح كل التوزيع في التاريخ ده ويرجّع الخطباء الثابتين بس.
 *   - الواجهة بتطلب تأكيد صريح قبله.
 */
function regenerateDate_(b, user) {
  var date = b.date;
  var mode = b.mode === 'reset' ? 'reset' : 'fill';
  if (!isIsoDate_(date)) return err_('BAD_REQUEST', 'تاريخ غير صحيح');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) return err_('LOCKED', 'النظام مشغول، حاول بعد لحظات');

  try {
    var all = readTab_('assignments');
    var onDate = {}, rowIdx = {}, dateType = 'friday', label = '';
    all.forEach(function (a, i) {
      if (a.date !== date) return;
      onDate[a.mosque_id] = a;
      rowIdx[a.mosque_id] = i + 2;
      if (a.date_type) dateType = a.date_type;
      if (a.label) label = a.label;
    });

    if (!Object.keys(onDate).length) {
      return err_('NOT_FOUND', 'التاريخ ده لسه متولّدش — استخدم "توليد الجمعة"');
    }

    var sh = sheet_('assignments');
    var now = nowIso_();
    var kCol = TABS.assignments.indexOf('khatib_id') + 1;
    var sCol = TABS.assignments.indexOf('status') + 1;
    var cleared = 0;

    if (mode === 'reset') {
      for (var mid in onDate) {
        if (onDate[mid].khatib_id) cleared++;
        sh.getRange(rowIdx[mid], kCol).setNumberFormat('@').setValue('');
        sh.getRange(rowIdx[mid], sCol).setValue('unassigned');
        stamp_(sh, rowIdx[mid], user);
        onDate[mid].khatib_id = '';
      }
    }

    // مين محجوز فعلاً في التاريخ ده دلوقتي
    var taken = {};
    for (var m2 in onDate) if (onDate[m2].khatib_id) taken[onDate[m2].khatib_id] = true;

    var mosques = listMosques_(false);
    var added = [], filled = 0, skipped = [];
    var newRows = [];

    mosques.forEach(function (m) {
      var pk = m.permanent_khatib_id || '';

      if (!onDate[m.id]) {
        var assign = (pk && !taken[pk]) ? pk : '';
        if (assign) taken[assign] = true;
        else if (pk) skipped.push(m.name + ' ' + m.mujawra);
        newRows.push([date + '_' + m.id, date, m.id, assign,
                      assign ? 'confirmed' : 'unassigned', dateType, label, user.username, now]);
        added.push(m.name + ' ' + m.mujawra);
        return;
      }

      if (!pk || onDate[m.id].khatib_id) return;
      if (taken[pk]) { skipped.push(m.name + ' ' + m.mujawra); return; }

      sh.getRange(rowIdx[m.id], kCol).setNumberFormat('@').setValue(pk);
      sh.getRange(rowIdx[m.id], sCol).setValue('confirmed');
      stamp_(sh, rowIdx[m.id], user);
      taken[pk] = true;
      filled++;
    });

    if (newRows.length) {
      var start = sh.getLastRow() + 1;
      sh.getRange(start, 1, newRows.length, TABS.assignments.length).setValues(newRows);
      applyTextFormat_(sh, 'assignments', start, newRows.length);
    }

    var res = getSchedule_(date);
    res.data.mode = mode;
    res.data.addedMosques = added;
    res.data.filled = filled;
    res.data.cleared = cleared;
    res.data.skipped = skipped;   // خطيب ثابت كان محجوز في مكان تاني
    return res;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Order matters: nothing is written unless every check passes. A half-applied
 * Friday is worse than a rejected save.
 */
function saveSchedule_(b, user) {
  var date = b.date;
  var changes = b.changes || [];
  if (!isIsoDate_(date)) return err_('BAD_REQUEST', 'تاريخ غير صحيح');
  if (!changes.length) return getSchedule_(date);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) return err_('LOCKED', 'النظام مشغول، حاول بعد لحظات');

  try {
    var all = readTab_('assignments');
    var onDate = {}, rowIndex = {};
    all.forEach(function (a, i) {
      if (a.date !== date) return;
      onDate[a.mosque_id] = a;
      rowIndex[a.mosque_id] = i + 2;
    });

    // 1. stale-write check, scoped to the mosques actually being touched
    var stale = [];
    changes.forEach(function (c) {
      var cur = onDate[c.mosqueId];
      if (cur && b.version && cur.updated_at > b.version) {
        stale.push({ mosqueId: c.mosqueId, updatedBy: cur.updated_by, updatedAt: cur.updated_at });
      }
    });
    if (stale.length) {
      return err_('STALE_WRITE', 'حد تاني عدّل نفس الصفوف دي', { conflicts: stale });
    }

    // 2. the payload against itself
    var seen = {};
    for (var i = 0; i < changes.length; i++) {
      var k = changes[i].khatibId;
      if (!k) continue;
      if (seen[k]) {
        return err_('KHATIB_DOUBLE_BOOKED', 'نفس الخطيب متكرر في مسجدين', {
          khatibId: k, mosques: [seen[k], changes[i].mosqueId] });
      }
      seen[k] = changes[i].mosqueId;
    }

    // 3. the payload against what is already saved for this date
    var mosqueNames = {}; readTab_('mosques').forEach(function (m) { mosqueNames[m.id] = m.name + ' ' + m.mujawra; });
    var changed = {}; changes.forEach(function (c) { changed[c.mosqueId] = true; });

    for (var j = 0; j < changes.length; j++) {
      var kid = changes[j].khatibId;
      if (!kid) continue;
      for (var mid in onDate) {
        if (mid === changes[j].mosqueId || changed[mid]) continue;
        if (onDate[mid].khatib_id === kid) {
          return err_('KHATIB_DOUBLE_BOOKED', 'الخطيب محجوز في: ' + (mosqueNames[mid] || mid), {
            khatibId: kid, conflictMosqueId: mid });
        }
      }
    }

    // 4. write
    var sh = sheet_('assignments');
    var now = nowIso_();
    var kCol = TABS.assignments.indexOf('khatib_id') + 1;
    var sCol = TABS.assignments.indexOf('status') + 1;

    changes.forEach(function (c) {
      var r = rowIndex[c.mosqueId];
      if (!r) return;
      var status = c.status || (c.khatibId ? 'confirmed' : 'unassigned');
      sh.getRange(r, kCol).setNumberFormat('@').setValue(c.khatibId || '');
      sh.getRange(r, sCol).setValue(status);
      stamp_(sh, r, user);
    });

    return getSchedule_(date);
  } finally {
    lock.releaseLock();
  }
}

function publishRange_(from, to) {
  if (from && !isIsoDate_(from)) return err_('BAD_REQUEST', 'تاريخ البداية غير صحيح');
  if (to && !isIsoDate_(to)) return err_('BAD_REQUEST', 'تاريخ النهاية غير صحيح');
  if (from && to && from > to) return err_('BAD_REQUEST', 'تاريخ البداية بعد تاريخ النهاية');
  setSetting_('publish_from', from || '');
  setSetting_('publish_to', to || '');
  return ok_({ from: from || '', to: to || '' });
}

// ─────────────────────────────────────────────────────────── public read

function publicSchedule_(date) {
  var s = settingsMap_();
  var from = s.publish_from, to = s.publish_to;
  if (!from || !to) return ok_({ published: false, dates: [], rows: [] });

  var mosques = {}; readTab_('mosques').forEach(function (m) { mosques[m.id] = m; });
  var khatibs = {}; readTab_('khatibs').forEach(function (k) { khatibs[k.id] = k; });

  var inWindow = readTab_('assignments').filter(function (a) {
    return a.date >= from && a.date <= to;
  });

  var dates = {};
  inWindow.forEach(function (a) { dates[a.date] = a.label || ''; });
  var dateList = Object.keys(dates).sort().map(function (d) { return { date: d, label: dates[d] }; });

  // Outside the window returns empty, never an error — the public endpoint
  // must not be usable to probe unpublished drafts.
  var target = date && dates.hasOwnProperty(date) ? date : (dateList[0] || {}).date || '';

  var rows = inWindow
    .filter(function (a) { return a.date === target; })
    .map(function (a) {
      var m = mosques[a.mosque_id] || {};
      return {
        mosque: m.name || '',
        mujawra: m.mujawra || '',
        khatib: a.khatib_id ? (khatibs[a.khatib_id] || {}).name || '' : '',
      };
    })
    .filter(function (r) { return r.mosque; })
    .sort(function (x, y) {
      return x.mujawra === y.mujawra
        ? (x.mosque < y.mosque ? -1 : 1)
        : (x.mujawra < y.mujawra ? -1 : 1);
    });

  return ok_({ published: true, date: target, dates: dateList, rows: rows });
}

// ─────────────────────────────────────────────────────────── helpers

function sheet_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('التبويب غير موجود: ' + name + ' — شغّل الدالة setup أولاً');
  return sh;
}

/** Reads a tab into objects keyed by header name. */
function readTab_(name) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var headers = TABS[name];
  var values = sh.getRange(2, 1, last - 1, headers.length).getValues();
  return values.map(function (row) {
    var o = {};
    headers.forEach(function (h, i) { o[h] = row[i] === null || row[i] === undefined ? '' : String(row[i]); });
    return o;
  });
}

function appendRow_(sh, tab, values) {
  var r = sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, values.length).setValues([values]);
  applyTextFormat_(sh, tab, r, 1);
}

function writeRow_(sh, tab, rowNum, values) {
  sh.getRange(rowNum, 1, 1, values.length).setValues([values]);
  applyTextFormat_(sh, tab, rowNum, 1);
}

/**
 * Re-asserts plain text on written cells. Column formatting set at setup time
 * is not always enough — Sheets can re-detect a type on newly written cells.
 */
function applyTextFormat_(sh, tab, startRow, numRows) {
  var headers = TABS[tab];
  (TEXT_COLUMNS[tab] || []).forEach(function (col) {
    var i = headers.indexOf(col);
    if (i >= 0) sh.getRange(startRow, i + 1, numRows, 1).setNumberFormat('@');
  });
}

function stamp_(sh, rowNum, user) {
  sh.getRange(rowNum, TABS.assignments.indexOf('updated_by') + 1).setValue(user.username);
  sh.getRange(rowNum, TABS.assignments.indexOf('updated_at') + 1)
    .setNumberFormat('@').setValue(nowIso_());
}

function indexOf_(rows, key, value) {
  for (var i = 0; i < rows.length; i++) if (rows[i][key] === value) return i;
  return -1;
}

function settingsMap_() {
  var m = {};
  readTab_('settings').forEach(function (r) { m[r.key] = r.value; });
  return m;
}

function setSetting_(key, value) {
  var sh = sheet_('settings'), rows = readTab_('settings');
  var i = indexOf_(rows, 'key', key);
  if (i >= 0) sh.getRange(i + 2, 2).setNumberFormat('@').setValue(value);
  else sh.appendRow([key, value]);
}

function nextId_(seqKey, prefix) {
  var n = parseInt(settingsMap_()[seqKey] || '1', 10);
  setSetting_(seqKey, String(n + 1));
  return prefix + String(n).padStart(3, '0');
}

/**
 * Sheets stores a TRUE cell as a real boolean, so getValues() returns `true`,
 * not the string 'TRUE'. Never compare directly.
 */
function isTrue_(v) { return String(v).toUpperCase() === 'TRUE'; }

/** Search and duplicate-detection only. Never store this, never key on it. */
function norm_(t) {
  return String(t || '').toLowerCase()
    .replace(/[أإآ]/g, 'ا').replace(/[ى]/g, 'ي').replace(/[ة]/g, 'ه')
    .replace(/[ؤ]/g, 'و').replace(/[ئ]/g, 'ي')
    .replace(/\s+/g, ' ').trim();
}

function sha256_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ((b & 0xff) + 0x100).toString(16).slice(1); }).join('');
}

function nowIso_() { return new Date().toISOString(); }

function todayIso_() {
  return Utilities.formatDate(new Date(), 'Africa/Cairo', 'yyyy-MM-dd');
}

function isIsoDate_(d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')); }

/** Parsed as UTC on purpose: a date-only string has no timezone. */
function isFriday_(d) {
  var p = String(d).split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay() === 5;
}

function ok_(data) { return { ok: true, data: data }; }

function err_(code, message, details) {
  return { ok: false, error: { code: code, message: message, details: details || {} } };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
