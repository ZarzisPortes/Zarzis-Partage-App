'use strict';
// Excel and Word editing modules, tested on files they generate themselves.
const assert = require('assert');
const X = require('../src/xlsx');
const D = require('../src/docx');

(async () => {
  // ---- Excel
  const blank = await X.blankWorkbook();
  let wb = await X.readWorkbook(blank);
  assert.deepStrictEqual(wb.sheets.map((s) => s.name), ['Sheet1', 'Sheet2', 'Sheet3']);

  const edited = await X.applyChanges(blank, [
    { sheet: 'Sheet1', r: 1, c: 1, v: 'Item & <Co>' },
    { sheet: 'Sheet1', r: 2, c: 1, v: 7 },
    { sheet: 'Sheet1', r: 3, c: 1, v: 14, f: 'A2*2' },
    { sheet: 'Sheet1', r: 3, c: 3, v: '  padded  ' },
    { sheet: 'Sheet3', r: 10, c: 2, v: true },
  ]);
  wb = await X.readWorkbook(edited.buffer);
  const get = (s, r, c) => (wb.sheets[s].cells.find((x) => x[0] === r && x[1] === c) || [])[2];
  assert.strictEqual(get(0, 1, 1).v, 'Item & <Co>');
  assert.strictEqual(get(0, 2, 1).v, 7);
  assert.strictEqual(get(0, 3, 1).f, 'A2*2');
  assert.strictEqual(get(0, 3, 1).v, 14);
  assert.strictEqual(get(0, 3, 3).v, '  padded  ');
  assert.strictEqual(get(2, 10, 2).v, true);

  // two people editing different cells one after the other: both survive
  const second = await X.applyChanges(edited.buffer, [{ sheet: 'Sheet1', r: 2, c: 2, v: 'second person' }]);
  wb = await X.readWorkbook(second.buffer);
  assert.strictEqual(get(0, 2, 2).v, 'second person');
  assert.strictEqual(get(0, 2, 1).v, 7, 'first person\'s cell is kept');

  // clearing a cell
  wb = await X.readWorkbook((await X.applyChanges(second.buffer, [{ sheet: 'Sheet1', r: 2, c: 1, v: null }])).buffer);
  assert.ok(!get(0, 2, 1) || get(0, 2, 1).v === null);
  await assert.rejects(() => X.applyChanges(blank, [{ sheet: 'Nope', r: 1, c: 1, v: 1 }]), /no longer exists/);
  await assert.rejects(() => X.readWorkbook(Buffer.from('not a zip')), /not a valid Excel/);

  // number formats
  assert.strictEqual(X.formatNumber(1234.5, '#,##0.00'), '1,234.50');
  assert.strictEqual(X.formatNumber(0.256, '0.0%'), '25.6%');
  assert.strictEqual(X.formatNumber(46328, 'yyyy-mm-dd'), '2026-11-02');
  assert.strictEqual(X.formatNumber(5, '0'), '5');

  // ---- Word
  const doc = await D.blankDocument();
  let ps = await D.readParagraphs(doc);
  assert.strictEqual(ps.length, 1);
  let out = await D.applyItems(doc, [{ i: 0, text: 'First' }, { i: null, text: 'Second & <third>' }, { i: null, text: 'Tab\there\nnew line' }]);
  ps = await D.readParagraphs(out);
  assert.deepStrictEqual(ps.map((p) => p.text), ['First', 'Second & <third>', 'Tab\there\nnew line']);

  // edit next to an insertion (regression: used to corrupt the file)
  out = await D.applyItems(out, [
    { i: 0, text: 'First' }, { i: null, text: 'Inserted' }, { i: 1, text: 'Second CHANGED' }, { i: 2, text: 'Tab\there\nnew line' },
  ]);
  ps = await D.readParagraphs(out);
  assert.deepStrictEqual(ps.map((p) => p.text), ['First', 'Inserted', 'Second CHANGED', 'Tab\there\nnew line']);

  // delete + insert at the very start
  out = await D.applyItems(out, [{ i: null, text: 'Top' }, { i: 0, text: 'First' }, { i: 3, text: 'Tab\there\nnew line' }]);
  ps = await D.readParagraphs(out);
  assert.deepStrictEqual(ps.map((p) => p.text), ['Top', 'First', 'Tab\there\nnew line']);
  await assert.rejects(() => D.applyItems(out, [{ i: 99, text: 'x' }]), /changed/);
  await assert.rejects(() => D.readParagraphs(Buffer.from('nope')), /not a valid Word/);

  // untouched text leaves the file content identical
  const same = await D.applyItems(out, ps.map((p) => ({ i: p.i, text: p.text })));
  assert.deepStrictEqual((await D.readParagraphs(same)).map((p) => p.text), ps.map((p) => p.text));
  // ---- adding a sheet keeps the rest of the workbook intact
  {
    const base = await X.blankWorkbook();
    const edited = (await X.applyChanges(base, [{ sheet: 'Sheet1', r: 1, c: 1, v: 'keep me', f: null }])).buffer;
    const added = await X.addSheet(edited, 'Q2 & Q3');
    assert.strictEqual(added.name, 'Q2 & Q3');
    const w2 = await X.readWorkbook(added.buffer);
    assert.deepStrictEqual(w2.sheets.map((s) => s.name), ['Sheet1', 'Sheet2', 'Sheet3', 'Q2 & Q3']);
    assert.ok(w2.sheets[0].cells.some((c) => c[2].v === 'keep me'));
    assert.strictEqual((await X.addSheet(added.buffer, '')).name, 'Sheet5'); // default name skips taken ones
    for (const bad of ['q2 & q3', 'a/b', 'x'.repeat(32), "'quoted'"]) {
      await assert.rejects(() => X.addSheet(added.buffer, bad), undefined, 'rejects ' + bad);
    }
  }

  console.log('Excel and Word module tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
