/* 현장 고장 기록지 — 수강생이 만든 「설비 고장/수리 기록지」(종이 한 장) 를 인쇄하고, 손으로 채운 기록지 사진을 AI(OpenAI 비전)로 읽어
   정비 사례 한 건으로 바꿉니다. 4차(2026-11-08). 화면(app.js)은 판정하지 않고, 지시문 · 요청 모양 · 답 읽기 · 검사 · 사례 변환은 전부 여기 두고
   test/logic.test.mjs 로 고정합니다. 브라우저(window.FixFieldForm)와 node(require) 겸용.

   지키는 것 (build-2611-11 스캔본 읽기와 같은 원칙)
   - AI 는 사용자가 자기 키를 넣고 「외부로 보내도 되는 자료」 를 확인했을 때만 부릅니다. 키가 없으면 같은 칸을 손으로 채웁니다.
   - 키는 코드 · 리포에 없습니다. 「이 브라우저에 기억」 을 고른 때만 localStorage 에, 아니면 이 창에서만 씁니다.
   - AI 답을 믿지 않습니다 — JSON 만 꺼내고, 날짜 · 수리 구분 · 멈춘 시간 · 처리 상태를 검사해 「확인할 것」 으로 올리고, 사람이 고친 뒤에만 사례로 넣습니다.
   - 읽을 수 없는 칸은 비워 둡니다. 지어내지 않습니다(지시문에도 적고, 답의 unreadable 을 그대로 보입니다). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./logic.js'));
  else root.FixFieldForm = factory(root.FixLogic);
})(typeof self !== 'undefined' ? self : this, function (L) {
  'use strict';

  /* ── 기록지 칸 — 수강생 양식(2026-10-29 패들릿, 시트 「양식」) 순서 그대로 ── */
  var FIELDS = [
    { id: 'writtenAt', label: '작성일자', kind: 'date' },
    { id: 'writer', label: '작성자' },
    { id: 'equipment', label: '설비명', need: true },
    { id: 'occurredAt', label: '발생 일시', kind: 'date' },
    { id: 'symptom', label: '고장 증상 (상세 기재)', need: true, long: true },
    { id: 'cause', label: '원인 / 점검 결과', long: true },
    { id: 'steps', label: '조치 사항 (1. 2. 3. 순서대로)', hint: '자체조치이면 마지막에 「자체조치」 라고 기입', long: true },
    { id: 'parts', label: '교체 부품 (없으면 없음)' },
    { id: 'repairBy', label: '수리 구분 (자체/외부)' },
    { id: 'vendor', label: '수리 업체명' },
    { id: 'downtime', label: '멈춘 시간' },
    { id: 'status', label: '처리 상태 (완료/진행중)' },
    { id: 'photo', label: '사진 첨부 (고장 부위, 수리 후)' },
    { id: 'memo', label: '비고', long: true }
  ];
  var LABEL = {}; FIELDS.forEach(function (f) { LABEL[f.id] = f.label; });

  /* 인쇄 모양 — 엑셀 양식의 줄 높이(pt)와 4칸 너비(글자 수)를 그대로 옮겼습니다. pair = [왼쪽 칸, 오른쪽 칸] 이 한 줄에 둘 */
  var LAYOUT = {
    cols: [27, 22.4, 11.9, 24.9],
    rows: [
      { one: 'writtenAt', h: 38 }, { one: 'writer', h: 38 }, { gap: true, h: 14 },
      { pair: ['equipment', 'occurredAt'], h: 35 },
      { one: 'symptom', h: 50 }, { one: 'cause', h: 60 }, { one: 'steps', h: 112 },
      { pair: ['parts', 'repairBy'], h: 49 }, { pair: ['vendor', 'downtime'], h: 49 },
      { one: 'status', h: 46 }, { one: 'photo', h: 56 }, { one: 'memo', h: 56 }
    ]
  };
  function title(team) { var t = str(team); return (t ? t + ' ' : '') + '설비 고장/수리 기록지'; }

  function str(v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); }
  function blank() { var o = {}; FIELDS.forEach(function (f) { o[f.id] = ''; }); o.occurredTime = ''; o.unreadable = []; o.confidence = ''; return o; }

  /* ── AI 지시문 ── */
  function prompt() {
    var sys = [
      '당신은 공장 현장 작업자가 손으로 적은 「설비 고장/수리 기록지」 사진을 읽어 칸별로 옮기는 보조자입니다.',
      '기록지 칸(위에서 아래로): ' + FIELDS.map(function (f) { return f.label; }).join(' · ') + '.',
      '규칙:',
      '1. 사진에 적힌 글만 옮깁니다. 비어 있거나 읽을 수 없는 칸은 null 로 두고, 읽을 수 없는 칸은 unreadable 에 칸 이름을 적습니다. 추측해 채우지 않습니다.',
      '2. 날짜는 "YYYY-MM-DD", 시각이 있으면 occurredTime 에 "HH:MM"(24시간제). 연도가 없으면 작성일자의 연도를 씁니다.',
      '3. 조치 사항은 적힌 순서대로 한 단계씩 배열(steps)로, 번호(1. 2)는 떼고 글만. 「자체조치」 도 적혀 있으면 그대로 마지막 단계로 둡니다.',
      '4. 수리 구분은 "자체" 또는 "외부", 처리 상태는 "완료" 또는 "진행 중" — 체크 표시나 동그라미로 고른 것을 읽습니다.',
      '5. 반드시 JSON 하나만 답합니다. 설명 문장을 붙이지 않습니다.',
      'JSON 모양: {"writtenAt":"YYYY-MM-DD","writer":"","equipment":"","occurredAt":"YYYY-MM-DD","occurredTime":"HH:MM","symptom":"","cause":"","steps":[""],' +
      '"parts":"","repairBy":"자체"|"외부","vendor":"","downtime":"","status":"완료"|"진행 중","photo":"","memo":"","unreadable":["칸 이름"],"confidence":"high"|"mid"|"low"}'
    ].join('\n');
    var user = '이 사진은 설비 고장/수리 기록지 한 장입니다. 위 JSON 모양으로 모든 칸을 옮겨 주세요. 손글씨가 흐리면 null 로 두고 unreadable 에 적어 주세요.';
    return { system: sys, user: user };
  }
  var DEFAULT_MODEL = 'gpt-4o-mini';
  var API_URL = 'https://api.openai.com/v1/chat/completions';
  /* 요청 — fetch(url, init) 에 그대로. image = 'data:image/jpeg;base64,…' */
  function buildRequest(key, image, model) {
    if (!str(key)) throw new Error('OpenAI API 키를 넣어 주세요.');
    if (/[^\x21-\x7e]/.test(str(key))) throw new Error('API 키에 한글 · 공백 같은 글자가 섞였습니다. OpenAI 화면에서 키를 다시 복사해 붙여 넣어 주세요.');
    if (!/^data:image\/(jpeg|png|webp|gif);base64,/.test(String(image || ''))) throw new Error('사진(JPG · PNG) 한 장을 올려 주세요.');
    var pr = prompt();
    return { url: API_URL, init: { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + str(key) },
      body: JSON.stringify({ model: str(model) || DEFAULT_MODEL, temperature: 0, max_tokens: 2000, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: pr.system }, { role: 'user', content: [{ type: 'text', text: pr.user }, { type: 'image_url', image_url: { url: image, detail: 'high' } }] }] }) } };
  }
  function extractText(json) {
    if (!json || typeof json !== 'object') throw new Error('AI 응답이 JSON 이 아닙니다.');
    if (json.error) throw new Error('AI 오류: ' + (json.error.message || json.error.type || JSON.stringify(json.error)));
    var c = (((json.choices || [])[0] || {}).message || {}).content;
    if (Array.isArray(c)) c = c.map(function (p) { return p && (p.text || ''); }).join('');
    if (typeof c !== 'string' || !c.trim()) throw new Error('AI 응답에 답 글이 없습니다.');
    return c;
  }
  /* 실제 호출 — fetchImpl 은 테스트용 */
  function read(key, image, opts) {
    opts = opts || {};
    var f = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!f) return Promise.reject(new Error('이 환경에서는 fetch 를 쓸 수 없습니다.'));
    var rq;
    try { rq = buildRequest(key, image, opts.model); } catch (e) { return Promise.reject(e); }
    return f(rq.url, rq.init).then(function (res) {
      return res.text().then(function (t) {
        var j = null; try { j = JSON.parse(t); } catch (e) { /* 아래 */ }
        if (!res.ok) throw new Error('AI 가 ' + res.status + ' 로 답했습니다. ' + (j && j.error ? (j.error.message || '') : String(t).slice(0, 200)));
        return parseReply(extractText(j));
      });
    });
  }

  /* ── 답 읽기 — JSON 만 꺼내고 칸 이름을 맞춥니다. 영어 id 대신 기록지 칸 이름(「설비명」)으로 답해도 받습니다 ── */
  var ALIAS = {
    writtenAt: ['작성일자', '작성일'], writer: ['작성자'], equipment: ['설비명', '설비'], occurredAt: ['발생일시', '발생일자', '발생일'],
    occurredTime: ['발생시각', '발생시간'], symptom: ['고장증상', '증상'], cause: ['원인', '점검결과', '원인점검결과'],
    steps: ['조치사항', '조치'], parts: ['교체부품', '부품'], repairBy: ['수리구분', '구분'], vendor: ['수리업체명', '수리업체', '업체명', '업체'],
    downtime: ['멈춘시간', '정지시간'], status: ['처리상태', '상태'], photo: ['사진첨부', '사진'], memo: ['비고', '메모']
  };
  function keyOf(k) {
    if (Object.prototype.hasOwnProperty.call(LABEL, k) || k === 'occurredTime' || k === 'unreadable' || k === 'confidence') return k;
    var s = String(k).replace(/\([^)]*\)/g, '').replace(/[\s/·.,]/g, '');
    for (var id in ALIAS) if (ALIAS[id].some(function (a) { return s === a || s.indexOf(a) === 0; })) return id;
    return '';
  }
  function parseReply(text) {
    var t = String(text || ''), a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return { fields: blank(), error: 'AI 답에서 JSON 을 찾지 못했습니다.' };
    var j; try { j = JSON.parse(t.slice(a, b + 1)); } catch (e) { return { fields: blank(), error: 'AI 답의 JSON 을 읽지 못했습니다: ' + e.message }; }
    if (j && j.fields && typeof j.fields === 'object') j = j.fields;
    var raw = {};
    Object.keys(j || {}).forEach(function (k) { var id = keyOf(k); if (id && raw[id] == null) raw[id] = j[k]; });
    return { fields: normalize(raw), error: '' };
  }
  function dateOf(v) {
    var s = str(v); if (!s) return '';
    var iso = L.toISO(s.replace(/\s*\(.\)\s*/, ' ').replace(/\s+\d{1,2}:\d{2}.*$/, ''));
    return iso || '';
  }
  function timeOf(v) {
    var s = str(v).replace(/\s/g, ''); if (!s) return '';
    var pm = /오후|PM/i.test(s); s = s.replace(/오전|오후|AM|PM/gi, '');
    var m = /(\d{1,2})[:시](\d{1,2})?/.exec(s); if (!m) return '';
    var h = +m[1], mi = m[2] != null ? +m[2] : 0; if (pm && h < 12) h += 12;
    if (h > 24 || mi > 59) return '';
    return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
  }
  function byOf(v) {
    var s = str(v); if (!s) return '';
    var self = /자체/.test(s), ext = /외부|업체|외주/.test(s);
    if (self && !ext) return '자체';
    if (ext && !self) return '외부';
    return '';
  }
  function statusOf(v) {
    var s = str(v); if (!s) return '';
    if (/진행/.test(s) && !/완료/.test(s)) return '진행 중';
    if (/완료/.test(s) && !/진행/.test(s)) return '완료';
    return '';
  }
  /* 원래 값(raw)을 남겨 두고, 읽은 값은 다듬어 둡니다. 날짜·구분·상태가 다듬어지지 않으면 「확인할 것」 으로 올라갑니다 */
  function normalize(raw) {
    raw = raw || {};
    var o = blank(), rawOut = {};
    FIELDS.forEach(function (f) {
      var v = raw[f.id];
      if (f.id === 'steps') v = Array.isArray(v) ? v.map(str).filter(Boolean).map(function (x, i) { return (i + 1) + ') ' + x.replace(/^\d{1,2}\s*[.)]\s*/, ''); }).join('\n') : str(v);
      else v = Array.isArray(v) ? v.map(str).filter(Boolean).join(', ') : str(v);
      if (/^(null|undefined)$/i.test(v)) v = '';
      rawOut[f.id] = v; o[f.id] = v;
    });
    // 발생 일시에 시각이 붙어 오면 나눕니다
    var occ = str(raw.occurredAt), tm = timeOf(raw.occurredTime) || (/\d{1,2}:\d{2}/.test(occ) ? timeOf(occ.replace(/^.*?(\d{1,2}:\d{2}).*$/, '$1')) : '');
    o.occurredAt = dateOf(occ) || occ; o.occurredTime = tm;
    o.writtenAt = dateOf(raw.writtenAt) || str(raw.writtenAt);
    o.repairBy = byOf(raw.repairBy) || str(raw.repairBy);
    o.status = statusOf(raw.status) || str(raw.status);
    o.unreadable = (Array.isArray(raw.unreadable) ? raw.unreadable : raw.unreadable ? [raw.unreadable] : []).map(str).filter(Boolean);
    o.confidence = /^(high|mid|low)$/.test(str(raw.confidence)) ? str(raw.confidence) : '';
    o.raw = rawOut;
    return o;
  }

  /* ── 검사 — 사례로 넣기 전 사람이 볼 것 ── */
  function isDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(str(v)) && !!L.toISO(v); }
  function validate(f) {
    f = f || {}; var out = [];
    function iss(id, what, stop) { out.push({ id: id, label: LABEL[id] || id, what: what, stop: !!stop }); }
    if (!str(f.equipment)) iss('equipment', '설비명이 비어 있습니다');
    if (!str(f.symptom)) iss('symptom', '고장 증상이 비어 있습니다 — 증상이 없으면 사례로 넣지 않습니다', true);
    if (str(f.occurredAt) && !isDate(f.occurredAt)) iss('occurredAt', '날짜로 읽지 못했습니다: ' + f.occurredAt + ' (예: 2026-10-29)');
    if (!str(f.occurredAt) && !isDate(f.writtenAt)) iss('occurredAt', '발생 일시 · 작성일자가 모두 없어 날짜 없는 사례가 됩니다');
    if (str(f.writtenAt) && !isDate(f.writtenAt)) iss('writtenAt', '날짜로 읽지 못했습니다: ' + f.writtenAt);
    if (!str(f.cause)) iss('cause', '원인이 비어 있어 증상 · 조치에서 짐작합니다(「짐작」 표시)');
    if (str(f.repairBy) && f.repairBy !== '자체' && f.repairBy !== '외부') iss('repairBy', '「자체」 「외부」 중 하나로 골라 주세요: ' + f.repairBy);
    if (str(f.downtime) && L.toHours(hoursText(f.downtime)) == null) iss('downtime', '시간으로 읽지 못했습니다: ' + f.downtime + ' (예: 3 · 1시간 30분 · 40분)');
    if (str(f.status) && f.status !== '완료' && f.status !== '진행 중') iss('status', '「완료」 「진행 중」 중 하나로 골라 주세요: ' + f.status);
    (f.unreadable || []).forEach(function (u) { var id = keyOf(u) || ''; out.push({ id: id, label: LABEL[id] || u, what: 'AI 가 읽지 못했다고 한 칸입니다 — 원본과 대조해 주세요', stop: false }); });
    if (f.confidence === 'low') iss('', 'AI 의 읽기 확신이 낮습니다 — 칸마다 원본과 대조해 주세요');
    return out;
  }
  function hoursText(v) { return str(v).replace(/\s/g, '').replace(/^약/, '').replace(/(시간|hr|h)?정도$/, '$1'); }

  /* ── 정비 사례로 — app.js 의 「정비 사례 등록」 창에 그대로 넘기는 값(그 창에서 한 번 더 보고 저장) ── */
  function lastStepSelf(steps) { var s = L.splitSteps(steps); return s.length ? /^자체\s?(조치|교체|수리|처리)/.test(s[s.length - 1]) : false; }
  function toCase(f, opts) {
    f = f || {}; opts = opts || {};
    var date = isDate(f.occurredAt) ? f.occurredAt : isDate(f.writtenAt) ? f.writtenAt : '';
    var steps = L.splitSteps(f.steps);
    var by = f.repairBy === '자체' || f.repairBy === '외부' ? f.repairBy : lastStepSelf(f.steps) ? '자체' : str(f.vendor) && !/자체/.test(f.vendor) ? '외부' : '';
    var vendor = str(f.vendor); if (by === '자체' && /^자체/.test(vendor)) vendor = '자체 조치';
    var cause = str(f.cause), inferred = false;
    if (!cause) { cause = L.inferCause(str(f.symptom), steps.join(' '), str(f.equipment), str(f.parts)); inferred = true; }
    var memo = [str(f.memo), f.occurredTime ? '발생 ' + f.occurredTime : '', str(f.writer) ? '작성자 ' + str(f.writer) : '', isDate(f.writtenAt) ? '작성일자 ' + f.writtenAt : ''].filter(Boolean).join(' · ');
    return {
      date: date, datePrec: date ? 'day' : '', equipment: str(f.equipment), symptom: str(f.symptom), tags: L.extractTags(str(f.symptom)),
      cause: cause, causeInferred: inferred, steps: steps, parts: str(f.parts), repairBy: by, vendor: vendor,
      cost: '', costKind: 'missing', hours: L.toHours(hoursText(f.downtime)), status: f.status === '완료' || f.status === '진행 중' ? f.status : '',
      media: str(f.photo), memo: memo, source: opts.source || '현장 기록지', photos: opts.photos || []
    };
  }

  /* ── 예제(가짜 — 실제 기록지가 아닙니다) ── */
  function sampleReply() {
    return JSON.stringify({ writtenAt: '2026-11-03', writer: '작업자01', equipment: '압출기 2호기', occurredAt: '2026-11-03', occurredTime: '14:20',
      symptom: '히터 존 3 온도가 설정값까지 안 올라가고 제품 표면이 거칠어짐', cause: '히터 연결선 단자 풀림',
      steps: ['온도 표시 확인', '설비 정지 · 전원 차단', '히터 연결 단자 확인 — 3존 단자 풀림', '단자 재체결', '재가동 후 온도 확인', '자체조치'],
      parts: '없음', repairBy: '자체', vendor: null, downtime: '1시간 30분', status: '완료', photo: '단체 대화방 공유', memo: null, unreadable: [], confidence: 'high' });
  }

  return { FIELDS: FIELDS, LABEL: LABEL, LAYOUT: LAYOUT, DEFAULT_MODEL: DEFAULT_MODEL, API_URL: API_URL, title: title, blank: blank,
    prompt: prompt, buildRequest: buildRequest, extractText: extractText, read: read, parseReply: parseReply, normalize: normalize,
    validate: validate, toCase: toCase, sampleReply: sampleReply, keyOf: keyOf, dateOf: dateOf, timeOf: timeOf };
});
