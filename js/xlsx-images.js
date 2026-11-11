/* 엑셀(.xlsx)에 붙여 넣은 사진 읽기 · 3차(10-23 수정본 반영)
 *
 * SheetJS 커뮤니티판은 표 값만 읽고 그림은 읽지 않습니다. 그래서 .xlsx(zip) 안을 직접 엽니다.
 * zip 풀기는 새 라이브러리 없이 SheetJS 에 들어 있는 CFB(XLSX.CFB — zip 읽기·쓰기 지원)를 씁니다.
 *
 *   xl/workbook.xml (+ _rels)          시트 이름 → 시트 파일
 *   xl/worksheets/_rels/sheetN.xml.rels 시트 → 그림판(drawing)
 *   xl/drawings/drawingN.xml           그림마다 놓인 칸(from/to: 열·행·안쪽 위치) + r:embed
 *   xl/drawings/_rels/drawingN.xml.rels r:embed → xl/media/imageK.png
 *
 * 그림이 두 줄에 걸치면 더 많이 걸친 줄의 사례에 붙입니다(줄 높이는 시트 파일의 ht · 기본 높이).
 * 셀 안에 넣은 그림(엑셀 365 「셀에 배치」, xl/richData)은 아직 위치를 읽지 않고 건수만 알립니다.
 * 표본 파일 만들기용으로 그림을 써 넣는 함수(addImages)와 자리표시 PNG(placeholderPng)도 둡니다(값·그림 모두 지어낸 것).
 * 순수 함수 — 브라우저와 node(테스트·샘플 만들기) 양쪽에서 씁니다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FixXlsxImages = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EMU_PER_PT = 12700;
  var MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };

  function isZip(bytes) { return !!bytes && bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b; }
  /* zip 안 파일 → { 'xl/workbook.xml': Uint8Array, ... } */
  function zipFiles(XLSX, bytes) {
    var z = XLSX.CFB.read(bytes, { type: 'array' }), out = {};
    z.FullPaths.forEach(function (p, i) {
      var e = z.FileIndex[i];
      if (!e || e.type !== 2 || !e.content) return;
      var k = p.replace(/^Root Entry\//, '').replace(/^\//, '');
      if (k.indexOf('\u0001') >= 0) return;
      out[k] = e.content instanceof Uint8Array ? e.content : new Uint8Array(e.content);
    });
    return out;
  }
  function text(u8) {
    if (!u8) return '';
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8);
    return Buffer.from(u8).toString('utf8');
  }
  function unesc(s) { return String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }
  function attr(tag, name) { var m = new RegExp('\\s' + name + '="([^"]*)"').exec(tag); return m ? unesc(m[1]) : ''; }
  /* 관계 파일 → { rId: 대상 경로(zip 안 절대 경로) } */
  function dirOf(p) { return p.replace(/[^/]*$/, ''); }
  function resolve(base, target) {
    if (/^\//.test(target)) return target.slice(1);
    var parts = (dirOf(base) + target).split('/'), out = [];
    parts.forEach(function (x) { if (x === '..') out.pop(); else if (x !== '.' && x !== '') out.push(x); });
    return out.join('/');
  }
  function relsOf(files, part) {
    var relPath = dirOf(part) + '_rels/' + part.replace(/^.*\//, '') + '.rels', xml = text(files[relPath]), out = {};
    (xml.match(/<(?:\w+:)?Relationship\b[^>]*>/g) || []).forEach(function (t) {
      if (attr(t, 'TargetMode') === 'External') return;
      out[attr(t, 'Id')] = { target: resolve(part, attr(t, 'Target')), type: attr(t, 'Type') };
    });
    return out;
  }
  /* 시트 파일의 줄 높이(EMU) — r 은 1부터, 결과 배열은 0부터 */
  function rowHeights(sheetXml) {
    var def = Number(attr((/<(?:\w+:)?sheetFormatPr\b[^>]*>/.exec(sheetXml) || [''])[0], 'defaultRowHeight')) || 15, hs = {};
    (sheetXml.match(/<(?:\w+:)?row\b[^>]*>/g) || []).forEach(function (t) {
      var r = Number(attr(t, 'r')), ht = Number(attr(t, 'ht'));
      if (r && ht) hs[r - 1] = ht;
    });
    return function (row) { return (hs[row] != null ? hs[row] : def) * EMU_PER_PT; };
  }
  function cell(xml, tag) {
    var m = new RegExp('<(?:\\w+:)?' + tag + '>([\\s\\S]*?)</(?:\\w+:)?' + tag + '>').exec(xml);
    if (!m) return null;
    function num(n) { var x = new RegExp('<(?:\\w+:)?' + n + '>\\s*(-?\\d+)\\s*<').exec(m[1]); return x ? Number(x[1]) : 0; }
    return { col: num('col'), colOff: num('colOff'), row: num('row'), rowOff: num('rowOff') };
  }
  /* 그림이 걸친 줄 중 가장 많이 덮은 줄(0부터) */
  function bestRow(from, toRow, toOff, height) {
    if (toRow == null || toRow <= from.row) return from.row;
    var best = from.row, bestCover = -1;
    for (var r = from.row; r <= toRow; r++) {
      var top = r === from.row ? from.rowOff : 0, bottom = r === toRow ? toOff : height(r);
      var cover = Math.max(0, Math.min(bottom, height(r)) - top);
      if (cover > bestCover) { best = r; bestCover = cover; }
    }
    return best;
  }
  /* 한 그림판 → [{ row, col, name, path }] */
  function anchorsOf(files, drawingPath, height) {
    var xml = text(files[drawingPath]).replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
    var rels = relsOf(files, drawingPath), out = [];
    var re = /<(?:\w+:)?(twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/(?:\w+:)?\1>/g, m;
    while ((m = re.exec(xml))) {
      var a = m[0], from = cell(a, 'from');
      if (!from) continue;
      var row = from.row;
      if (m[1] === 'twoCellAnchor') { var to = cell(a, 'to'); if (to) row = bestRow(from, to.row, to.rowOff, height); }
      else {
        // oneCellAnchor: 시작 칸 + 크기(ext cy) — 아래로 줄 높이를 더해 끝나는 줄을 구합니다
        var cy = Number(attr((/<(?:\w+:)?ext\b[^>]*cy="\d+"[^>]*>/.exec(a) || [''])[0], 'cy')) || 0, left = from.rowOff + cy, r = from.row;
        while (left > height(r) && r < from.row + 200) { left -= height(r); r++; }
        row = bestRow(from, r, left, height);
      }
      // 그룹(grpSp) 안 그림 여럿도 같은 줄에. a:blip 의 r:embed 만 봅니다(효과 층 a14:imgLayer 는 그림이 아님)
      var names = a.match(/<(?:\w+:)?cNvPr\b[^>]*>/g) || [], k = 0;
      (a.match(/<a:blip\b[^>]*>/g) || []).forEach(function (b) {
        var id = attr(b, 'r:embed') || attr(b, 'r:link');
        var rel = rels[id];
        if (!rel) return;
        var nm = names[Math.min(k++, names.length - 1)] || '';
        out.push({ row: row, col: from.col, name: attr(nm, 'descr') || attr(nm, 'name'), path: rel.target });
      });
    }
    return out;
  }
  /* 통째로 — { images: [{ sheet, row, col, name, path, type, data }], skipped: [{ sheet, row, path, why }], unplaced: n, inCell: bool } */
  function readImages(XLSX, bytes) {
    var res = { images: [], skipped: [], unplaced: 0, inCell: false };
    if (!isZip(bytes)) return res;
    var files = zipFiles(XLSX, bytes);
    var wbPath = 'xl/workbook.xml', wbXml = text(files[wbPath]), wbRels = relsOf(files, wbPath), used = {};
    (wbXml.match(/<(?:\w+:)?sheet\b[^>]*>/g) || []).forEach(function (t) {
      var name = attr(t, 'name'), rel = wbRels[attr(t, 'r:id')];
      if (!rel || !files[rel.target]) return;
      var sheetXml = text(files[rel.target]), height = rowHeights(sheetXml), srels = relsOf(files, rel.target);
      (sheetXml.match(/<(?:\w+:)?drawing\b[^>]*>/g) || []).forEach(function (d) {
        var dr = srels[attr(d, 'r:id')];
        if (!dr || !files[dr.target]) return;
        anchorsOf(files, dr.target, height).forEach(function (x) {
          var ext = (/\.([a-z0-9]+)$/i.exec(x.path) || ['', ''])[1].toLowerCase();
          used[x.path] = 1;
          if (!files[x.path]) { res.skipped.push({ sheet: name, row: x.row, path: x.path, why: '그림 파일이 없음' }); return; }
          if (!MIME[ext]) { res.skipped.push({ sheet: name, row: x.row, path: x.path, why: '브라우저가 그리지 못하는 형식(' + ext + ')' }); return; }
          res.images.push({ sheet: name, row: x.row, col: x.col, name: x.name, path: x.path, type: MIME[ext], data: files[x.path] });
        });
      });
    });
    Object.keys(files).forEach(function (p) {
      if (/^xl\/richData\//.test(p)) res.inCell = true;
      if (/^xl\/media\//.test(p) && !used[p] && MIME[(/\.([a-z0-9]+)$/i.exec(p) || ['', ''])[1].toLowerCase()]) res.unplaced++;
    });
    return res;
  }
  /* 시트의 그림 → 가져온 사례. offset = 시트 범위의 첫 줄(aoa 0번 줄이 시트의 몇 번째 줄인지), at = applyMapping 이 준 줄 번호들.
     → { byIndex: { 사례 순번: [그림…] }, unmatched: [그림…](머리행·빈 줄·건너뛴 줄 위에 놓인 것) } */
  function imagesForRows(images, sheet, offset, at) {
    var idx = {}, out = { byIndex: {}, unmatched: [] };
    (at || []).forEach(function (r, i) { idx[r + (offset || 0)] = i; });
    (images || []).filter(function (x) { return x.sheet === sheet; }).sort(function (a, b) { return a.row - b.row || a.col - b.col; }).forEach(function (x) {
      var i = idx[x.row];
      if (i == null) { out.unmatched.push(x); return; }
      (out.byIndex[i] = out.byIndex[i] || []).push(x);
    });
    return out;
  }

  /* ── 표본 만들기 — 그림을 써 넣기(SheetJS 가 쓴 .xlsx 에 그림판을 덧붙임) ───────── */
  function enc(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    return new Uint8Array(Buffer.from(s, 'utf8'));
  }
  function xesc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  /* list = [{ row(0부터), col(0부터), png: Uint8Array, name, w, h(EMU 아님 — 픽셀) }] */
  function addImages(XLSX, bytes, sheetName, list) {
    var CFB = XLSX.CFB, z = CFB.read(bytes, { type: 'array' });
    var files = zipFiles(XLSX, bytes);
    var wbXml = text(files['xl/workbook.xml']), wbRels = relsOf(files, 'xl/workbook.xml'), sheetPath = '';
    (wbXml.match(/<(?:\w+:)?sheet\b[^>]*>/g) || []).forEach(function (t) { if (attr(t, 'name') === sheetName) sheetPath = (wbRels[attr(t, 'r:id')] || {}).target; });
    if (!sheetPath) throw new Error('시트를 찾지 못함: ' + sheetName);
    var anchors = list.map(function (x, i) {
      var cx = Math.round((x.w || 320) * 9525 * 0.5), cy = Math.round((x.h || 240) * 9525 * 0.5);
      return '<xdr:oneCellAnchor><xdr:from><xdr:col>' + x.col + '</xdr:col><xdr:colOff>19050</xdr:colOff><xdr:row>' + x.row + '</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:from>' +
        '<xdr:ext cx="' + cx + '" cy="' + cy + '"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="' + (i + 2) + '" name="' + xesc(x.name || ('그림 ' + (i + 1))) + '"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
        '<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId' + (i + 1) + '"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
        '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>';
    }).join('');
    var drawing = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' + anchors + '</xdr:wsDr>';
    var drels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      list.map(function (x, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/sample' + (i + 1) + '.png"/>'; }).join('') + '</Relationships>';
    var sheetFile = sheetPath.replace(/^.*\//, ''), sheetRelPath = dirOf(sheetPath) + '_rels/' + sheetFile + '.rels';
    var srels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDr1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>';
    if (files[sheetRelPath]) throw new Error('시트 관계 파일이 이미 있음(표본 만들기 전용 함수)');
    var sheetXml = text(files[sheetPath]);
    if (!/xmlns:r=/.test(sheetXml)) sheetXml = sheetXml.replace(/<worksheet\b/, '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
    sheetXml = sheetXml.replace(/<\/worksheet>\s*$/, '<drawing r:id="rIdDr1"/></worksheet>');
    var ct = text(files['[Content_Types].xml']);
    if (!/Extension="png"/.test(ct)) ct = ct.replace(/<Types\b[^>]*>/, function (t) { return t + '<Default Extension="png" ContentType="image/png"/>'; });
    ct = ct.replace(/<\/Types>/, '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>');
    function put(p, data) { CFB.utils.cfb_add(z, '/' + p, data); }
    function set(p, data) {
      var i = z.FullPaths.map(function (x) { return x.replace(/^Root Entry\//, ''); }).indexOf(p);
      if (i < 0) put(p, data); else { z.FileIndex[i].content = data; z.FileIndex[i].size = data.length; }
    }
    set(sheetPath, enc(sheetXml));
    set('[Content_Types].xml', enc(ct));
    put(sheetRelPath, enc(srels));
    put('xl/drawings/drawing1.xml', enc(drawing));
    put('xl/drawings/_rels/drawing1.xml.rels', enc(drels));
    list.forEach(function (x, i) { put('xl/media/sample' + (i + 1) + '.png', x.png); });
    var outBytes = CFB.write(z, { fileType: 'zip', type: 'array', compression: true });
    return outBytes instanceof Uint8Array ? outBytes : new Uint8Array(outBytes);
  }

  /* 자리표시 PNG — 무늬만 있는 지어낸 그림(압축 없는 deflate 블록이라 라이브러리가 필요 없음) */
  var CRC = null;
  function crc32(u8) {
    if (!CRC) { CRC = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
    var x = 0xffffffff; for (var i = 0; i < u8.length; i++) x = CRC[(x ^ u8[i]) & 0xff] ^ (x >>> 8);
    return (x ^ 0xffffffff) >>> 0;
  }
  function be32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  function chunk(type, data) {
    var t = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
    var td = new Uint8Array(4 + data.length); td.set(t, 0); td.set(data, 4);
    return [].concat(be32(data.length), Array.prototype.slice.call(td), be32(crc32(td)));
  }
  /* w×h, rgb=[r,g,b], seed 로 줄무늬 각도·굵기가 달라집니다 */
  function placeholderPng(w, h, rgb, seed) {
    seed = seed || 1;
    var raw = new Uint8Array((w * 3 + 1) * h), p = 0, step = 8 + (seed % 5) * 3;
    for (var y = 0; y < h; y++) {
      raw[p++] = 0;
      for (var x = 0; x < w; x++) {
        var band = Math.floor((x + y * (seed % 3 === 0 ? -1 : 1)) / step) % 2 === 0;
        var frame = x < 4 || y < 4 || x >= w - 4 || y >= h - 4;
        var k = frame ? 0.55 : band ? 1 : 0.8;
        raw[p++] = Math.round(rgb[0] * k); raw[p++] = Math.round(rgb[1] * k); raw[p++] = Math.round(rgb[2] * k);
      }
    }
    // zlib: 머리 2바이트 + 저장(무압축) 블록들 + adler32
    var blocks = [0x78, 0x01], a = 1, b = 0;
    for (var i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
    for (var off = 0; off < raw.length; off += 65535) {
      var len = Math.min(65535, raw.length - off), last = off + len >= raw.length ? 1 : 0;
      blocks.push(last, len & 255, len >>> 8, (~len) & 255, ((~len) >>> 8) & 255);
      for (var j = 0; j < len; j++) blocks.push(raw[off + j]);
    }
    blocks = blocks.concat(be32(((b << 16) | a) >>> 0));
    var ihdr = new Uint8Array([].concat(be32(w), be32(h), [8, 2, 0, 0, 0]));
    var png = [137, 80, 78, 71, 13, 10, 26, 10].concat(chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(blocks)), chunk('IEND', new Uint8Array(0)));
    return new Uint8Array(png);
  }

  return { isZip: isZip, zipFiles: zipFiles, readImages: readImages, imagesForRows: imagesForRows, addImages: addImages, placeholderPng: placeholderPng, MIME: MIME };
});
