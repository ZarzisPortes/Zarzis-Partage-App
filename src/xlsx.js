'use strict';

// Reads and edits .xlsx / .xlsm files by changing ONLY the cells that were
// edited, directly inside the file. Everything else (styles, charts, images,
// pivot tables, macros, column widths, other sheets...) is left byte-for-byte
// as it was, so editing in the app cannot damage the workbook.

const JSZip = require('jszip');

const MAX_ROWS = 3000;
const MAX_COLS = 100;

// ------------------------------------------------------------------ helpers
function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function escapeXml(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attr(tag, name) {
  const m = new RegExp('(?:^|\\s)' + name.replace(':', '\\:') + '="([^"]*)"').exec(tag);
  return m ? unescapeXml(m[1]) : null;
}

function colToNumber(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function numberToCol(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseRef(ref) {
  const m = /^([A-Za-z]{1,3})(\d+)$/.exec(ref || '');
  return m ? { c: colToNumber(m[1]), r: parseInt(m[2], 10) } : null;
}

async function openZip(buf) {
  try {
    return await JSZip.loadAsync(buf);
  } catch (e) {
    throw new Error('This is not a valid Excel file.');
  }
}

async function text(zip, name) {
  const f = zip.file(name);
  return f ? f.async('string') : null;
}

// ----------------------------------------------------------- workbook parts
async function sheetList(zip) {
  const wb = await text(zip, 'xl/workbook.xml');
  const rels = await text(zip, 'xl/_rels/workbook.xml.rels');
  if (!wb || !rels) throw new Error('This is not a valid Excel file.');

  const relTarget = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*?\/?>/g)) {
    const id = attr(m[0], 'Id');
    let target = attr(m[0], 'Target');
    if (!id || !target) continue;
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    relTarget[id] = target;
  }
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*?\/?>/g)) {
    const state = attr(m[0], 'state');
    const rid = attr(m[0], 'r:id');
    if (state === 'hidden' || state === 'veryHidden' || !rid || !relTarget[rid]) continue;
    sheets.push({ name: attr(m[0], 'name'), path: relTarget[rid] });
  }
  return { sheets, date1904: /<workbookPr\b[^>]*date1904="(1|true)"/.test(wb), workbookXml: wb };
}

async function sharedStrings(zip) {
  const xml = await text(zip, 'xl/sharedStrings.xml');
  const out = [];
  if (!xml) return out;
  for (const m of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    const inner = (m[1] || '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    let s = '';
    for (const t of inner.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) s += unescapeXml(t[1] || '');
    out.push(s);
  }
  return out;
}

const BUILTIN_FORMATS = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%',
  14: 'yyyy-mm-dd', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM',
  20: 'h:mm', 21: 'h:mm:ss', 22: 'yyyy-mm-dd h:mm', 37: '#,##0', 38: '#,##0', 39: '#,##0.00', 40: '#,##0.00',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0',
};

