'use strict';

// Text editing for .docx / .docm files.
//
// The document is changed paragraph by paragraph directly inside the file:
// only paragraphs whose text was edited (or added / removed) are touched.
// Pictures, tables, headers, footers, page layout, styles and everything else
// stay exactly as they were. Paragraphs that contain things we cannot safely
// rewrite (pictures, links, fields, tracked changes, page breaks, ...) are
// shown read-only.

const JSZip = require('jszip');

const DOC_PATH = 'word/document.xml';
const W_PARAGRAPH_LOCK =
  /<w:(?:drawing|pict|object|fld\w*|hyperlink|sdt|ins|del|moveFrom|moveTo|footnoteReference|endnoteReference|commentReference|sym|ptab|pPrChange|rPrChange|smartTag|customXml|subDoc|dir|bdo)\b|<mc:AlternateContent|<w:br\b[^>]*w:type="(?:page|column)"/;

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
    .replace(/>/g, '&gt;');
}

async function openDoc(buf) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (e) {
    throw new Error('This is not a valid Word file.');
  }
  const f = zip.file(DOC_PATH);
  if (!f) throw new Error('This is not a valid Word file.');
  return { zip, xml: await f.async('string') };
}

// Finds every editable paragraph (document order). Paragraphs inside text
// boxes are ignored completely so indexes stay stable between read and save.
function scan(xml) {
  const tokens = /<(\/?)(w:p|w:tbl|w:tc|w:body|w:txbxContent|w:sdtContent|mc:AlternateContent)\b[^>]*?(\/?)>/g;
  const stack = [];
  const paras = [];
  let m;
  while ((m = tokens.exec(xml))) {
    const closing = m[1] === '/';
    const type = m[2];
    const selfClose = m[3] === '/';
    const hidden = () => stack.some((s) => s.type === 'w:txbxContent' || s.type === 'mc:AlternateContent');

    if (type === 'w:p' && selfClose) {
      if (!hidden()) paras.push({ start: m.index, end: m.index + m[0].length, openEnd: m.index + m[0].length, parent: stack.length ? stack[stack.length - 1].type : '', empty: true });
      continue;
    }
    if (selfClose) continue;
    if (!closing) {
      stack.push({ type, start: m.index, openEnd: m.index + m[0].length, parent: stack.length ? stack[stack.length - 1].type : '' });
    } else {
      const top = stack.pop();
      if (top && type === 'w:p' && !stack.some((s) => s.type === 'w:txbxContent' || s.type === 'mc:AlternateContent')) {
        paras.push({ start: top.start, end: m.index + m[0].length, openEnd: top.openEnd, parent: top.parent, empty: false, closeStart: m.index });
      }
    }
  }
  paras.sort((a, b) => a.start - b.start);
  return paras;
}

function describe(xml, p) {
  const inner = p.empty ? '' : xml.slice(p.openEnd, p.closeStart);
  const pPr = (/^\s*(<w:pPr\b[\s\S]*?<\/w:pPr>|<w:pPr\s*\/>)/.exec(inner) || [''])[0];
  const rest = inner.slice(pPr.length);
  const style = (/<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(pPr) || [null, ''])[1];

  let text = '';
  for (const t of rest.matchAll(/<w:t\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:t>)|<w:tab\s*\/>|<w:br\b[^>]*\/>|<w:cr\s*\/>|<w:noBreakHyphen\s*\/>/g)) {
    if (t[0].startsWith('<w:t ') || t[0].startsWith('<w:t>') || t[0].startsWith('<w:t/')) text += unescapeXml(t[1] || '');
    else if (t[0].startsWith('<w:tab')) text += '\t';
    else if (t[0].startsWith('<w:noBreak')) text += '-';
    else text += '\n';
  }
  const hasSect = /<w:sectPr\b/.test(pPr);
  const locked = W_PARAGRAPH_LOCK.test(inner);
  const topLevel = p.parent === 'w:body';
  return { inner, pPr, rest, style, text, hasSect, locked, topLevel, inTable: p.parent === 'w:tc' };
}

async function readParagraphs(buf) {
  const { xml } = await openDoc(buf);
  const paras = scan(xml);
  return paras.map((p, i) => {
    const d = describe(xml, p);
    return { i, text: d.text, style: d.style, locked: d.locked, tl: d.topLevel && !d.hasSect, inTable: d.inTable };
  });
}

