// 헤드리스 브라우저로 주요 흐름 점검 (선택 — playwright-core 가 있는 PC 에서만)
//   PLAYWRIGHT_CORE=/경로/node_modules/playwright-core node scripts/check-browser.mjs
// file:// 로 index.html 을 열어 ① 예시 시작 → 8개 화면(1280·390px 가로 넘침) → 진단
// ② 3차 「예시 수리이력(지금 양식 · 사진 포함)」 가져오기 → 미리 보기 26건·사진 22장 → 사진이 사례에 붙음(IndexedDB) · 자료 점검
// ③ 2차 양식 예시를 「전에 가져온 엑셀 사례를 지우고 바꾸기」 로 다시 가져와 → 자료 점검 · 비용 현황(구분 모름·중복 의심) · 진단(서보) 순서로 누르고 JS 오류를 잽니다.
// FILE=엑셀경로 를 주면 그 파일을 가져와 읽히는지·화면이 그려지는지만 봅니다(내 PC 의 실제 자료 점검용 — 결과에 값은 찍지 않고 건수만).
// BREAK=1 이면 일부러 넓은 상자를 넣어 넘침 검사가 잡는지 봅니다.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const url = 'file://' + path.join(root, 'index.html');
const VIEWS = ['diagnose', 'cases', 'guide', 'cost', 'import', 'field', 'check', 'settings', 'next'];

const errors = [], problems = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('dialog', d => d.accept());
function ok(cond, msg) { if (!cond) { problems.push(msg); console.log('  FAIL ' + msg); } else console.log('  ok  ' + msg); }
async function go(hash) { await page.evaluate(h => { location.hash = h; }, hash); await page.waitForTimeout(250); }
async function overflow() {
  return page.evaluate(() => {
    const W = document.documentElement.clientWidth, bad = [];
    document.querySelectorAll('main *').forEach(el => {
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
      let p = el.parentElement, inScroll = false;
      while (p) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') { inScroll = true; break; } p = p.parentElement; }
      if (!inScroll && r.right > W + 1) bad.push(el.tagName + '.' + el.className);
    });
    return bad.slice(0, 3);
  });
}
async function sweep(tag) {
  for (const id of VIEWS) {
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: 900 });
      await go('#/' + id);
      const txt = await page.textContent('main');
      const bad = await overflow();
      ok(!/화면을 그리지 못했습니다/.test(txt) && !bad.length, tag + ' ' + id + ' ' + w + 'px 그려짐·가로 넘침 없음' + (bad.length ? ' — ' + bad.join(', ') : ''));
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}
async function diagnose(text) {
  await go('#/diagnose');
  await page.fill('textarea[aria-label="증상"]', text);
  await page.locator('button', { hasText: '원인 짚어 보기' }).click();
  await page.waitForTimeout(300);
  return page.locator('#diagResult .cause-name').allTextContents();
}

