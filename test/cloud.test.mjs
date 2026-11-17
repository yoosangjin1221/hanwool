// 실행: node test/cloud.test.mjs   (의존성 없음)
// 팀 저장소(js/cloud.js)를 가짜 Supabase 하나에 브라우저 여러 개를 붙여 돌려 봅니다. 사례는 가상 예시 30건입니다.
// 가짜 서버는 실제와 같은 점만 흉내 냅니다: 고친 시각은 서버가 적음 · jsonb 는 키 순서를 바꿔 돌려줌 · 같은 번호는 고쳐짐 · 한 번에 500줄까지.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../js/logic.js');
const Sample = require('../js/sample-data.js');
const Cloud = require('../js/cloud.js');

let passed = 0; const tests = [];
function test(name, fn) { tests.push([name, fn]); }

/* ── 가짜 Supabase ── */
function sortKeys(v) { if (Array.isArray(v)) return v.map(sortKeys); if (v && typeof v === 'object') { const o = {}; Object.keys(v).sort().reverse().forEach(k => { o[k] = sortKeys(v[k]); }); return o; } return v; }
function server() {
  const S = { tables: { tst_data_cases: new Map(), tst_data_shared: new Map(), tst_data_photos: new Map() }, tick: Date.parse('2026-11-17T00:00:00Z'), n: 0, missing: false, fail: null, calls: [] };
  const pk = { tst_data_cases: 'id', tst_data_shared: 'key', tst_data_photos: 'id' };
  const stamp = () => new Date(S.tick += 1000).toISOString().replace('Z', '+00:00');
  S.client = () => ({ from(t) {
    const q = { t, op: 'select', filters: [], rows: null, opts: {}, single: false, range: null };
    const b = {
      select() { return b; },
      upsert(rows, opts) { q.op = 'upsert'; q.rows = Array.isArray(rows) ? rows : [rows]; q.opts = opts || {}; return b; },
      update(obj) { q.op = 'update'; q.rows = obj; return b; },
      delete() { q.op = 'delete'; return b; },
      gt(c, v) { q.filters.push(r => String(r[c]) > String(v)); return b; },
      eq(c, v) { q.filters.push(r => r[c] === v); return b; },
      in(c, vs) { q.filters.push(r => vs.indexOf(r[c]) >= 0); return b; },
      order() { return b; },
      range(a, z) { q.range = [a, z]; return b; },
      maybeSingle() { q.single = true; return b; },
      then(res, rej) { return Promise.resolve().then(() => exec(q)).then(res, rej); }
    };
    return b;
  } });
  function exec(q) {
    S.calls.push(q.op + ' ' + q.t);
    if (S.fail) return { data: null, error: { message: S.fail } };
    if (S.missing) return { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public." + q.t + "' in the schema cache" } };
    const tb = S.tables[q.t], key = pk[q.t];
    const match = r => q.filters.every(f => f(r));
    if (q.op === 'upsert') {
      q.rows.forEach(r => {
        const old = tb.get(r[key]);
        if (old && q.opts.ignoreDuplicates) return;
        const row = Object.assign({}, old || { n: ++S.n }, JSON.parse(JSON.stringify(r)));
        if (row.body != null) row.body = sortKeys(row.body);
        if (q.t !== 'tst_data_photos') row.updated_at = stamp();
        tb.set(r[key], row);
      });
      return { data: null, error: null };
    }
    if (q.op === 'update') { [...tb.values()].filter(match).forEach(r => { Object.assign(r, q.rows); r.updated_at = stamp(); }); return { data: null, error: null }; }
    if (q.op === 'delete') { [...tb.values()].filter(match).forEach(r => tb.delete(r[key])); return { data: null, error: null }; }
    let out = [...tb.values()].filter(match).sort((a, b) => a.n - b.n).map(r => JSON.parse(JSON.stringify(r)));
    if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
    return { data: q.single ? (out[0] || null) : out, error: null };
  }
  S.live = () => [...S.tables.tst_data_cases.values()].filter(r => !r.deleted);
  return S;
}
/* ── 가짜 브라우저 ── */
function browser(S, db) {
  const B = { db: db || L.emptyDb(), kv: {}, photos: new Map(), touches: [], timers: [], clock: 1e12, ids: 0, notes: 0 };
  B.core = Cloud.create({
    sb: S.client(), prefix: 'tst', ref: 'https://x.supabase.co', L,
    P: { get: id => Promise.resolve(B.photos.get(id) || null), put: r => { B.photos.set(r.id, r); return Promise.resolve(); },
      blobToB64: b => Promise.resolve(b ? 'B64:' + b : ''), b64ToBlob: s => String(s).replace(/^B64:/, '') },
    app: { db: () => B.db, touch: r => { B.touches.push(r); } },
    kv: { get: k => B.kv[k] || null, set: (k, v) => { B.kv[k] = v; } },
    later: (fn) => { B.timers.push(fn); return () => { B.timers = B.timers.filter(x => x !== fn); }; },
    now: () => (B.clock += 1000), mkId: () => 'n' + (++B.ids) + '-' + Math.random().toString(36).slice(2, 6), notify: () => { B.notes++; }
  });
  B.save = () => { B.core.changed(); };                        // 화면의 save()
  B.flush = async () => { const t = B.timers; B.timers = []; for (const f of t) await f(); await B.core.sync(); };
  B.state = () => B.core.info().state;
  return B;
}
function realDb(n) {   // 가상 예시를 「내 자료」처럼
  const d = Sample.db(); d._sample = false; if (n) d.cases = d.cases.slice(0, n); return L.restoreDb(JSON.parse(JSON.stringify(d)));
}
function withPhotos(B, k) {
  for (let i = 0; i < k; i++) { const id = 'ph' + i; B.db.cases[i].photos = [{ id, name: i + '.jpg', w: 100, h: 80, bytes: 1000, memo: '' }]; B.photos.set(id, { id, caseId: B.db.cases[i].id, name: i + '.jpg', w: 100, h: 80, bytes: 1000, blob: 'IMG' + i, thumb: 'TH' + i }); }
}
const ids = db => db.cases.map(c => c.id).sort().join(',');

console.log('1. 처음 맞추기');
test('이 브라우저에만 있는 자료는 묻고 나서 올린다 · 사진이 사례보다 먼저', async () => {
  const S = server(), A = browser(S, realDb()); withPhotos(A, 3);
  await A.core.start();
  assert.equal(A.state(), 'ask'); assert.equal(A.core.info().ask.n, 30); assert.equal(A.core.info().ask.photos, 3);
  assert.equal(S.live().length, 0, '묻기 전에는 올리지 않는다');
  await A.core.answer('upload');
  assert.equal(A.state(), 'ok'); assert.equal(S.live().length, 30); assert.equal(S.tables.tst_data_photos.size, 3);
  assert.ok(S.calls.indexOf('upsert tst_data_photos') < S.calls.indexOf('upsert tst_data_cases'), '사진 먼저');
  assert.equal(S.tables.tst_data_shared.get('equipments').body.length, A.db.equipments.length);
  assert.equal(A.db.cases.length, 30);
});
test('빈 브라우저는 묻지 않고 받아 온다 · 사진은 볼 때 받는다', async () => {
  const S = server(), A = browser(S, realDb()); withPhotos(A, 2); await A.core.start(); await A.core.answer('upload');
  const B = browser(S); await B.core.start();
  assert.equal(B.state(), 'ok'); assert.equal(ids(B.db), ids(A.db)); assert.equal(B.db.equipments.length, A.db.equipments.length);
  assert.deepEqual(L.stableJson(B.db.cases[0]), L.stableJson(L.cleanCase(A.db.cases[0])), '키 순서가 달라져 와도 같은 사례');
  assert.equal(B.photos.size, 0);
  const rec = await B.core.fetchPhoto('ph1');
  assert.equal(rec.blob, 'IMG1'); assert.equal(rec.thumb, 'TH1'); assert.equal(B.photos.size, 1);
  assert.equal(await B.core.fetchPhoto('nope'), null);
});
test('맞춘 뒤 다시 맞추면 아무것도 올리지 않고 화면도 건드리지 않는다', async () => {
  const S = server(), A = browser(S, realDb()); await A.core.start(); await A.core.answer('upload');
  const B = browser(S); await B.core.start();
  const calls = S.calls.length, tA = A.touches.length, tB = B.touches.length;
  await A.core.sync(); await B.core.sync(); await A.core.sync();
  assert.deepEqual(S.calls.slice(calls).filter(c => !/^select/.test(c)), []);
  assert.equal(A.touches.length, tA); assert.equal(B.touches.length, tB);
});
test('올리지 않고 팀 자료만 쓰기 — 이 브라우저의 자료를 버린다', async () => {
  const S = server(), A = browser(S, realDb(10)); await A.core.start(); await A.core.answer('upload');
  const C = browser(S, realDb(30)); C.db.cases.forEach((c, i) => { c.id = 'mine' + i; });
  await C.core.start(); assert.equal(C.state(), 'ask'); assert.equal(C.core.info().ask.cloud, 10);
  await C.core.answer('discard');
  assert.equal(ids(C.db), ids(A.db)); assert.equal(S.live().length, 10);
});
test('번호가 겹치는 다른 사례는 새 번호로 올린다(덮어쓰지 않는다)', async () => {
  const S = server(), A = browser(S, realDb(5)); await A.core.start(); await A.core.answer('upload');
  const C = browser(S, realDb(5)); C.db.cases.forEach(c => { c.symptom = '다른 브라우저의 다른 사례 ' + c.id; });
  const same = C.db.cases[4]; Object.assign(same, JSON.parse(JSON.stringify(A.db.cases[4])));   // 한 건은 완전히 같은 사례
  await C.core.start(); assert.equal(C.core.info().ask.n, 4, '같은 사례는 세지 않는다');
  await C.core.answer('upload');
  assert.equal(S.live().length, 9); assert.equal(C.db.cases.length, 9);
  await A.core.sync(); assert.equal(A.db.cases.length, 9);
  A.db.cases.slice(0, 5).forEach(c => assert.ok(!/다른 브라우저/.test(c.symptom), 'A 의 원래 사례가 그대로'));
});

console.log('2. 고치기 · 지우기 · 더하기');
test('한쪽에서 고치면 다른 쪽에 온다', async () => {
  const S = server(), A = browser(S, realDb()); await A.core.start(); await A.core.answer('upload');
  const B = browser(S); await B.core.start();
  A.db.cases[3] = Object.assign({}, A.db.cases[3], { cause: '고친 원인' }); A.save(); await A.flush();
  await B.core.sync();
  assert.equal(B.db.cases.find(c => c.id === A.db.cases[3].id).cause, '고친 원인');
  const r = B.touches[B.touches.length - 1]; assert.equal(r.updated, 1); assert.equal(r.added, 0);
});
test('지우면 다른 쪽에서도 사라진다 · 더하면 생긴다', async () => {
  const S = server(), A = browser(S, realDb()); await A.core.start(); await A.core.answer('upload');
  const B = browser(S); await B.core.start();
  const gone = B.db.cases[7].id; B.db.cases = B.db.cases.filter(c => c.id !== gone);
  B.db.cases.push(L.cleanCase({ id: 'n-new', date: '2026-11-17', equipment: '설비 A', symptom: '새 증상', cause: '새 원인', steps: ['확인'] }));
  B.save(); await B.flush(); await A.core.sync();
  assert.ok(!A.db.cases.some(c => c.id === gone)); assert.ok(A.db.cases.some(c => c.id === 'n-new')); assert.equal(A.db.cases.length, 30);
  assert.equal(S.tables.tst_data_cases.get(gone).deleted, true, '줄은 남기고 지운 표시');
});
test('두 사람이 서로 다른 사례를 고치면 둘 다 남는다', async () => {
  const S = server(), A = browser(S, realDb()); await A.core.start(); await A.core.answer('upload');
  const B = browser(S); await B.core.start();
  A.db.cases[0] = Object.assign({}, A.db.cases[0], { memo: 'A 가 고침' }); A.save();
  B.db.cases[1] = Object.assign({}, B.db.cases[1], { memo: 'B 가 고침' }); B.save();
  await A.flush(); await B.flush(); await A.core.sync();
  for (const X of [A, B]) { assert.equal(X.db.cases.find(c => c.id === A.db.cases[0].id).memo, 'A 가 고침'); assert.equal(X.db.cases.find(c => c.id === B.db.cases[1].id).memo, 'B 가 고침'); }
});
test('같은 사례를 둘이 고치면 나중에 올린 쪽이 남고, 양쪽이 같아진다', async () => {
  const S = server(), A = browser(S, realDb()); await A.core.start(); await A.core.answer('upload');
  const B = browser(S); await B.core.start(); const id = A.db.cases[2].id;
  A.db.cases[2] = Object.assign({}, A.db.cases[2], { memo: '먼저' }); A.save(); await A.flush();
  B.db.cases = B.db.cases.map(c => c.id === id ? Object.assign({}, c, { memo: '나중' }) : c); B.save(); await B.flush();
  await A.core.sync();
  assert.equal(A.db.cases.find(c => c.id === id).memo, '나중'); assert.equal(B.db.cases.find(c => c.id === id).memo, '나중');
});
test('설비 목록 · 가이드 수정도 함께 쓴다', async () => {
  const S = server(), A = browser(S, realDb()); await A.core.start(); await A.core.answer('upload');
  const B = browser(S); await B.core.start();
  A.db.equipments = A.db.equipments.concat([L.cleanEquipment({ name: '새 설비 Z', type: '압출기' })]); A.db.guides = { '히터 단선': { memo: '고친 가이드' } };
  A.save(); await A.flush(); await B.core.sync();
  assert.ok(B.db.equipments.some(e => e.name === '새 설비 Z')); assert.equal(B.db.guides['히터 단선'].memo, '고친 가이드');
});
test('사진을 빼면 팀 저장소에서도 지우고, 새 사진은 올린다', async () => {
  const S = server(), A = browser(S, realDb()); withPhotos(A, 2); await A.core.start(); await A.core.answer('upload');
  A.photos.set('phX', { id: 'phX', caseId: A.db.cases[0].id, name: 'x.jpg', w: 1, h: 1, bytes: 1, blob: 'IMGX', thumb: 'THX' });
  A.db.cases[0] = Object.assign({}, A.db.cases[0], { photos: [{ id: 'phX', name: 'x.jpg' }] }); A.save(); await A.flush();
  assert.deepEqual([...S.tables.tst_data_photos.keys()].sort(), ['ph1', 'phX']);
});
test('그림이 아직 브라우저에 없는 사진은 건너뛰고 1분 뒤 다시 올린다', async () => {
  const S = server(), A = browser(S, realDb(3)); await A.core.start(); await A.core.answer('upload');
  A.db.cases[0] = Object.assign({}, A.db.cases[0], { photos: [{ id: 'late', name: 'l.jpg' }] }); A.save(); await A.flush();
  assert.equal(S.tables.tst_data_photos.size, 0); assert.equal(A.state(), 'ok');
  A.photos.set('late', { id: 'late', blob: 'IMGL', thumb: 'THL' });
  await A.core.sync(); assert.equal(S.tables.tst_data_photos.size, 0, '1분 안에는 다시 보지 않는다');
  A.clock += 70000; await A.core.sync(); assert.equal(S.tables.tst_data_photos.size, 1);
});

console.log('3. 통째로 바뀔 때');
test('모두 지우기는 팀 저장소에 바로 퍼지지 않는다 — 다시 받기', async () => {
  const S = server(), A = browser(S, realDb()); await A.core.start(); await A.core.answer('upload');
  A.db = L.emptyDb(); A.save(); await A.flush();
  assert.equal(A.state(), 'held'); assert.equal(A.core.info().held.n, 30); assert.equal(S.live().length, 30);
  await A.core.sync(); assert.equal(S.live().length, 30, '답하기 전에는 몇 번을 맞춰도 그대로');
  await A.core.resolveHeld('restore');
  assert.equal(A.state(), 'ok'); assert.equal(A.db.cases.length, 30); assert.equal(S.live().length, 30);
});
test('모두 지우기 — 팀 저장소에서도 지우기를 고르면 다른 브라우저에서도 사라진다', async () => {
  const S = server(), A = browser(S, realDb()); await A.core.start(); await A.core.answer('upload');
  const B = browser(S); await B.core.start();
  A.db = L.emptyDb(); A.save(); await A.flush(); await A.core.resolveHeld('delete');
  assert.equal(S.live().length, 0); await B.core.sync(); assert.equal(B.db.cases.length, 0);
});
test('몇 건만 지우는 것은 묻지 않는다', async () => {
  const S = server(), A = browser(S, realDb()); await A.core.start(); await A.core.answer('upload');
  A.db.cases = A.db.cases.slice(4); A.save(); await A.flush();
  assert.equal(A.state(), 'ok'); assert.equal(S.live().length, 26);
});
test('예시 데이터를 쓰는 동안에는 맞추지 않고, 지우면 팀 자료가 돌아온다', async () => {
  const S = server(), A = browser(S, realDb()); await A.core.start(); await A.core.answer('upload');
  A.db = Sample.db(); A.save(); await A.flush();
  assert.equal(A.state(), 'sample'); assert.equal(S.live().length, 30);
  A.db = L.emptyDb(); A.save(); await A.flush();
  assert.equal(A.state(), 'ok'); assert.equal(A.db.cases.length, 30); assert.equal(S.live().length, 30);
});
test('예시를 쓰다 내 엑셀을 가져오면 묻지 않고 팀 저장소에 더한다', async () => {
  const S = server(), A = browser(S, realDb(6)); await A.core.start(); await A.core.answer('upload');
  const B = browser(S, Sample.db()); await B.core.start(); assert.equal(B.state(), 'sample');
  B.db = L.emptyDb(); B.db.cases = [L.cleanCase({ id: 'imp1', equipment: '설비 B', symptom: '가져온 사례', cause: '원인' })]; B.save(); await B.flush();
  assert.equal(B.state(), 'ok'); assert.equal(S.live().length, 7); assert.equal(B.db.cases.length, 7);
});

console.log('4. 연결');
test('표가 없으면(data.sql 실행 전) 이 브라우저에만 저장하고 조용히 있는다', async () => {
  const S = server(); S.missing = true; const A = browser(S, realDb()); await A.core.start();
  assert.equal(A.state(), 'missing'); assert.equal(A.core.active(), false);
  A.save(); assert.equal(A.timers.length, 0); assert.equal(A.db.cases.length, 30);
  assert.match(Cloud.noteText(A.core.info()), /이 브라우저에만/);
  S.missing = false; await A.core.sync(); assert.equal(A.state(), 'ask', 'SQL 을 실행한 뒤에는 이어서 맞춘다');
});
test('연결이 끊기면 자료를 잃지 않고, 다시 이어지면 올린다', async () => {
  const S = server(), A = browser(S, realDb()); await A.core.start(); await A.core.answer('upload');
  S.fail = 'Failed to fetch';
  A.db.cases[0] = Object.assign({}, A.db.cases[0], { memo: '끊긴 동안 고침' }); A.save(); await A.flush();
  assert.equal(A.state(), 'error'); assert.match(Cloud.noteText(A.core.info()), /연결 안 됨/);
  S.fail = null; await A.core.sync();
  assert.equal(A.state(), 'ok'); assert.equal(S.tables.tst_data_cases.get(A.db.cases[0].id).body.memo, '끊긴 동안 고침');
});
test('다른 프로젝트 주소의 기억표는 쓰지 않는다 · 다시 열어도 묻지 않는다', async () => {
  const S = server(), A = browser(S, realDb()); await A.core.start(); await A.core.answer('upload');
  const again = browser(S, A.db); again.kv = Object.assign({}, A.kv);
  const core2 = Cloud.create(Object.assign({}, { sb: S.client(), prefix: 'tst', ref: 'https://x.supabase.co', L, P: { get: () => Promise.resolve(null) }, app: { db: () => A.db, touch() {} },
    kv: { get: k => A.kv[k] || null, set() {} }, later: () => () => {}, now: () => 1, mkId: () => 'z' }));
  await core2.start(); assert.equal(core2.info().state, 'ok');
  assert.equal(L.cloudRestoreSnap(JSON.parse(A.kv[Cloud.KEY]), 'https://other.supabase.co').adopted, false);
});
test('500건이 넘어도 모두 받는다', async () => {
  const S = server(), A = browser(S, L.emptyDb());
  for (let i = 0; i < 1203; i++) A.db.cases.push(L.cleanCase({ id: 'k' + i, equipment: '설비', symptom: '증상 ' + i, cause: '원인' }));
  await A.core.start(); await A.core.answer('upload');
  const B = browser(S); await B.core.start(); assert.equal(B.db.cases.length, 1203);
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); process.exitCode = 1; }
}
console.log('\n' + passed + '/' + tests.length + '개 통과');
