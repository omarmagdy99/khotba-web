import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const inMemoryD1 = () => {
  const sql = new DatabaseSync(':memory:');
  sql.exec(schema);
  return { sql, async batch(statements) {
    sql.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      sql.exec('COMMIT');
      return results;
    } catch (error) {
      sql.exec('ROLLBACK');
      throw error;
    }
  }, prepare(statement) {
    const stmt = sql.prepare(statement);
    const d1 = (values = []) => ({
      bind: (...bound) => d1(bound),
      first: async () => stmt.get(...values) || null,
      all: async () => ({ results: stmt.all(...values) }),
      run: async () => ({ meta: stmt.run(...values) }),
    });
    return d1();
  } };
};

const env = { DB: inMemoryD1(), DB_TEBEEN: inMemoryD1(), KHATIB_ID_KEY: '97'.repeat(32) };
const date = '2099-01-02';
const expiry = '2099-01-03T00:00:00.000Z';
const phoneSessionK1 = '1'.repeat(64);
const phoneSessionK2 = '2'.repeat(64);
for (const db of [env.DB, env.DB_TEBEEN]) {
  db.sql.exec(`
    INSERT INTO khatibs (id, name, phone, created_at) VALUES ('K1','Test','01000000001','2000'),('K2','Other','01000000002','2000');
    INSERT INTO mosques (id,name,mujawra,created_at) VALUES ('M1','A','A','2000'),('M2','B','B','2000');
    INSERT INTO assignments (id,date,mosque_id,khatib_id,status,updated_at) VALUES
      ('A1','${date}','M1','K1','confirmed','2000'),('A2','${date}','M2','K2','excused','2000');
    INSERT INTO khatib_sessions (token,khatib_id,phone,expires_at) VALUES
      ('${phoneSessionK1}','K1','01000000001','${expiry}'),('${phoneSessionK2}','K2','01000000002','${expiry}');
  `);
}
env.DB.sql.exec(`
  INSERT INTO users (username,display_name,password_hash,salt,created_at,role,region_access) VALUES
    ('coord','Coord','hash','salt','2000','coordinator','15may'),
    ('viewer','Viewer','hash','salt','2000','viewer','15may'),
    ('admin','Admin','hash','salt','2000','admin','both');
  INSERT INTO sessions (token,username,expires_at) VALUES
    ('coordinator','coord','${expiry}'),('viewer','viewer','${expiry}'),('admin','admin','${expiry}');
`);