await page.goto(url);
if (process.env.FILE) {
  await go('#/import');
  await page.setInputFiles('input[type=file][accept=".xlsx,.xls,.xlsm,.csv"]', process.env.FILE);
  await page.waitForTimeout(1500);
  const pv = await page.textContent('main');
  const m = /읽은 사례 (\d+)건/.exec(pv);
  ok(!!m && Number(m[1]) > 0, '실제 파일 읽힘 — 사례 ' + (m ? m[1] : 0) + '건');
  const pm = /엑셀에 붙은 사진 (\d+)장 — 사례 (\d+)건에 (\d+)장/.exec(pv);
  console.log('       사진: ' + (pm ? pm[1] + '장 → 사례 ' + pm[2] + '건' : '없음'));
  ok(/이 파일의 자료 점검/.test(pv), '미리 보기에 자료 점검 요약');
  await page.locator('button', { hasText: /^사례 \d+건 더하기/ }).click();
  if (pm) await page.waitForFunction(() => /사진 \d+장을 사례에 붙였습니다/.test(document.getElementById('toast').textContent), null, { timeout: 120000 });
  await page.waitForTimeout(600);
  const ck = await page.textContent('main');
  ok(/칸별 채움/.test(ck), '가져온 뒤 자료 점검 화면으로');
  if (pm) { const n = await page.evaluate(() => JSON.parse(localStorage.getItem('data10-06.db')).cases.reduce((s, c) => s + (c.photos || []).length, 0)); ok(n === Number(pm[3]), '사진 ' + n + '장이 사례에 저장됨'); }
  await sweep('실제');
  const top = await diagnose('냉각기에서 누유');
  ok(top.length > 0, '실제 자료로 진단 결과 ' + top.length + '개 원인');
} else {
  if (process.env.BREAK) await page.addStyleTag({ content: '.page-head { min-width: 900px; }' });
  await page.locator('button', { hasText: '예시 데이터로 시작' }).first().click();
  await page.waitForTimeout(500);
  ok(await page.locator('#sampleBanner').isVisible(), '예시 띠 보임');
  const top = await diagnose('온도가 안 올라가고 기계가 멈춤');
  ok(top[0] === '히터 단선' && top.includes('온도 센서 불량'), '예시 진단: 히터 단선 · 온도 센서 불량');
  await sweep('예시');

  // 4차 — 현장 고장 기록지: 인쇄 모양 · 사진 → (가짜 OpenAI) 읽기 → 확인 → 사례 등록(사진 붙음) · 키는 기억 안 함
  await go('#/field');
  const sheet = await page.evaluate(() => { const t = document.querySelector('.field-sheet'); return { rows: t.querySelectorAll('tr').length, th: [...t.querySelectorAll('th')].map(x => x.firstChild.textContent) }; });
  ok(sheet.rows === 13 && sheet.th.includes('고장 증상 (상세 기재)') && sheet.th.includes('멈춘 시간') && sheet.th.length === 15, '기록지 13줄 · 칸 이름 (' + sheet.rows + '줄, th ' + sheet.th.length + ')');
  await page.evaluate(() => document.body.classList.add('print-field')); await page.emulateMedia({ media: 'print' });
  const pr = await page.evaluate(() => ({ head: getComputedStyle(document.querySelector('.page-head')).display, sheet: getComputedStyle(document.querySelector('.field-sheet')).display, cards: [...document.querySelectorAll('main section.card')].filter(x => getComputedStyle(x).display !== 'none').length, h: document.querySelector('.field-sheet').getBoundingClientRect().height }));
  ok(pr.head === 'none' && pr.sheet === 'table' && pr.cards === 1, '인쇄 — 기록지만 (' + JSON.stringify(pr) + ')');
  await page.emulateMedia({ media: 'screen' }); await page.evaluate(() => document.body.classList.remove('print-field'));
  const XIm = require(path.join(root, 'js/xlsx-images.js'));
  let sentAuth = '', sentImg = false;
  await page.route('https://api.openai.com/**', async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    sentAuth = req.headers().authorization || ''; sentImg = /data:image\/jpeg;base64,/.test(req.postData() || '');
    const FFm = require(path.join(root, 'js/fieldform.js'));
    await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ choices: [{ message: { content: FFm.sampleReply() } }] }) });
  });
  await page.setInputFiles('input[aria-label="기록지 사진 고르기"]', { name: '기록지.png', mimeType: 'image/png', buffer: Buffer.from(XIm.placeholderPng(600, 800, [200, 200, 200], 3)) });
  await page.waitForFunction(() => !!document.querySelector('.field-shot img'), null, { timeout: 10000 });
  await page.fill('input[aria-label="OpenAI API 키"]', 'sk-test-fakekey');
  await page.check('.alert.warn input[type=checkbox]');
  await page.locator('button', { hasText: 'AI 로 읽기' }).click();
  await page.waitForSelector('#fieldConfirm', { timeout: 10000 });
  const conf = await page.textContent('#fieldConfirm');
  ok(sentAuth === 'Bearer sk-test-fakekey' && sentImg, 'OpenAI 로 본인 키 · 사진을 보냄(가짜 서버)');
  ok(/확인할 것이 없습니다/.test(conf) && await page.inputValue('#fieldConfirm input >> nth=2') === '압출기 2호기', '읽은 값 확인 화면 — 설비명 채움');
  ok(!/sk-test/.test(await page.evaluate(() => localStorage.getItem('data10-06.vision') || '')), '키는 기억을 안 켜면 저장 안 함');
  const n0 = await page.evaluate(() => JSON.parse(localStorage.getItem('data10-06.db')).cases.length);
  await page.locator('button', { hasText: '정비 사례 등록 창 열기' }).click();
  await page.waitForSelector('dialog[open]');
  ok(/히터 존 3/.test(await page.inputValue('dialog textarea >> nth=0')), '등록 창에 증상이 채워짐');
  await page.locator('dialog button', { hasText: '저장' }).click();
  await page.waitForTimeout(500);
  const added = await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('data10-06.db')); const c = d.cases[d.cases.length - 1]; return { n: d.cases.length, src: c.source, pics: (c.photos || []).length, by: c.repairBy, hours: c.hours, date: c.date }; });
  ok(added.n === n0 + 1 && added.src === '현장 기록지(사진)' && added.pics === 1 && added.by === '자체' && added.hours === 1.5 && added.date === '2026-11-03', '기록지 → 사례 1건(사진 1장 · 자체 · 1.5시간) ' + JSON.stringify(added));
  ok(!(await page.$('#fieldConfirm')), '등록 뒤 확인 화면 비움');
  await page.locator('button', { hasText: '손으로 입력(키 없이)' }).click();
  await page.waitForSelector('#fieldConfirm');
  ok(/고장 증상이 비어 있습니다/.test(await page.textContent('#fieldConfirm')), '손으로 입력 — 빈 칸 · 증상 필요 안내');
  await page.locator('button', { hasText: '비우기' }).click();

  // 3차 — 10-23 수정본 모양 + 엑셀에 붙인 사진
  await go('#/import');
  await page.locator('button', { hasText: '예시 수리이력(지금 양식 · 사진 포함)으로 시험' }).click();
  await page.waitForTimeout(800);
  const pv3 = await page.textContent('main');
  ok(/읽은 사례 26건/.test(pv3), '3차 미리 보기 26건');
  ok(/엑셀에 붙은 사진 22장 — 사례 22건에 22장/.test(pv3), '3차 미리 보기 — 사진 22장 · 사례 22건');
  await page.locator('button', { hasText: /^사례 26건 더하기/ }).click();
  await page.waitForFunction(() => /사진 \d+장을 사례에 붙였습니다/.test(document.getElementById('toast').textContent), null, { timeout: 60000 });
  await page.waitForTimeout(500);
  const ph = await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('data10-06.db')); return { cases: d.cases.length, withPic: d.cases.filter(c => (c.photos || []).length).length, pics: d.cases.reduce((s, c) => s + (c.photos || []).length, 0), w: Math.max(...d.cases.flatMap(c => (c.photos || []).map(p => Math.max(p.w, p.h)))) }; });
  ok(ph.cases === 26 && ph.withPic === 22 && ph.pics === 22, '사진 22장이 22건에 붙음 (' + JSON.stringify(ph) + ')');
  ok(ph.w <= 1280, '줄인 사본(긴 변 ≤ 1280px)');
  const ck3 = await page.textContent('main');
  ok(/증상 사진/.test(ck3) && /22\/26/.test(ck3), '자료 점검 — 증상 사진 22/26');
  ok(/0원으로 적힌 줄 7건/.test(ck3) && /처리일자가 일자보다 늦은 줄 3건/.test(ck3), '자료 점검 — 0원 7건 · 처리일자 늦은 줄 3건');
  await go('#/cases');
  ok(await page.locator('.thumb-btn img').count() >= 1, '사례 목록에 작은 그림');
  await sweep('3차');

  // 2차 — 10-21 양식 모양의 가상 수리이력을 「바꾸기」 로 가져오기
  await go('#/import');
  await page.locator('button', { hasText: '예시 수리이력(10-21 2차 양식)으로 시험' }).click();
  await page.waitForTimeout(600);
  const pv = await page.textContent('main');
  ok(/전에 엑셀에서 가져온 사례 26건을 지우고/.test(pv), '수정본 바꾸기 선택지(기본 켬)');
  ok(/읽은 사례 26건/.test(pv), '수리이력 미리 보기 26건');
  ok(/짐작/.test(pv), '원인 「짐작」 표시');
  ok(/2025-03 2주차/.test(pv) || /2025-03/.test(pv), '주차·월 일자 표기');
  ok(/이 파일의 자료 점검/.test(pv) && /더 채우면 좋은 칸/.test(pv), '미리 보기에 자료 점검 요약');
  ok(!/확인할 줄 \d+개/.test(pv), '못 읽은 줄 없음');
  await page.locator('button', { hasText: /^사례 26건 더하기/ }).click();
  await page.waitForTimeout(600);
  const chk = await page.textContent('main');
  ok(/칸별 채움/.test(chk) && /원인\(점검 결과\)/.test(chk), '자료 점검 화면 — 칸별 채움');
  ok(/같은 금액 1쌍/.test(chk), '자료 점검 — 같은 금액 중복 의심 1쌍');
  ok(!(await page.locator('#sampleBanner').isVisible()), '예시 띠 사라짐(예시 지우고 가져옴)');
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('data10-06.db')).cases.every(c => !(c.photos || []).length)), '바꾸기 — 3차 사례·사진이 빠짐');
  ok((await page.textContent('#dataChip')).includes('26건'), '사례 26건');
  await go('#/cost');
  const cost = await page.textContent('main');
  ok(/구분 모름/.test(cost) && /견적\(실지출 아님\)/.test(cost) && /한 번만 셈/.test(cost), '비용 현황 — 구분 모름 · 견적 · 중복 한 번만');
  ok(/설비 종류별/.test(cost) && /부위별/.test(cost) && /수리 업체별/.test(cost), '비용 현황 — 종류·부위·업체별 표');
  const top2 = await diagnose('서보 알람 뜨고 멈춤');
  ok(top2[0] === '서보 드라이버·서보 이상', '수리이력 진단: 서보 1위 (' + top2[0] + ')');
  await go('#/guide');
  ok(/지난 조치 기록/.test(await page.textContent('main')), '가이드북 — 지난 조치 기록');
  await sweep('수리이력');
  // 사례 고치기 — 원인을 고치면 짐작 표시가 사라짐
  await go('#/cases');
  await page.locator('button', { hasText: '고치기' }).first().click();
  await page.waitForTimeout(200);
  ok(await page.locator('dialog select').count() >= 3, '고치기 창 — 비용 구분·처리 상태 고르기');
  await page.locator('dialog button', { hasText: '취소' }).click();
}
ok(!errors.length, 'JS 오류 없음' + (errors.length ? ' — ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
console.log(problems.length ? '\n' + problems.length + '개 문제' : '\n모두 통과');
process.exitCode = problems.length ? 1 : 0;