async function styleTable(zip) {
  const xml = await text(zip, 'xl/styles.xml');
  const xfs = [];
  if (!xml) return xfs;

  const formats = {};
  for (const m of xml.matchAll(/<numFmt\b[^>]*?\/?>/g)) {
    const id = attr(m[0], 'numFmtId');
    const code = attr(m[0], 'formatCode');
    if (id != null && code != null) formats[id] = code;
  }

  const fonts = [];
  const fontsXml = (/<fonts\b[\s\S]*?<\/fonts>/.exec(xml) || [''])[0];
  for (const m of fontsXml.matchAll(/<font\b[^>]*?(?:\/>|>([\s\S]*?)<\/font>)/g)) {
    const inner = m[1] || '';
    const bold = /<b\b(?![^>]*val="(?:0|false)")[^>]*\/?>/.test(inner);
    const color = /<color\b[^>]*rgb="([0-9A-Fa-f]{8})"/.exec(inner);
    fonts.push({ b: bold, fg: color ? '#' + color[1].slice(2) : null });
  }
  const fills = [];
  const fillsXml = (/<fills\b[\s\S]*?<\/fills>/.exec(xml) || [''])[0];
  for (const m of fillsXml.matchAll(/<fill\b[^>]*?(?:\/>|>([\s\S]*?)<\/fill>)/g)) {
    const inner = m[1] || '';
    const solid = /patternType="solid"/.test(inner);
    const color = /<fgColor\b[^>]*rgb="([0-9A-Fa-f]{8})"/.exec(inner);
    fills.push(solid && color ? '#' + color[1].slice(2) : null);
  }

  const cellXfs = (/<cellXfs\b[\s\S]*?<\/cellXfs>/.exec(xml) || [''])[0];
  for (const m of cellXfs.matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const tag = m[0].slice(0, m[0].indexOf('>') + 1);
    const fmtId = parseInt(attr(tag, 'numFmtId') || '0', 10);
    const font = fonts[parseInt(attr(tag, 'fontId') || '0', 10)] || {};
    const fill = fills[parseInt(attr(tag, 'fillId') || '0', 10)] || null;
    const code = formats[fmtId] != null ? formats[fmtId] : BUILTIN_FORMATS[fmtId] || 'General';
    xfs.push({ code, b: !!font.b, fg: font.fg || null, bg: fill });
  }
  return xfs;
}

// ---------------------------------------------------------- number display
function isDateFormat(code) {
  if (!code || code === 'General') return false;
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dmyhs]/i.test(stripped) && !/^[#0?,.%\s]*$/.test(stripped);
}

