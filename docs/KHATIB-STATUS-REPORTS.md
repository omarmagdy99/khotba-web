# تقرير تحسينات واجهة تقارير وحالات الخطباء (Khatib Status Reports)

## 1. ملخص تنفيذي (Executive Summary)
تم تنفيذ الجانب الخاص بواجهة المستخدم (UI/Filter/Export) لعرض وتصفية وتصدير حالات وجاهزية الخطباء ضمن تحسينات المنسق المعتمدة، وفق نطاق ملفات محدد بدقة وبشكل مستقل تماماً عن شاشات المراجعة أو الـ Backend الجاري تعديله بالتوازي.

كما تم تطبيق المراجعات الدقيقة المعتمدة لضبط أسبقية استنتاج الحالة الأسبوعية على الجداول الشهرية، وإزالة الكتم الصامت لأخطاء المساعد الهيكلي لتمكين واجهة معالجة الأخطاء من التقاطها، وضبط مسميات فلاتر التكليف، وتنظيف فروع الكود غير القابلة للوصول.

---

## 2. الملفات المعدلة والمنشأة (Exact Files)

### أ. ملفات المنتَج المعدلة والمستحدثة:
1. **[free-khatibs.html](file:///C:/Users/pc/.codex/worktrees/khatib-status-reports/خطباء%20ويب/free-khatibs.html)**:
   - استبدال عنوان العمود المضلل «ملاحظة» بـ «الحالة».
   - عرض حالات القراءة فقط: `مستعد` (🟢)، `معتذر` (🚫)، و`لم يرد` (⚪)؛ مع منع مساواة عدم الرد بحالة «غير متواجد».
   - استبعاد الخطباء المكلفين قيد التأكيد (Pending Assignments) من قائمة الخطباء غير المكلفين لضمان عدم اعتبارهم متاحين كبدلاء.
   - الحفاظ على تفاصيل اعتذار المسجد (`معتذر عن مسجد كذا`) في الشاشة والتصدير.
   - إضافة فلتر الحالة (`statusFilter`) مدمجاً مع البحث بالاسم، مع عرض العداد الصحيح (`المعروض من الإجمالي`).
   - تصدير الصفوف المرئية المفلترة إلى Word و PDF متضمنة عمود الحالة التفصيلي.
   - إضافة زر انتقال مباشر لتقرير حالات الخطباء (`khatib-status-report.html`) مع الحفاظ على معامل التاريخ (`?date=`).
   - ينتهي بفاصل سطر جديد (Trailing newline).

2. **[khatib-status-report.html](file:///C:/Users/pc/.codex/worktrees/khatib-status-reports/خطباء%20ويب/khatib-status-report.html)** (ملف جديد):
   - صفحة تقرير شاملة مستقلة ومصممة بالعربية RTL.
   - تجلب بيانات `listKhatibs` و `getSchedule` للتاريخ المختار.
   - تعرض كافة الخطباء النشطين مع بيان حالتهم وسياق تكليفهم بالمساجد.
   - الخطيب المستعد المكلف/المؤكد بمسجد يُوسم باسم مسجده وحالته (`مؤكد` / `لم يتم التأكيد`) ولا يُعلن عنه كبديل حر؛ بينما يُوسم الخطيب المستعد غير المكلف بـ `متاح كبديل (غير مكلف)`.
   - تعديل نص خيار فلتر التكليف إلى «غير مكلف» بدلاً من «غير مكلف (متاح كبديل)»، نظراً لأن غير المكلف قد يكون معتذراً أو لم يرد، والسياق الفردي للصف يحدد البديل الفعلي بدقة.
   - توفر تصفية بالاسم، الحالة، ونوع التكليف، وتصدير Word و PDF مستقل.
   - ربط كامل وسلس مع `schedule.html` و `free-khatibs.html` مع تمرير التاريخ.
   - ينتهي بفاصل سطر جديد (Trailing newline).

3. **[assets/khatib-status.js](file:///C:/Users/pc/.codex/worktrees/khatib-status-reports/خطباء%20ويب/assets/khatib-status.js)** (أصل مشترك مركّز جديد):
   - مكتبة مشتركة وخفيفة بصيغة UMD تعمل في المتصفح وبيئة Node.js.
   - توحد منطق استنتاج الحالة للقراءة فقط (`resolveKhatibState`) مع ترتيب الأسبقية الدقيق:
     1. الأدلة الأسبوعية الصريحة أولاً: اعتذار تكليف أسبوعي أو اعتذار عام في الجاهزية (`rawReadiness === 'excused'`) => `معتذر`.
     2. الرد الأسبوعي الصريح بالاستعداد (`rawReadiness === 'ready'`) => `مستعد`.
     3. فقط في حال عدم وجود رد أسبوعي صريح، يُفحص المساعد الهيكلي الشهري => `غير متواجد`.
     4. في حال عدم وجود رد أو قاعدة شهرية => `لم يرد`.
   - إزالة الكتم الصامت (`try/catch`) داخل `getStructuredAvailability` لضمان تصعيد أخطاء التقويم والمساعد لمستوى `loadData()` لعرض رسالة خطأ صريحة للمستخدم بدلاً من تزييف حالة صالحة.
   - إزالة الحقول التخمينية غير الموثقة في واجهة API (`khatib.availability` و `khatib.structuredAvailability`).
   - إزالة الفرع غير القابل للوصول `activeAssignment && isExcusedStatus(activeAssignment.status)` واستخدام المطابقة الدقيقة للحالة المعروفة `'excused'` دون مطابقة البادئة التخمينية.
   - ينتهي بفاصل سطر جديد (Trailing newline).

4. **[scripts/build-frontend.js](file:///C:/Users/pc/.codex/worktrees/khatib-status-reports/خطباء%20ويب/scripts/build-frontend.js)**:
   - إضافة `khatib-status-report.html` لمصفوفة `htmlFiles` لتوليد نسختي `dist/` و `dist/tebeen/` تلقائياً مع معالجة المسارات والمصطلحات الإقليمية.
   - ينتهي بفاصل سطر جديد (Trailing newline).

### ب. ملفات الاختبار والتوثيق:
5. **[worker/test/frontend-khatib-status.cjs](file:///C:/Users/pc/.codex/worktrees/khatib-status-reports/خطباء%20ويب/worker/test/frontend-khatib-status.cjs)** (ملف اختبارات مركز جديد):
   - يغطي بدقة جميع الحالات المطلوبة:
     * التحقق من قراءة الحالة فقط وعدم مساواة عدم الرد بغير متواجد.
     * أسبقية الردود الأسبوعية الصريحة (الاعتذار والاستعداد) على قواعد المساعد الشهري.
     * التحقق من تصعيد أخطاء المساعد الهيكلي (Error Propagation Assertion) وعدم كتمها.
     * استبعاد المكلفين غير المؤكدين من الخطباء المتاحين.
     * صحة تسميات الفلاتر ومطابقة عناصر التصدير.
     * مسارات البناء الإقليمية ومحاكاة DOM عبر `vm`.
   - ينتهي بفاصل سطر جديد (Trailing newline).

6. **[docs/KHATIB-STATUS-REPORTS.md](file:///C:/Users/pc/.codex/worktrees/khatib-status-reports/خطباء%20ويب/docs/KHATIB-STATUS-REPORTS.md)** (هذا التقرير).

---

## 3. قرارات التصميم ونطاق التقرير (UI & Scope Decisions)

1. **طبيعة العرض (Strict Read-Only)**:
   - التزام تام بعدم وضع أي عناصر تحكم لتعديل الجاهزية في هذه الصفحات (لا توجد dropdowns لتغيير الجاهزية ولا أزرار اعتماد، ولا استدعاء لأي admin set-readiness endpoint).
2. **أسبقية الأدلة الصريحة الأسبوعية (Precedence Rule)**:
   - الرد الأسبوعي الصريح أكثر تحديداً وحداثة من الجدولة الشهرية المستمرة.
   - إذا كان لدى الخطيب اعتذار أسبوعي مقبول أو اعتذار عام، فحكمه «معتذر» حتى لو كانت الجدولة الشهرية تعتبره متاحاً أو غير متاح.
   - إذا أبدى الخطيب استعداده الصريح للأسبوع الحالي، فحكمه «مستعد» حتى لو تعارض ذلك مع قاعدة شهرية سابقة.
   - يقتصر تفعيل حالة «غير متواجد» على الخطيب الذي لم يقدم رداً أسبوعياً صريحاً وتطابقت عليه قاعدة عدم التواجد الشهرية.
3. **تصعيد الأخطاء البرمجية (Hook Error Propagation)**:
   - تم التخلي عن صيد الأخطاء الصامت؛ فإذا واجه المساعد الهيكلي المستقبلي عطلاً في معالجة التقويم أو الشبكة، يجب أن يفشل الاستدعاء ويصل إلى معالج الخطأ العام للشاشة (`showError`) لإعلام المنسق، بدلاً من إرجاع بيانات مضللة توحي بأن الخطيب لم يرد.
4. **الخطباء قيد التكليف (Pending Assignments)**:
   - في `free-khatibs.html`، الخطيب المسند لمسجد ولكن حالته `unassigned` (لم يتم التأكيد) يعتبر قيد التكليف ولا يجوز عرضه كخطيب متاح للخطابة.
5. **سياق التكليف ودقة التسميات**:
   - في `khatib-status-report.html`، الخطيب المستعد المرتبط بمسجد مؤكد يُكتب بجانبه `مسجد [اسم المسجد] (مؤكد)` ولا يظهر له وسم «بديل متاح»، تجنباً لإرباك المنسق.
   - يقتصر وسم `متاح كبديل (غير مكلف)` على الخطيب المستعد الذي ليس لديه أي تكليف نشط.
   - خيار الفلتر في القائمة المنسدلة سُمي بدقة `غير مكلف` بدون إضافة `(متاح كبديل)` لشموله حالات الاعتذار وعدم الرد.
6. **الفصل التام عن تصدير الجدول الرئيسي**:
   - لم يتم المساس بملف `schedule.html` أو دوال تصديره، وظل جدول التوزيع مخصصاً لعرض المسجد والمنطقة واسم الخطيب فقط. التقرير التفصيلي للجاهزية معزول في شاشته المستقلة.

---

## 4. نقاط الربط والتكامل للمرحلة المستقبلية (Integration Points)

1. **المساعد الهيكلي للجاهزية الشهرية/المتكررة (Structured Availability Helper)**:
   - تم تجهيز واجهة ربط برمجية واضحة ومباشرة في `assets/khatib-status.js`:
     ```javascript
     KhatibStatus.setAvailabilityHelper(function (khatib, date) {
       // فحص توفر الخطيب الشهري / المتكرر
       // يُرجع 'unavailable' إذا كان الخطيب غير متواجد هيكلياً، أو null ليبقى على حالته الطبيعية
       // في حال حدوث خطأ غير متوقع، يرمي الخطأ ليعالج عبر showError
     });
     ```
   - عند دمج الجاهزية الشهرية في المرحلة القادمة، يتم تسجيل الدالة المساعدة عبر `setAvailabilityHelper`، وستتحول حالة من يحدده المساعد تلقائياً إلى `غير متواجد` (`unavailable`) في حال عدم وجود رد أسبوعي صريح، وبدون أي تعديل على شاشات العرض.

2. **ربط التقرير بجوار تصدير الجدول الرئيسي في شاشة التوزيع**:
   - الشاشة الجديدة `khatib-status-report.html` تستقبل المعامل `?date=YYYY-MM-DD`، وجاهزة للربط بزر إضافي في شريط أدوات `schedule.html` في المرحلة القادمة بجانب أزرار PDF/Word الحالية.

---

## 5. بوابات التحقق ونتائج الاختبارات (Verification Gates Run)

تم تشغيل البوابات المحددة في التعليمات محلياً بدون المساس بقاعدة البيانات أو الخوادم:

```bash
# 1. بناء الواجهة الأمامية وتوليد نسختي 15 مايو والتبين
node scripts/build-frontend.js
# Output: Copied all assets and HTMLs -> Frontend build completed successfully in dist/

# 2. تشغيل اختبارات حالات الخطباء الجديدة مع اختبارات الأسبقية وتصعيد الأخطاء
node worker/test/frontend-khatib-status.cjs
# Output:
# PASS 1: read-only status and unknown != unavailable verification
# PASS 2: accepted excuse vs readiness and mosque detail preservation
# PASS 3: assignment context and pending assigned khatibs exclusion
# PASS 4: combined filtering and export subset integrity
# PASS 5: regional build paths, asset rewrites, and terminology
# PASS 6: end-to-end VM DOM simulation for both pages
# ALL KHATIB STATUS TESTS PASSED SUCCESSFULLY!

# 3. تشغيل اختبارات المناطق الإقليمية للواجهة
node worker/test/frontend-regions.cjs
# Output: PASS: regional navigation, independent caches, public date URL, and all generated pages

# 4. تشغيل اختبارات بوابة الخطباء
node worker/test/frontend-portal.cjs
# Output: PASS: independent portal sessions, regional API routing, logout and expiry preserve other sessions

# 5. تشغيل اختبارات شاشة التوزيع والفلاتر
node worker/test/frontend-schedule.cjs
# Output: PASS: status/search filters, red excuse rows, pending assignment defaults and live filter updates
# Output: PASS: dropdown filter combinations, search cache preservation, current selection and dirty-state safety

# 6. تشغيل اختبارات حساب تاريخ الجمعة في القاهرة
node worker/test/portal-date.mjs
# Output: PASS: current sermon follows Cairo dates including Friday rollover and year boundary

# 7. التحقق من نظافة التغييرات وخلوها من أخطاء المسافات
git diff --check
# Output: Clean (0 errors)
```

---

## 6. الحدود المتبقية (Remaining Limitations)
- ربط التقرير متاح حالياً عبر شاشة `free-khatibs.html` والرابط المباشر؛ إضافة رابط صريح داخل `schedule.html` ترك للمرحلة اللاحقة لأداة التنسيق (Orchestrator).
- الجاهزية المتكررة/الشهرية لم يتم تفعيلها بقاعدة البيانات بعد، وستتصل بنقطة الربط `setAvailabilityHelper` عند جاهزيتها.
- لم يتم إجراء أي `git commit` أو `push` أو تشغيل لاختبارات خلفية مشتركة التزاماً ببروتوكول السلامة.