async function api(action, token, payload = {}, region = '15may') {
  const response = await worker.fetch(new Request('https://local.invalid/?region=' + region, {
    method: 'POST', body: JSON.stringify({ action, token, ...payload })
  }), env);
  if (['khatibLogin','issueKhatibIdentityCode','saveKhatibNationalId','weeklyNationalIds','khatibSubmitNationalId','getKhatibPrivateDetails'].includes(action)) {
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  return await response.json();
}
const id = '20000000000000';
const arabicDigits = '٢٠٠٠٠٠٠٠٠٠٠٠٠٠';
const issue = () => api('issueKhatibIdentityCode','coordinator',{khatibId:'K1'});
const submit = (token, code, nationalId = arabicDigits) => api('khatibSubmitNationalId',token,{code,nationalId});
const login = (credentials, region) => api('khatibLogin',undefined,credentials,region);
const fallback = await login({phone:'٠١٠٠٠٠٠٠٠٠١'});
assert.equal(fallback.data.khatib.id,'K1');
assert.match(fallback.data.token,/^[a-f0-9]{64}$/);
assert.equal((await api('khatibWhoami',phoneSessionK1)).ok,true,'legacy mobile sessions work without a registered ID');
assert.equal((await login({phone:'01000000001',nationalId:id})).error.code,'BAD_REQUEST');
assert.equal((await api('weeklyNationalIds','viewer',{date})).error.code,'FORBIDDEN');
assert.equal((await api('weeklyNationalIds','coordinator',{date},'tebeen')).error.code,'REGION_FORBIDDEN');
assert.equal((await api('weeklyNationalIds',phoneSessionK1,{date})).error.code,'UNAUTHENTICATED');
assert.equal((await api('issueKhatibIdentityCode','viewer',{khatibId:'K1'})).error.code,'FORBIDDEN');
const first = (await issue()).data.code;
const second = (await issue()).data.code;
assert.notEqual(first, second);
assert.equal((await submit(phoneSessionK1,first)).ok,false);
assert.equal((await submit(phoneSessionK2,second)).ok,false);
assert.equal((await submit(phoneSessionK1,second,'2000000')).ok,false);
const concurrent = await Promise.all([submit(phoneSessionK1,second),submit(phoneSessionK1,second)]);
assert.equal(concurrent.filter(result => result.ok).length,1);
const saved = env.DB.sql.prepare('SELECT national_id_ciphertext, code_hash FROM khatib_identity WHERE khatib_id = ?').get('K1');
assert.notEqual(saved.national_id_ciphertext,id);
assert.equal(saved.code_hash,null);
assert.equal((await submit(phoneSessionK1,second)).ok,false);
assert.equal((await api('khatibWhoami',phoneSessionK1)).error.code,'UNAUTHENTICATED');
assert.equal((await api('khatibRespond',fallback.data.token)).error.code,'UNAUTHENTICATED');
assert.equal((await login({phone:'01000000001'})).error.code,'NOT_FOUND');
const nationalLogin = await login({nationalId:arabicDigits});
assert.equal(nationalLogin.data.khatib.id,'K1');
const nationalSessionK1 = nationalLogin.data.token;
assert.match(nationalSessionK1,/^nid_[a-f0-9]{64}$/);
assert.equal((await api('khatibWhoami',nationalSessionK1)).data.khatib.id,'K1');
assert.equal((await api('khatibWhoami',nationalSessionK1,{},'tebeen')).error.code,'UNAUTHENTICATED');
assert.equal((await login({nationalId:id},'tebeen')).error.code,'NOT_FOUND');
assert.equal((await login({phone:'01000000001'},'tebeen')).data.khatib.id,'K1');
assert.equal((await api('saveKhatibNationalId','coordinator',{khatibId:'K2',nationalId:id})).ok,true);
assert.equal((await api('khatibWhoami',phoneSessionK2)).error.code,'UNAUTHENTICATED');
assert.equal((await login({nationalId:id})).error.code,'NOT_FOUND','ambiguous identity cannot sign in');
assert.deepEqual((await api('weeklyNationalIds','coordinator',{date})).data.nationalIds,{K1:id});
assert.deepEqual((await api('weeklyNationalIds','admin',{date},'tebeen')).data.nationalIds,{});
assert.deepEqual((await api('weeklyNationalIds','admin',{date:'2099-01-09'})).data.nationalIds,{});
assert.equal(JSON.stringify(await api('listKhatibs','viewer')).includes(id),false);
assert.equal(JSON.stringify(await api('khatibWhoami',nationalSessionK1)).includes(id),false);
const expiring = (await issue()).data.code;
env.DB.sql.exec("UPDATE khatib_identity SET code_expires_at = '2000' WHERE khatib_id = 'K1'");
assert.equal((await submit(nationalSessionK1,expiring)).ok,false);
const phoneBound = (await issue()).data.code;
env.DB.sql.exec("UPDATE khatibs SET phone = '01000000009' WHERE id = 'K1'");
assert.equal((await submit(nationalSessionK1,phoneBound)).ok,false);
const details = { name: 'New preacher', phone: '01000000003', nationalId: arabicDigits, occupation: '  مدرس  ' };
assert.equal((await api('createKhatib','viewer',details)).error.code,'FORBIDDEN');
assert.equal((await api('createKhatib','coordinator',{...details,nationalId:'123'})).error.code,'BAD_REQUEST');
assert.equal(env.DB.sql.prepare('SELECT id FROM khatibs WHERE name = ?').get(details.name), undefined);
const added = (await api('createKhatib','coordinator',details)).data.id;
async function readOccupation() {
  const { data } = await api('listKhatibs','coordinator');
  return data.khatibs.find(k => k.id === added).occupation;
}
assert.equal(await readOccupation(),'مدرس');
const stored = () => env.DB.sql.prepare('SELECT national_id_ciphertext FROM khatib_identity WHERE khatib_id = ?').get(added)?.national_id_ciphertext;
assert.ok(stored());
assert.notEqual(stored(),id);
const beforeEdit = stored();
assert.equal((await api('updateKhatib','coordinator',{...details,id:added,nationalId:''})).ok,true);
assert.equal(stored(),beforeEdit);
assert.equal((await api('updateKhatib','coordinator',{...details,id:added,nationalId:'20000000000002'})).ok,true);
assert.notEqual(stored(),beforeEdit);
const { name, phone, occupation: initialOccupation } = details;
const oldClientDetails = { name, phone, id: added };
assert.equal((await api('updateKhatib','coordinator',oldClientDetails)).ok,true);
assert.equal(await readOccupation(),initialOccupation.trim());
assert.equal((await api('updateKhatib','coordinator',{...oldClientDetails,occupation:'مهندس'})).ok,true);
assert.equal(await readOccupation(),'مهندس');
assert.deepEqual((await api('getKhatibPrivateDetails','coordinator',{khatibId:added})).data,{
  nationalId:'20000000000002', occupation:'مهندس'
});
assert.equal((await api('getKhatibPrivateDetails','coordinator')).data.nationalIds[added],'20000000000002');
assert.equal((await api('getKhatibPrivateDetails','viewer',{khatibId:added})).error.code,'FORBIDDEN');
assert.equal((await api('getKhatibPrivateDetails','coordinator',{khatibId:added},'tebeen')).error.code,'REGION_FORBIDDEN');
assert.equal((await api('getKhatibPrivateDetails','admin',{khatibId:added},'tebeen')).error.code,'NOT_FOUND');
assert.equal((await api('getKhatibPrivateDetails',nationalSessionK1)).error.code,'UNAUTHENTICATED');
assert.equal((await api('updateKhatib','coordinator',{...oldClientDetails,occupation:''})).ok,true);
assert.equal(await readOccupation(),'');
env.DB.sql.prepare("UPDATE assignments SET khatib_id = ? WHERE id = 'A1'").run(added);
assert.deepEqual((await api('weeklyNationalIds','coordinator',{date})).data.nationalIds,{[added]:'20000000000002'});
console.log('PASS: conditional login, phone session invalidation, one-time code, encryption, private exports, region and role authorization');