function serialToDate(serial, date1904) {
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(base + Math.round(serial * 86400000));
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatNumber(value, code, date1904) {
  if (!code || code === 'General') return null;
  if (isDateFormat(code)) {
    const d = serialToDate(value, date1904);
    if (isNaN(d)) return null;
    const hasDate = /[dy]/i.test(code.replace(/"[^"]*"/g, ''));
    const hasTime = /h|s/i.test(code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, ''));
    const day = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    const time = pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
    return hasDate && hasTime ? day + ' ' + time : hasTime && !hasDate ? time : day;
  }
  const section = code.split(';')[0];
  const literals = [];
  const bare = section.replace(/"([^"]*)"|\[\$([^\]\-]*)[^\]]*\]|\\(.)/g, (m, q, cur, esc) => {
    literals.push(q != null ? q : cur != null ? cur : esc);
    return '\u0001';
  });
  const percent = bare.includes('%');
  const dec = (/\.([0#?]+)/.exec(bare) || [null, ''])[1].length;
  const grouping = /#,#|0,0|#,0/.test(bare);
  let v = percent ? value * 100 : value;
  let body = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: grouping });
  if (!/[0#?]/.test(bare)) return null;
  const prefix = bare.slice(0, bare.search(/[0#?]/)).replace(/\u0001/g, () => literals.shift() || '');
  const suffix = bare.slice(bare.lastIndexOf(bare.match(/[0#?%]/g).pop()) + 1).replace(/\u0001/g, () => literals.shift() || '');
  return (v < 0 ? '-' : '') + prefix.replace(/[_*].?/g, '') + body + (percent && !suffix.includes('%') ? '%' : '') + suffix.replace(/[_*].?/g, '');
}

// ------------------------------------------------------------------ reading
function readSheet(xml, shared, styles, date1904) {
  const cells = [];
  let maxR = 0;
  let maxC = 0;
  let truncated = false;

  const sheetData = (/<sheetData\b[^>]*?(?:\/>|>([\s\S]*?)<\/sheetData>)/.exec(xml) || [])[1] || '';
  for (const rm of sheetData.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowIdx = parseInt(attr(rm[1], 'r') || '0', 10);
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = parseRef(attr(cm[1], 'r'));
      if (!ref) continue;
      if (ref.r > MAX_ROWS || ref.c > MAX_COLS) { truncated = true; continue; }
      const type = attr(cm[1], 't');
      const styleIdx = parseInt(attr(cm[1], 's') || '0', 10);
      const inner = cm[2] || '';

      const out = {};
      let raw = null;
      const vm = /<v\b[^>]*?>([\s\S]*?)<\/v>/.exec(inner);
      const fm = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner);

      if (type === 's' && vm) raw = shared[parseInt(vm[1], 10)];
      else if (type === 'inlineStr') {
        raw = '';
        for (const t of inner.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) raw += unescapeXml(t[1] || '');
      } else if (type === 'str' && vm) raw = unescapeXml(vm[1]);
      else if (type === 'b' && vm) raw = vm[1].trim() === '1';
      else if (type === 'e' && vm) raw = unescapeXml(vm[1]);
      else if (type === 'd' && vm) raw = unescapeXml(vm[1]);
      else if (vm && vm[1].trim() !== '') {
        const n = Number(vm[1]);
        raw = Number.isFinite(n) ? n : unescapeXml(vm[1]);
      }

      if (fm) {
        const ftype = attr(fm[1], 't');
        const ftext = fm[2] ? unescapeXml(fm[2]) : '';
        if (ftype === 'array' || (ftype === 'shared' && attr(fm[1], 'ref'))) {
          out.ro = 1; // master of a shared / array formula: edit it in Excel
          if (ftext) out.f = ftext;
        } else if (ftext) {
          out.f = ftext;
        }
      }

      const st = styles[styleIdx];
      if (typeof raw === 'number' && st) {
        const d = formatNumber(raw, st.code, date1904);
        if (d != null) out.d = d;
        if (isDateFormat(st.code)) out.dt = 1;
      }
      if (st) {
        const s = {};
        if (st.b) s.b = 1;
        if (st.fg && st.fg !== '#000000') s.fg = st.fg;
        if (st.bg) s.bg = st.bg;
        if (Object.keys(s).length) out.s = s;
      }
      if (raw === null && !out.f && !out.s) continue;
      out.v = raw;
      cells.push([ref.r, ref.c, out]);
      if (raw !== null || out.f) { maxR = Math.max(maxR, ref.r); maxC = Math.max(maxC, ref.c); }
    }
    if (rowIdx > MAX_ROWS) truncated = true;
  }

  const colWidths = {};
  for (const cm of xml.matchAll(/<col\b[^>]*?\/?>/g)) {
    const min = parseInt(attr(cm[0], 'min') || '0', 10);
    const max = Math.min(parseInt(attr(cm[0], 'max') || '0', 10), MAX_COLS);
    const w = parseFloat(attr(cm[0], 'width') || '0');
    if (min && w) for (let c = min; c <= max; c++) colWidths[c] = w;
  }
  return { cells, rows: maxR, cols: maxC, colWidths, truncated };
}

async function readWorkbook(buf) {
  const zip = await openZip(buf);
  const { sheets, date1904 } = await sheetList(zip);
  const shared = await sharedStrings(zip);
  const styles = await styleTable(zip);
  const out = [];
  for (const s of sheets) {
    const xml = (await text(zip, s.path)) || '';
    out.push(Object.assign({ name: s.name }, readSheet(xml, shared, styles, date1904)));
  }
  return { sheets: out, date1904 };
}

// ------------------------------------------------------------------ editing
function cellXml(ref, styleAttr, change) {
  const s = styleAttr ? ' s="' + styleAttr + '"' : '';
  const v = change.v;
  const f = change.f ? String(change.f).replace(/^=/, '') : null;

  if (f) {
    let t = '';
    let val = '';
    if (typeof v === 'number' && Number.isFinite(v)) val = '<v>' + v + '</v>';
    else if (typeof v === 'boolean') { t = ' t="b"'; val = '<v>' + (v ? 1 : 0) + '</v>'; }
    else if (typeof v === 'string' && /^#[A-Z0-9/!?]+$/.test(v)) { t = ' t="e"'; val = '<v>' + escapeXml(v) + '</v>'; }
    else if (typeof v === 'string') { t = ' t="str"'; val = '<v>' + escapeXml(v) + '</v>'; }
    return '<c r="' + ref + '"' + s + t + '><f>' + escapeXml(f) + '</f>' + val + '</c>';
  }
  if (v === null || v === undefined || v === '') return '<c r="' + ref + '"' + s + '/>';
  if (typeof v === 'number' && Number.isFinite(v)) return '<c r="' + ref + '"' + s + '><v>' + v + '</v></c>';
  if (typeof v === 'boolean') return '<c r="' + ref + '"' + s + ' t="b"><v>' + (v ? 1 : 0) + '</v></c>';
  return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + escapeXml(v) + '</t></is></c>';
}

function parseRows(sheetData) {
  const rows = [];
  let implicit = 0;
  for (const rm of sheetData.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    implicit += 1;
    const r = parseInt(attr(rm[1], 'r') || String(implicit), 10);
    implicit = r;
    const cells = [];
    let implicitCol = 0;
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = parseRef(attr(cm[1], 'r'));
      implicitCol = ref ? ref.c : implicitCol + 1;
      cells.push({ c: implicitCol, xml: cm[0], attrs: cm[1] });
    }
    rows.push({ r, attrs: rm[1].replace(/\/$/, ''), cells });
  }
  return rows;
}

function patchSheetXml(xml, changes, skipped) {
  const sm = /<sheetData\b[^>]*?(?:\/>|>([\s\S]*?)<\/sheetData>)/.exec(xml);
  if (!sm) throw new Error('Sheet has no data section.');
  const rows = parseRows(sm[1] || '');

  for (const ch of changes) {
    const ref = numberToCol(ch.c) + ch.r;
    let row = rows.find((x) => x.r === ch.r);
    if (!row) {
      row = { r: ch.r, attrs: ' r="' + ch.r + '"', cells: [] };
      const at = rows.findIndex((x) => x.r > ch.r);
      if (at < 0) rows.push(row); else rows.splice(at, 0, row);
    }
    const existing = row.cells.find((x) => x.c === ch.c);
    if (existing && /<f\b[^>]*(?:t="array"|ref=")/.test(existing.xml)) {
      skipped.push(ref);
      continue;
    }
    const styleAttr = existing ? attr(existing.attrs, 's') : null;
    const fresh = { c: ch.c, xml: cellXml(ref, styleAttr, ch), attrs: '' };
    if (existing) Object.assign(existing, fresh);
    else {
      const at = row.cells.findIndex((x) => x.c > ch.c);
      if (at < 0) row.cells.push(fresh); else row.cells.splice(at, 0, fresh);
    }
    row.attrs = row.attrs.replace(/\sspans="[^"]*"/, '');
  }

  const rebuilt = rows
    .map((row) => (row.cells.length ? '<row' + row.attrs + '>' + row.cells.map((c) => c.xml).join('') + '</row>' : '<row' + row.attrs + '/>'))
    .join('');
  let out = xml.slice(0, sm.index) + '<sheetData>' + rebuilt + '</sheetData>' + xml.slice(sm.index + sm[0].length);
  out = out.replace(/<dimension\b[^>]*?\/>/, ''); // optional element; Excel recalculates it
  return out;
}

// changes: [{ sheet: 'Sheet1', r: 1, c: 1, v: any, f?: 'SUM(A1:A3)' }]
async function applyChanges(buf, changes) {
  const zip = await openZip(buf);
  const { sheets, workbookXml } = await sheetList(zip);
  const skipped = [];

  const bySheet = new Map();
  for (const ch of changes) {
    const sheet = sheets.find((s) => s.name === ch.sheet);
    if (!sheet) throw new Error('Sheet “' + ch.sheet + '” no longer exists.');
    if (!bySheet.has(sheet.path)) bySheet.set(sheet.path, []);
    bySheet.get(sheet.path).push(ch);
  }
  for (const [path, list] of bySheet) {
    const xml = await text(zip, path);
    zip.file(path, patchSheetXml(xml, list, skipped));
  }

  // Ask Excel to recalculate formulas the next time the file is opened, and
  // drop the calculation chain (Excel rebuilds it) so it can never be stale.
  if (/<calcPr\b/.test(workbookXml)) {
    zip.file('xl/workbook.xml', workbookXml.replace(/<calcPr\b([^>]*?)(\/?)>/, (m, a, slash) => (/fullCalcOnLoad=/.test(a) ? m : '<calcPr' + a + ' fullCalcOnLoad="1"' + slash + '>')));
  }
  if (zip.file('xl/calcChain.xml')) {
    zip.remove('xl/calcChain.xml');
    const ct = await text(zip, '[Content_Types].xml');
    if (ct) zip.file('[Content_Types].xml', ct.replace(/<Override\b[^>]*calcChain[^>]*?\/>/, ''));
    const rels = await text(zip, 'xl/_rels/workbook.xml.rels');
    if (rels) zip.file('xl/_rels/workbook.xml.rels', rels.replace(/<Relationship\b[^>]*calcChain[^>]*?\/>/, ''));
  }

  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer: out, skipped };
}


// Adds a new, empty sheet at the end of the workbook. Everything else in the
// file (other sheets, charts, macros, styles) is left exactly as it was.
async function addSheet(buf, rawName) {
  const zip = await openZip(buf);
  const wb = await text(zip, 'xl/workbook.xml');
  const rels = await text(zip, 'xl/_rels/workbook.xml.rels');
  const ct = await text(zip, '[Content_Types].xml');
  if (!wb || !rels || !ct || !/<\/sheets>/.test(wb)) throw new Error('This is not a valid Excel file.');

  const existing = [];
  let maxId = 0;
  for (const m of wb.matchAll(/<sheet\b[^>]*?\/?>/g)) {
    existing.push(unescapeXml(attr(m[0], 'name') || '').toLowerCase());
    maxId = Math.max(maxId, parseInt(attr(m[0], 'sheetId'), 10) || 0);
  }
  let name = String(rawName == null ? '' : rawName).replace(/\s+/g, ' ').trim();
  if (!name) {
    let n = existing.length + 1;
    while (existing.includes('sheet' + n)) n++;
    name = 'Sheet' + n;
  }
  if (name.length > 31) throw new Error('Sheet names can have at most 31 characters.');
  if (/[\[\]:*?\/\\]/.test(name)) throw new Error('Sheet names cannot contain  [ ] : * ? / \\');
  if (/^'|'$/.test(name)) throw new Error('Sheet names cannot start or end with an apostrophe.');
  if (existing.includes(name.toLowerCase())) throw new Error('There is already a sheet called “' + name + '”.');

  let rid = 1;
  while (new RegExp('Id="rId' + rid + '"').test(rels)) rid++;
  rid = 'rId' + rid;
  let num = 1;
  while (zip.file('xl/worksheets/sheet' + num + '.xml')) num++;
  const part = 'xl/worksheets/sheet' + num + '.xml';

  zip.file(part, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>');
  zip.file('xl/workbook.xml', wb.replace(/<\/sheets>/, '<sheet name="' + escapeXml(name) + '" sheetId="' + (maxId + 1) + '" r:id="' + rid + '"/></sheets>'));
  zip.file(
    'xl/_rels/workbook.xml.rels',
    rels.replace(/<\/Relationships>/, '<Relationship Id="' + rid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + num + '.xml"/></Relationships>')
  );
  zip.file('[Content_Types].xml', ct.replace(/<\/Types>/, '<Override PartName="/' + part + '" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'));

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, name };
}

// A brand-new workbook with three empty sheets.
async function blankWorkbook() {
  const zip = new JSZip();
  const names = ['Sheet1', 'Sheet2', 'Sheet3'];
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      names.map((n, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
  );
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      names.map((n, i) => '<sheet name="' + n + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') +
      '</sheets><calcPr calcId="191029"/></workbook>'
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      names.map((n, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
      '<Relationship Id="rId' + (names.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
  );
  zip.file(
    'xl/styles.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
  );
  names.forEach((n, i) =>
    zip.file('xl/worksheets/sheet' + (i + 1) + '.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>')
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { readWorkbook, applyChanges, addSheet, blankWorkbook, numberToCol, colToNumber, formatNumber };
