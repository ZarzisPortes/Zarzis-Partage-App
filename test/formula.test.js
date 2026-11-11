'use strict';
const assert = require('assert');
const F = require('../public/js/formula.js');

// A1=10, A2=20, A3=30, B1="x", B2=true, C1 = blank
const data = { '1,1': 10, '2,1': 20, '3,1': 30, '1,2': 'x', '2,2': true, '1,4': '#DIV/0!' };
const get = (r, c) => (data[r + ',' + c] === undefined ? null : data[r + ',' + c]);
const ev = (f) => F.evaluate(f, get);

assert.strictEqual(ev('=SUM(A1:A3)'), 60);
assert.strictEqual(ev('SUM(A1:A3, 5)'), 65);
assert.strictEqual(ev('=AVERAGE(A1:A3)'), 20);
assert.strictEqual(ev('=MAX(A1:A3)-MIN(A1:A3)'), 20);
assert.strictEqual(ev('=A1*A2+A3'), 230);
assert.strictEqual(ev('=-2^2'), 4, 'Excel: unary minus binds tighter than ^');
assert.strictEqual(ev('=2+3*4'), 14);
assert.strictEqual(ev('=(2+3)*4'), 20);
assert.strictEqual(ev('=50%'), 0.5);
assert.strictEqual(ev('=A1/4'), 2.5);
assert.strictEqual(ev('=ROUND(2.345,2)'), 2.35);
assert.strictEqual(ev('=ROUND(-2.5)'), -3);
assert.strictEqual(ev('=B1&" and "&A1'), 'x and 10');
assert.strictEqual(ev('=IF(A1>5,"big","small")'), 'big');
assert.strictEqual(ev('=IF(A1=0,0,A2/A1)'), 2);
assert.strictEqual(ev('=IF(C1=0,0,A2/C1)'), 0, 'unused branch is not evaluated');
assert.strictEqual(ev('=IFERROR(A1/C1,"n/a")'), 'n/a');
assert.strictEqual(ev('=COUNT(A1:B3)'), 3);
assert.strictEqual(ev('=COUNTA(A1:B3)'), 5);
assert.strictEqual(ev('=AND(A1>1,A2>1)'), true);
assert.strictEqual(ev('=UPPER("abc")&LEN("hello")'), 'ABC5');
assert.strictEqual(ev('=$A$1+A$2'), 30);
assert.strictEqual(ev('=SUM(A1:A3)+SUM(A1:A3)'), 120);
assert.strictEqual(ev('=1.5E2'), 150);
assert.strictEqual(ev('="He said ""hi"""'), 'He said "hi"');
assert.strictEqual(ev('=A1=10'), true);
assert.strictEqual(ev('=B1="X"'), true, 'text compare ignores case');

const code = (f) => { try { ev(f); return 'no error'; } catch (e) { return e.code || 'unsupported:' + e.constructor.name; } };
assert.strictEqual(code('=1/0'), '#DIV/0!');
assert.strictEqual(code('=D1+1'), '#DIV/0!', 'error in a referenced cell propagates');
assert.strictEqual(code('=B1+1'), '#VALUE!');
assert.strictEqual(code('=FOO'), '#NAME?');
assert.strictEqual(code('=SUM(A1,'), '#VALUE!');
assert.strictEqual(code('=SUM(A1:'), 'unsupported:FormulaUnsupported');
assert.strictEqual(code('=VLOOKUP(1,A1:B3,2,0)'), 'unsupported:FormulaUnsupported');
assert.strictEqual(code("=Sheet2!A1+1"), 'unsupported:FormulaUnsupported');
assert.strictEqual(F.numberToCol(28), 'AB');
assert.strictEqual(F.colToNumber('AB'), 28);
console.log('Formula tests passed.');
