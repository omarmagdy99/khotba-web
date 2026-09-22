// أوقاف 15 مايو — مساعدات قاعدة بيانات Cloudflare D1

/**
 * إرجاع صف واحد أو null
 */
export async function one(db, sql, ...params) {
  const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
  return await stmt.first();
}

/**
 * إرجاع مصفوفة من كافة الصفوف المطابقة
 */
export async function all(db, sql, ...params) {
  const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
  const res = await stmt.all();
  return res.results || [];
}

/**
 * تنفيذ جملة تعديل/إضافة/حذف
 */
export async function run(db, sql, ...params) {
  const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
  return await stmt.run();
}

/**
 * تنفيذ مجموعة من الجمل داخل معاملة ذرية (Transaction / Batch)
 */
export async function batch(db, statements) {
  if (!statements || !statements.length) return [];
  return await db.batch(statements);
}
