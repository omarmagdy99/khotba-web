/**
 * ضبط الخطباء الثابتين ونوع الخطيب — يُشغَّل مرة واحدة بعد seedAll.
 *
 * الاستخدام: اختر الدالة applyPermanentKhatibs من القائمة واضغط Run.
 *
 * بيعمل حاجتين:
 *   1. يخلي كل الخطباء 'متطوع'، ما عدا الـ 24 اللي كانوا ثابتين في مسجد
 *      بعينه — دول يبقوا 'أساسي'.
 *   2. يحط كل واحد منهم كـ 'خطيب ثابت' للمسجد بتاعه، فـ 'توليد الجمعة'
 *      يملّي الـ 24 مسجد دول لوحده.
 *
 * الأزواج مستخرجة من الشيت القديم: المسجد اللي خطيب واحد أخد فيه 75%
 * أو أكتر من خطبه. الحد ده مش عشوائي — البيانات نفسها فيها فجوة واضحة
 * عند النقطة دي: 24 مسجد فوقها، وبعدين نزول لـ 50% وأقل.
 *
 * آمنة تتشغّل أكتر من مرة — بتكتب نفس القيم في كل مرة.
 */

function applyPermanentKhatibs() {
  var ss = SpreadsheetApp.getActive();
  var kSheet = ss.getSheetByName('khatibs');
  var mSheet = ss.getSheetByName('mosques');
  if (!kSheet || !mSheet) throw new Error('التبويبات غير موجودة — شغّل setup أولاً');

  var kLast = kSheet.getLastRow();
  var mLast = mSheet.getLastRow();
  if (kLast < 2) throw new Error('تبويب الخطباء فاضي — شغّل seedAll أولاً');
  if (mLast < 2) throw new Error('تبويب المساجد فاضي — شغّل seedAll أولاً');

  var isPrimary = {}, byMosque = {};
  PERMANENT_PAIRS.forEach(function (p) {
    byMosque[p[0]] = p[1];
    isPrimary[p[1]] = true;
  });

  // 1) النوع: الكل متطوع إلا الثابتين. العمود D في تبويب khatibs.
  var kIds = kSheet.getRange(2, 1, kLast - 1, 1).getValues();
  var types = kIds.map(function (row) {
    return [isPrimary[String(row[0]).trim()] ? 'primary' : 'volunteer'];
  });
  kSheet.getRange(2, 4, types.length, 1).setValues(types);

  // 2) الخطيب الثابت. العمود E في تبويب mosques.
  var mIds = mSheet.getRange(2, 1, mLast - 1, 1).getValues();
  var col = mIds.map(function (row) {
    return [byMosque[String(row[0]).trim()] || ''];
  });
  var range = mSheet.getRange(2, 5, col.length, 1);
  range.setNumberFormat('@');
  range.setValues(col);

  var primaryCount = types.filter(function (t) { return t[0] === 'primary'; }).length;
  var setCount = col.filter(function (c) { return c[0]; }).length;

  var msg = 'تم الضبط:' +
    '\n  أساسي: ' + primaryCount + ' خطيب' +
    '\n  متطوع: ' + (types.length - primaryCount) + ' خطيب' +
    '\n  مساجد لها خطيب ثابت: ' + setCount;

  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
  return msg;
}

// [رقم المسجد، رقم الخطيب] — الاسم والنسبة للتوضيح فقط
var PERMANENT_PAIRS = [
  ['M001', 'K072'],  // محمد أحمد فريد
  ['M003', 'K015'],  // احمد فاروق عبدالحليم
  ['M005', 'K104'],  // هاني سويد
  ['M006', 'K079'],  // محمد خليل
  ['M014', 'K043'],  // شكري محمد شوقي
  ['M016', 'K034'],  // د/ حازم
  ['M020', 'K041'],  // سيد نفادي
  ['M021', 'K033'],  // د محمود بكار
  ['M023', 'K005'],  // أشرف جمعة
  ['M030', 'K073'],  // محمد احمد صادق
  ['M033', 'K093'],  // محمود علي ابو جبل
  ['M035', 'K018'],  // اشرف عيسي
  ['M037', 'K076'],  // محمد الروبي
  ['M038', 'K055'],  // عبدالرؤوف الدسوقي
  ['M041', 'K027'],  // حسن محمد حسن
  ['M049', 'K010'],  // احمد حسن محمد حسب ربه
  ['M053', 'K087'],  // محمود ابو غرام
  ['M056', 'K089'],  // محمود السواح
  ['M060', 'K045'],  // صلاح عبد الحي الصادق
  ['M061', 'K085'],  // محمد علي ابراهيم
  ['M075', 'K097'],  // مصطفي حامد اسماعيل
  ['M076', 'K017'],  // اخمد النوبي
  ['M079', 'K049'],  // عادل عبد الرازق
  ['M080', 'K053'],  // عبد العزيز محمد سعيد
];
