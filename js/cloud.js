/* 팀 저장소 — 정비 사례 · 설비 목록 · 가이드 수정 · 사진을 Supabase 에 두고, 승인된 구성원이 어느 브라우저에서나 같은 자료를 봅니다.
 *
 * 필요한 것: supabase/auth.sql 다음에 supabase/data.sql 실행(표 data1006_data_cases · _shared · _photos).
 *           실행 전이면 지금처럼 이 브라우저에만 저장하고, 관리자에게 실행 안내를 보여 줍니다.
 * 끄기: js/auth-config.js 에 "cloud": false
 *
 * 어떻게 맞추나
 *   · 화면은 지금처럼 브라우저 사본(localStorage · IndexedDB)으로 움직입니다. 저장할 때마다 바뀐 사례만 올리고(1초쯤 뒤),
 *     25초마다 · 창으로 돌아올 때 다른 사람이 고친 것을 받아 넣습니다. 같은 사례를 두 사람이 고치면 나중에 올린 쪽이 남습니다.
 *   · 처음 맞출 때 이 브라우저에만 있는 사례가 있으면 올릴지 묻습니다. 번호가 겹치면 새 번호를 줘서 덮어쓰지 않습니다.
 *   · 한 번에 절반 넘게(5건 이상) 지워지면 팀 저장소에서도 지울지 묻습니다(모두 지우기 · 백업 되살리기를 실수로 팀 전체에 퍼뜨리지 않게).
 *   · 예시 데이터를 쓰는 동안에는 맞추지 않습니다.
 *   · 사진은 줄인 사본을 먼저 올리고 사례를 올립니다. 다른 브라우저에서는 사진을 볼 때 한 장씩 받아 브라우저에 둡니다.
 * 계산(무엇을 올리고 받을지)은 js/logic.js 17절, 여기는 통신과 화면입니다. node 에서는 create() 만 씁니다(test/cloud.test.mjs).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.FixCloudCore = api; api.boot(root); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var KEY = 'data10-06.cloud';

  /* env = { sb, prefix, ref, L, P{get,put,blobToB64,b64ToBlob}, app{db(),touch(result)}, kv{get,set}, later(fn,ms)→cancel, now(), mkId(), notify() } */
  function create(env) {
    var L = env.L, sb = env.sb;
    var T = { cases: env.prefix + '_data_cases', shared: env.prefix + '_data_shared', photos: env.prefix + '_data_photos' };
    var snap = L.cloudRestoreSnap(parse(env.kv.get(KEY)), env.ref);
    var st = { on: false, state: 'idle', err: '', last: 0, busy: false, dirty: false, ask: null, held: null, photo: null, photoErr: '',
      wasSample: false, autoUpload: false, answer: null, massOk: false };
    var missPhoto = {}, cancelLater = null, running = null;

    function parse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }
    function saveSnap() { env.kv.set(KEY, JSON.stringify(snap)); }
    function notify() { try { if (env.notify) env.notify(); } catch (e) {} }
    function set(state) { if (st.state !== state) { st.state = state; notify(); } }
    function q(p) { return Promise.resolve(p).then(function (r) { if (r && r.error) throw r.error; return r ? r.data : null; }); }
    function isMissing(e) { return !!e && (/PGRST20[25]|42P01|42883/.test(e.code || '') || /does not exist|Could not find/i.test(e.message || '')); }
    function chunks(a, n) { var out = []; for (var i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; }
    function each(list, fn) { return list.reduce(function (p, x, i) { return p.then(function () { return fn(x, i); }); }, Promise.resolve()); }
    function live(rows) { return (rows || []).filter(function (r) { return r && !r.deleted && r.body; }).length; }

    // ───────── 받기 ─────────
    function since() { if (!snap.at) return null; var t = Date.parse(snap.at); return isNaN(t) ? null : new Date(t - 60000).toISOString(); }
    function pullRows(from) {
      var out = [], at = 0, size = 500;
      function page() {
        var qy = sb.from(T.cases).select('id,body,deleted,updated_at');
        if (from) qy = qy.gt('updated_at', from);
        return q(qy.order('n', { ascending: true }).range(at, at + size - 1)).then(function (d) {
          d = d || []; out = out.concat(d);
          if (d.length === size) { at += size; return page(); }
          return out;
        });
      }
      return page();
    }
    function pullShared() { return q(sb.from(T.shared).select('key,body')); }

    // ───────── 사진 ─────────
    function photoTodo(ids) { return ids.filter(function (id) { return !missPhoto[id] || env.now() - missPhoto[id] > 60000; }); }
    function uploadPhotos(ids) {
      var todo = photoTodo(ids);
      if (!todo.length) return Promise.resolve();
      st.photo = { done: 0, total: todo.length }; notify();
      return each(todo, function (id, i) {
        return env.P.get(id).then(function (rec) {
          if (!rec || !rec.blob) { missPhoto[id] = env.now(); return; }
          return Promise.all([env.P.blobToB64(rec.blob), env.P.blobToB64(rec.thumb || rec.blob)]).then(function (b) {
            var row = { id: id, case_id: String(rec.caseId || '').slice(0, 80), name: String(rec.name || '').slice(0, 200),
              w: Math.round(rec.w) || null, h: Math.round(rec.h) || null, bytes: Math.round(rec.bytes) || null, img: b[0], thumb: b[1] };
            return q(sb.from(T.photos).upsert(row, { onConflict: 'id', ignoreDuplicates: true }));
          }).then(function () { snap.photos[id] = 1; st.photoErr = ''; }, function (e) {
            if (isMissing(e)) throw e;
            missPhoto[id] = env.now(); st.photoErr = (e && e.message) || '사진을 올리지 못했습니다';
          });
        }).then(function () { st.photo.done = i + 1; if ((i + 1) % 5 === 0) saveSnap(); notify(); });
      }).then(function () { st.photo = null; saveSnap(); });
    }
    var fetching = {}, queue = [], active = 0, noPhoto = {};
    function pump() {
      while (active < 3 && queue.length) (function (job) {
        active++;
        q(sb.from(T.photos).select('id,case_id,name,w,h,bytes,img,thumb').eq('id', job.id).maybeSingle()).then(function (row) {
          if (!row || !row.img) { noPhoto[job.id] = env.now(); return null; }
          var rec = { id: row.id, caseId: row.case_id || '', name: row.name || '', type: 'image/jpeg', w: row.w, h: row.h, bytes: row.bytes, memo: '', at: env.now(),
            blob: env.P.b64ToBlob(row.img, 'image/jpeg'), thumb: env.P.b64ToBlob(row.thumb || row.img, 'image/jpeg') };
          return Promise.resolve(env.P.put(rec)).then(function () { return rec; }, function () { return rec; });
        }).then(function (rec) { job.done(rec); }, function () { noPhoto[job.id] = env.now(); job.done(null); })
          .then(function () { active--; delete fetching[job.id]; pump(); });
      })(queue.shift());
    }
    /* 이 브라우저에 없는 사진을 팀 저장소에서 받아 브라우저에 둡니다(없으면 null) */
    function fetchPhoto(id) {
      if (!st.on || st.state === 'missing' || !id) return Promise.resolve(null);
      if (noPhoto[id] && env.now() - noPhoto[id] < 60000) return Promise.resolve(null);
      if (fetching[id]) return fetching[id];
      fetching[id] = new Promise(function (resolve) { queue.push({ id: id, done: resolve }); });
      pump();
      return fetching[id];
    }

    // ───────── 올리기 ─────────
    function push(plan, db) {
      // 올릴 것이 「지금은 이 브라우저에 그림이 없는 사진」뿐이면 조용히 넘어갑니다(1분 뒤 다시 봄)
      if (!plan.upserts.length && !plan.deletes.length && !plan.shared.length && !plan.photoDels.length && !photoTodo(plan.photoAdds).length) return Promise.resolve();
      set('push');
      return uploadPhotos(plan.photoAdds).then(function () {
        return each(chunks(plan.upserts, 20), function (part) {
          return q(sb.from(T.cases).upsert(part.map(function (c) { return { id: c.id, body: L.cloudCaseBody(c), deleted: false }; }), { onConflict: 'id' }))
            .then(function () { part.forEach(function (c) { L.cloudMarkCase(snap, c); }); saveSnap(); });
        });
      }).then(function () {
        return each(chunks(plan.deletes, 100), function (ids) {
          return q(sb.from(T.cases).update({ deleted: true, body: null }).in('id', ids))
            .then(function () { ids.forEach(function (id) { delete snap.cases[id]; }); saveSnap(); });
        });
      }).then(function () {
        return each(plan.shared, function (k) {
          return q(sb.from(T.shared).upsert({ key: k, body: L.cloudSharedValue(db, k) }, { onConflict: 'key' }))
            .then(function () { L.cloudMarkShared(snap, db, k); saveSnap(); });
        });
      }).then(function () {
        if (!plan.photoDels.length) return;
        return each(chunks(plan.photoDels, 100), function (ids) {
          return q(sb.from(T.photos).delete().in('id', ids)).then(function () { ids.forEach(function (id) { delete snap.photos[id]; }); saveSnap(); });
        });
      });
    }
    function pull() {
      return Promise.all([pullRows(since()), pullShared()]).then(function (a) {
        var db = env.app.db();
        // 받는 사이에 화면에서 또 고쳤으면 이번에는 넣지 않고 한 번 더 돕니다(올리지 않은 변경을 덮지 않게)
        var p2 = L.cloudPlan(snap, db);
        if (p2.upserts.length || p2.deletes.length || p2.shared.length) { st.dirty = true; return; }
        var r = L.cloudMerge(db, snap, a[0], a[1]);
        saveSnap();
        if (r.changed) env.app.touch(r);
      });
    }

    // ───────── 처음 맞추기 ─────────
    function adopt() {
      set('pull');
      return Promise.all([pullRows(null), pullShared()]).then(function (a) {
        var db = env.app.db();
        if (db._sample) { st.wasSample = true; set('sample'); return; }
        var mine = L.cloudLocalOnly(db, a[0]);
        if (mine.length && !st.autoUpload && !st.answer) {
          st.ask = { n: mine.length, photos: L.allPhotoIds(mine).length, cloud: live(a[0]) };
          set('ask'); notify(); return;
        }
        var ans = st.answer || 'upload';
        st.answer = null; st.autoUpload = false; st.ask = null;
        var moved = 0;
        if (ans === 'discard') { db.cases = []; db.equipments = []; db.guides = {}; db.nextChecks = {}; }
        else { moved = L.cloudReid(db, a[0], env.mkId); L.cloudFoldShared(db, a[1]); }
        snap = L.cloudSnap(env.ref);
        var r = L.cloudMerge(db, snap, a[0], ans === 'discard' ? a[1] : []);
        snap.adopted = true; saveSnap();
        r.first = true; r.uploaded = ans === 'discard' ? 0 : mine.length; r.moved = moved; r.changed = 1;
        env.app.touch(r);
        return push(L.cloudPlan(snap, db), db).then(function () { st.last = env.now(); st.err = ''; set('ok'); });
      });
    }

    function run() {
      var db = env.app.db();
      if (db._sample) { st.wasSample = true; st.ask = null; st.held = null; set('sample'); return Promise.resolve(); }
      if (st.wasSample) {   // 예시에서 내 자료로 넘어옴 — 팀 저장소와 처음부터 다시 맞춥니다(방금 넣은 자료는 묻지 않고 올림)
        st.wasSample = false; snap = L.cloudSnap(env.ref); st.autoUpload = true; saveSnap();
      }
      if (!snap.adopted) return adopt();
      var plan = L.cloudPlan(snap, db);
      if (plan.risky && !st.massOk) { st.held = { n: plan.deletes.length, left: db.cases.length }; set('held'); notify(); return Promise.resolve(); }
      st.held = null; st.massOk = false;
      return push(plan, db).then(pull).then(function () { st.last = env.now(); st.err = ''; set('ok'); });
    }
    function sync() {
      if (!st.on) return Promise.resolve();
      if (st.busy) { st.dirty = true; return running; }
      st.busy = true; st.dirty = false;
      running = Promise.resolve().then(run).catch(function (e) {
        st.photo = null;
        if (isMissing(e)) set('missing');
        else { st.err = (e && e.message) || String(e); st.state = 'error'; notify(); }
      }).then(function () {
        st.busy = false; notify();
        if (st.dirty && st.on && st.state !== 'missing' && st.state !== 'error') return sync();
      });
      return running;
    }

    return {
      start: function () { st.on = true; st.state = 'idle'; return sync(); },
      stop: function () { st.on = false; if (cancelLater) cancelLater(); cancelLater = null; set('idle'); },
      sync: sync,
      /* 화면이 저장할 때마다 부릅니다 — 1초쯤 모아서 올립니다 */
      changed: function () {
        if (!st.on || st.state === 'missing') return;
        if (cancelLater) cancelLater();
        cancelLater = env.later(function () { cancelLater = null; sync(); }, 1200);
      },
      fetchPhoto: fetchPhoto,
      /* 처음 맞출 때 묻는 말의 답 — 'upload'(이 브라우저의 자료를 팀 저장소에 더하기) · 'discard'(버리고 팀 자료만) */
      answer: function (kind) { if (!st.ask) return Promise.resolve(); st.answer = kind === 'discard' ? 'discard' : 'upload'; st.ask = null; return sync(); },
      /* 한꺼번에 지워졌을 때의 답 — 'delete'(팀 저장소에서도 지우기) · 'restore'(지우지 않고 팀 자료 다시 받기) */
      resolveHeld: function (kind) {
        if (!st.held) return Promise.resolve();
        st.held = null;
        if (kind === 'delete') st.massOk = true;
        else { snap = L.cloudSnap(env.ref); st.answer = 'upload'; saveSnap(); }
        return sync();
      },
      /* 번호가 겹치지 않아야 하는가(팀 저장소를 쓰는 중) */
      active: function () { return st.on && st.state !== 'missing' && st.state !== 'idle'; },
      info: function () {
        return { on: st.on, state: st.state, err: st.err, last: st.last, ask: st.ask, held: st.held, photo: st.photo, photoErr: st.photoErr,
          cases: Object.keys(snap.cases).length, photos: Object.keys(snap.photos).length, adopted: snap.adopted };
      },
      _snap: function () { return snap; }
    };
  }

  /* 위쪽 줄에 보일 한 줄 */
  function noteText(i) {
    function hm(t) { var d = new Date(t), p = function (x) { return String(x).padStart(2, '0'); }; return p(d.getHours()) + ':' + p(d.getMinutes()); }
    if (!i || !i.on) return '';
    if (i.state === 'missing') return '이 브라우저에만 저장됨 · 팀 저장소 준비 전';
    if (i.state === 'sample') return '예시 데이터 · 팀 저장소와 맞추지 않음';
    if (i.state === 'ask' || i.state === 'held') return '팀 저장소 · 확인이 필요합니다';
    if (i.state === 'error') return '팀 저장소 연결 안 됨 · 이 브라우저에는 저장됨';
    if (i.photo) return '팀 저장소에 사진 올리는 중 ' + i.photo.done + '/' + i.photo.total;
    if (i.state === 'push') return '팀 저장소에 올리는 중…';
    if (i.state === 'pull' || i.state === 'idle') return '팀 저장소와 맞추는 중…';
    return '팀 저장소에 저장됨' + (i.last ? ' · ' + hm(i.last) : '');
  }

  // ───────── 브라우저 연결 ─────────
  function boot(root) {
    var core = null, kit = null, timer = null, doc = root.document;
    function info() { return core ? core.info() : null; }
    root.FixCloud = {
      changed: function () { if (core) core.changed(); },
      note: function () { return noteText(info()); },
      active: function () { return !!(core && core.active()); },
      newId: function () { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },
      info: info
    };
    // 이 브라우저에 없는 사진은 팀 저장소에서 받아 옵니다
    var P = root.FixPhotos, localGet = P && P.get;
    if (P) P.get = function (id) {
      return localGet(id).then(function (rec) { return rec || !core ? rec : core.fetchPhoto(id); });
    };

    function el(tag, cls, text) { var e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    function btn(text, cls, fn) { var b = el('button', 'btn btn-sm' + (cls ? ' ' + cls : ''), text); b.type = 'button'; b.onclick = fn; return b; }
    function paint() {
      var i = info(), app = root.FixApp;
      if (app && app.topbar) app.topbar();
      var foot = doc.getElementById('storeFoot');
      if (foot) foot.textContent = i && i.on && i.adopted && i.state !== 'missing' && i.state !== 'sample'
        ? '정비 사례와 사진은 팀 저장소(Supabase)에 올려 승인된 구성원이 함께 봅니다'
        : '정비 사례와 사진은 이 브라우저 안에서만 저장합니다(서버로 보내지 않음)';
      var b = doc.getElementById('cloudBanner'); if (!b) return;
      b.textContent = ''; b.hidden = true;
      if (!i || !i.on) return;
      if (i.state === 'ask' && i.ask) {
        b.hidden = false;
        b.appendChild(el('span', null, '이 브라우저에만 있는 정비 사례 ' + i.ask.n + '건' + (i.ask.photos ? '(사진 ' + i.ask.photos + '장)' : '') + '이 있습니다. 팀 저장소에 올리면 승인된 구성원 모두가 어느 브라우저에서나 봅니다' +
          (i.ask.cloud ? '(지금 팀 저장소에는 ' + i.ask.cloud + '건이 있고, 거기에 더합니다). ' : '. ')));
        b.appendChild(btn('팀 저장소에 올리기', 'btn-primary', function () { core.answer('upload'); }));
        var no = btn('올리지 않고 팀 자료만 쓰기', '', function () {
          if (no.getAttribute('data-sure')) { core.answer('discard'); return; }
          no.setAttribute('data-sure', '1'); no.textContent = '이 브라우저의 ' + i.ask.n + '건을 버립니다 — 한 번 더 누르면 실행'; no.className = 'btn btn-sm btn-danger';
        });
        b.appendChild(no);
      } else if (i.state === 'held' && i.held) {
        b.hidden = false;
        b.appendChild(el('span', null, '이 브라우저에서 정비 사례 ' + i.held.n + '건이 한꺼번에 지워졌습니다. 팀 저장소에서도 지우면 모든 구성원에게서 사라집니다. '));
        b.appendChild(btn('지우지 않고 팀 자료 다시 받기', 'btn-primary', function () { core.resolveHeld('restore'); }));
        var del = btn('팀 저장소에서도 지우기', '', function () {
          if (del.getAttribute('data-sure')) { core.resolveHeld('delete'); return; }
          del.setAttribute('data-sure', '1'); del.textContent = '모든 구성원에게서 ' + i.held.n + '건이 사라집니다 — 한 번 더 누르면 실행'; del.className = 'btn btn-sm btn-danger';
        });
        b.appendChild(del);
      } else if (i.state === 'missing' && kit && kit.isAdmin()) {
        b.hidden = false;
        b.appendChild(el('span', null, '지금은 이 브라우저에만 저장됩니다. 팀이 함께 쓰려면 Supabase 에서 supabase/data.sql 을 한 번 실행해 주세요. '));
        var a = el('a', null, '팀 저장소 안내'); a.href = '#/kit-data'; b.appendChild(a);
      }
      var pg = doc.getElementById('cloudPage'); if (pg) page(pg.parentNode);
    }
    function page(pg) {
      var i = info() || {}, esc = kit.esc, t = kit.prefix + '_data_';
      var stateKo = { ok: '맞춤', push: '올리는 중', pull: '받는 중', idle: '맞추는 중', ask: '확인이 필요합니다(화면 위쪽 줄 아래의 안내)', held: '확인이 필요합니다(화면 위쪽 줄 아래의 안내)',
        sample: '예시 데이터를 쓰는 중이라 맞추지 않습니다', missing: '준비 전 — 아래 순서대로 한 번만 실행해 주세요', error: '연결하지 못했습니다 — ' + (i.err || '') };
      var html = '<div id="cloudPage">' + kit.kpHead('팀 저장소', i.state === 'missing' ? '팀 저장소 준비가 필요합니다' : '팀 저장소', '정비 사례 · 설비 목록 · 가이드 수정 · 사진을 승인된 구성원이 어느 브라우저에서나 함께 봅니다.');
      if (i.state === 'missing') {
        html += '<section class="kp-card"><h2>한 번만 하면 됩니다</h2><ol class="kp-steps">' +
          '<li>Supabase 대시보드에서 내 프로젝트 → 「SQL Editor」 → 「New query」</li>' +
          '<li>이 저장소의 <code>supabase/data.sql</code> 을 메모장으로 열어 전체를 복사해 붙여 넣고 「Run」</li>' +
          '<li>이 화면을 새로고침(Ctrl + F5)하면 위쪽 줄이 「팀 저장소에 저장됨」으로 바뀝니다</li></ol>' +
          '<p class="kp-note">그 전까지는 지금처럼 이 브라우저에만 저장됩니다. 자료는 지워지지 않습니다.</p></section>';
      } else {
        html += '<section class="kp-card"><h2>지금 상태</h2><p><b>' + esc(stateKo[i.state] || i.state || '') + '</b>' +
          (i.last ? ' · 마지막으로 맞춘 시각 ' + esc(kit.fmtTime(i.last)) : '') + '</p>' +
          '<p class="kp-note">팀 저장소의 정비 사례 ' + (i.cases || 0) + '건 · 사진 ' + (i.photos || 0) + '장' +
          (i.photo ? ' · 사진 올리는 중 ' + i.photo.done + '/' + i.photo.total : '') + (i.photoErr ? ' · 올리지 못한 사진이 있습니다(' + esc(i.photoErr) + ') — 잠시 뒤 다시 올립니다' : '') + '</p>' +
          '<button type="button" class="kp-btn kp-primary" id="cloudNow">지금 맞추기</button></section>' +
          '<section class="kp-card"><h2>어떻게 움직이나</h2><ul class="kp-steps">' +
          '<li>사례를 등록 · 고치기 · 지우기 하면 1초쯤 뒤에 팀 저장소로 올라갑니다.</li>' +
          '<li>다른 사람이 고친 것은 25초마다, 그리고 이 창으로 돌아올 때 받아 옵니다.</li>' +
          '<li>같은 사례를 두 사람이 고치면 나중에 저장한 쪽이 남습니다.</li>' +
          '<li>사진은 필요할 때 한 장씩 받아 이 브라우저에 둡니다. 처음 보는 브라우저에서는 잠깐 걸립니다.</li>' +
          '<li>한 번에 절반 넘게 지워지면(모두 지우기 · 백업 되살리기) 팀 저장소에서도 지울지 먼저 묻습니다.</li>' +
          '<li>진단 기준값 · AI 연결 · 엑셀 열 맞추기는 사람마다 달라 이 브라우저에만 둡니다.</li></ul>' +
          '<p class="kp-note">Supabase 「Table Editor」의 <code>' + esc(t) + 'cases</code> · <code>' + esc(t) + 'shared</code> · <code>' + esc(t) + 'photos</code> 에 들어 있습니다. 「설정 → 백업 내려받기」도 그대로 쓸 수 있습니다.</p></section>';
      }
      pg.innerHTML = html + '</div>';
      var now = pg.querySelector('#cloudNow'); if (now) now.onclick = function () { core.sync(); };
    }

    function start() {
      var app = root.FixApp; if (!app || core) { if (core) core.start(); return; }
      core = create({
        sb: kit.sb, prefix: kit.prefix, ref: kit.config.url, L: root.FixLogic,
        P: { get: localGet, put: P.put, blobToB64: P.blobToB64, b64ToBlob: P.b64ToBlob },
        app: {
          db: app.db,
          touch: function (r) {
            app.touch();
            if (r && r.first) app.toast(r.uploaded ? '이 브라우저의 사례 ' + r.uploaded + '건을 팀 저장소에 올립니다' : '팀 저장소의 자료를 받아 왔습니다');
            else if (r && (r.added || r.updated || r.removed)) app.toast('팀 저장소에서 받아 왔습니다 — 새 사례 ' + r.added + '건 · 고친 것 ' + r.updated + '건 · 지운 것 ' + r.removed + '건');
          }
        },
        kv: { get: function (k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { root.localStorage.setItem(k, v); } catch (e) {} } },
        later: function (fn, ms) { var id = root.setTimeout(fn, ms); return function () { root.clearTimeout(id); }; },
        now: function () { return Date.now(); },
        mkId: root.FixCloud.newId,
        notify: paint
      });
      core.start();
      timer = root.setInterval(function () { if (!doc.hidden) core.sync(); }, 25000);
      doc.addEventListener('visibilitychange', onShow);
    }
    function onShow() { if (core && !doc.hidden) core.sync(); }
    function stop() {
      if (timer) root.clearInterval(timer); timer = null;
      doc.removeEventListener('visibilitychange', onShow);
      if (core) core.stop(); core = null; paint();
    }

    (root.AUTH_KIT_EXT = root.AUTH_KIT_EXT || []).push(function (k) {
      if (k.local || !k.sb || k.config.cloud === false || !root.FixApp || !P) return;
      kit = k;
      k.addPage('kit-data', '팀 저장소', function (pg) { page(pg); }, { icon: 'upload', mount: start, unmount: stop });
    });
  }

  return { create: create, noteText: noteText, boot: boot, KEY: KEY };
});