function runXml(text, rPr) {
  const parts = String(text).split(/(\t|\r\n|\n|\r)/);
  let body = '';
  for (const part of parts) {
    if (part === '') continue;
    if (part === '\t') body += '<w:tab/>';
    else if (part === '\n' || part === '\r' || part === '\r\n') body += '<w:br/>';
    else body += '<w:t xml:space="preserve">' + escapeXml(part) + '</w:t>';
  }
  return body ? '<w:r>' + rPr + body + '</w:r>' : '';
}

function firstRunProps(rest) {
  const m = /<w:r\b[^>]*>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/.exec(rest);
  return m ? m[1] : '';
}

function newParagraphXml(templatePPr, rPr, text) {
  let pPr = templatePPr.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, '').replace(/<w:pStyle\b[^>]*w:val="(?:Heading|Title|Subtitle)[^"]*"[^>]*\/>/i, '');
  if (/^<w:pPr>\s*<\/w:pPr>$/.test(pPr)) pPr = '';
  return '<w:p>' + pPr + runXml(text, rPr) + '</w:p>';
}

// items: the whole paragraph list as the person left it:
//   { i: <original index> | null (new paragraph), text }
// Original paragraphs missing from the list are deleted.
async function applyItems(buf, items) {
  const { zip, xml } = await openDoc(buf);
  const paras = scan(xml);
  const info = paras.map((p) => describe(xml, p));
  const keep = new Map();
  for (const it of items) {
    if (Number.isInteger(it.i)) {
      if (it.i < 0 || it.i >= paras.length) throw new Error('The document changed. Please reload it.');
      if (keep.has(it.i)) throw new Error('Duplicate paragraph.');
      keep.set(it.i, it);
    }
  }

  const edits = []; // { start, end, text }

  paras.forEach((p, i) => {
    const d = info[i];
    const it = keep.get(i);
    if (!it) {
      if (!d.topLevel || d.hasSect || d.locked) throw new Error('A paragraph that cannot be deleted was removed.');
      edits.push({ start: p.start, end: p.end, text: '' });
      return;
    }
    const newText = String(it.text == null ? '' : it.text).replace(/\r\n?/g, '\n');
    if (newText === d.text) return;
    if (d.locked) throw new Error('A protected paragraph was changed (it contains pictures, links or fields).');

    const bookmarks = (d.rest.match(/<w:bookmark(?:Start|End)\b[^>]*\/>/g) || []).join('');
    const open = xml.slice(p.start, p.openEnd).replace(/\/>$/, '>');
    const replacement = open + d.pPr + bookmarks + runXml(newText, firstRunProps(d.rest)) + '</w:p>';
    edits.push({ start: p.start, end: p.end, text: replacement });
  });

  // New paragraphs go right after the previous surviving paragraph.
  let prev = null;
  const pendingBefore = []; // new paragraphs that come before any original one
  const afterMap = new Map();
  for (const it of items) {
    if (Number.isInteger(it.i)) {
      prev = it.i;
      continue;
    }
    const text = String(it.text == null ? '' : it.text);
    if (prev === null) pendingBefore.push(text);
    else {
      if (!afterMap.has(prev)) afterMap.set(prev, []);
      afterMap.get(prev).push(text);
    }
  }
  for (const [i, texts] of afterMap) {
    const d = info[i];
    if (!d.topLevel || d.hasSect) throw new Error('New paragraphs can only be added to the main text, not inside tables.');
    const xmlNew = texts.map((t) => newParagraphXml(d.pPr, firstRunProps(d.rest), t)).join('');
    edits.push({ start: paras[i].end, end: paras[i].end, text: xmlNew, insert: true });
  }
  if (pendingBefore.length) {
    const firstKept = items.find((it) => Number.isInteger(it.i));
    if (!firstKept) throw new Error('A document needs at least one existing paragraph.');
    const d = info[firstKept.i];
    if (!d.topLevel) throw new Error('New paragraphs can only be added to the main text, not inside tables.');
    const xmlNew = pendingBefore.map((t) => newParagraphXml(d.pPr, firstRunProps(d.rest), t)).join('');
    edits.push({ start: paras[firstKept.i].start, end: paras[firstKept.i].start, text: xmlNew, insert: true });
  }

  // Apply from the end so earlier positions stay valid. At the same position the
  // replacement of an existing paragraph is applied first, then the insertion
  // lands in front of it.
  edits.sort((a, b) => b.start - a.start || (a.insert ? 1 : -1) - (b.insert ? 1 : -1));
  let out = xml;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  zip.file(DOC_PATH, out);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function blankDocument() {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  zip.file(
    DOC_PATH,
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>'
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { readParagraphs, applyItems, blankDocument };
