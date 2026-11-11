// A small spreadsheet formula engine: + - * / ^ & comparisons, cell refs, ranges
// and the most common functions. Anything it does not know throws
// FormulaUnsupported, and the sheet then keeps the value Excel stored.
(function (root) {
  'use strict';

  class FormulaError extends Error { constructor(code) { super(code); this.code = code; } }
  class FormulaUnsupported extends Error {}

  function colToNumber(letters) {
    let n = 0;
    for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
  }
  function numberToCol(n) {
    let s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  function parseCell(ref) {
    const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref);
    return m ? { c: colToNumber(m[1]), r: parseInt(m[2], 10) } : null;
  }

  // ---------------------------------------------------------------- tokens
  function tokenize(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (/\s/.test(ch)) { i++; continue; }
      const rest = src.slice(i);
      let m;
      if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest))) { out.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
      if (ch === '"') {
        let j = i + 1, s = '';
        while (j < src.length) {
          if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; }
          s += src[j++];
        }
        if (j >= src.length) throw new FormulaError('#VALUE!');
        out.push({ t: 'str', v: s }); i = j + 1; continue;
      }
      if ((m = /^'[^']*'!|^[A-Za-z_][A-Za-z0-9_]*!/.exec(rest))) throw new FormulaUnsupported('sheet reference');
      if ((m = /^\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?/.exec(rest)) && src[i + m[0].length] !== '(' && !/[A-Za-z0-9_.]/.test(src[i + m[0].length] || '')) {
        const parts = m[0].split(':');
        const a = parseCell(parts[0]);
        const b = parts[1] ? parseCell(parts[1]) : null;
        out.push(b ? { t: 'range', r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) } : { t: 'ref', r: a.r, c: a.c });
        i += m[0].length; continue;
      }
      if ((m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest))) { out.push({ t: 'id', v: m[0].toUpperCase() }); i += m[0].length; continue; }
      if ((m = /^(<>|<=|>=|[-+*\/^&=<>(),;%])/.exec(rest))) { out.push({ t: 'op', v: m[0] }); i += m[0].length; continue; }
      throw new FormulaUnsupported('character ' + ch);
    }
    return out;
  }

  // ---------------------------------------------------------------- parser
  function parse(tokens) {
    let p = 0;
    const peek = () => tokens[p];
    const isOp = (v) => tokens[p] && tokens[p].t === 'op' && tokens[p].v === v;

    function expr() { return comparison(); }
    function comparison() {
      let a = concat();
      while (tokens[p] && tokens[p].t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(tokens[p].v)) {
        const op = tokens[p++].v; a = { n: 'bin', op, a, b: concat() };
      }
      return a;
    }
    function concat() {
      let a = additive();
      while (isOp('&')) { p++; a = { n: 'bin', op: '&', a, b: additive() }; }
      return a;
    }
    function additive() {
      let a = term();
      while (isOp('+') || isOp('-')) { const op = tokens[p++].v; a = { n: 'bin', op, a, b: term() }; }
      return a;
    }
    function term() {
      let a = power();
      while (isOp('*') || isOp('/')) { const op = tokens[p++].v; a = { n: 'bin', op, a, b: power() }; }
      return a;
    }
    function power() {
      let a = unary();
      while (isOp('^')) { p++; a = { n: 'bin', op: '^', a, b: unary() }; }
      return a;
    }
    function unary() {
      if (isOp('-')) { p++; return { n: 'neg', a: unary() }; }
      if (isOp('+')) { p++; return unary(); }
      return postfix();
    }
    function postfix() {
      let a = primary();
      while (isOp('%')) { p++; a = { n: 'pct', a }; }
      return a;
    }
    function primary() {
      const t = tokens[p++];
      if (!t) throw new FormulaError('#VALUE!');
      if (t.t === 'num') return { n: 'num', v: t.v };
      if (t.t === 'str') return { n: 'str', v: t.v };
      if (t.t === 'ref') return { n: 'ref', r: t.r, c: t.c };
      if (t.t === 'range') return { n: 'range', r1: t.r1, c1: t.c1, r2: t.r2, c2: t.c2 };
      if (t.t === 'op' && t.v === '(') { const e = expr(); if (!isOp(')')) throw new FormulaError('#VALUE!'); p++; return e; }
      if (t.t === 'id') {
        if (t.v === 'TRUE') return { n: 'bool', v: true };
        if (t.v === 'FALSE') return { n: 'bool', v: false };
        if (isOp('(')) {
          p++;
          const args = [];
          if (!isOp(')')) {
            for (;;) {
              args.push(isOp(',') || isOp(';') || isOp(')') ? { n: 'empty' } : expr());
              if (isOp(',') || isOp(';')) { p++; continue; }
              break;
            }
          }
          if (!isOp(')')) throw new FormulaError('#VALUE!');
          p++;
          return { n: 'call', name: t.v, args };
        }
        throw new FormulaError('#NAME?');
      }
      throw new FormulaError('#VALUE!');
    }

    const tree = expr();
    if (p < tokens.length) throw new FormulaError('#VALUE!');
    return tree;
  }

  // ------------------------------------------------------------ evaluation
  const ERR = /^#(?:DIV\/0!|VALUE!|REF!|NAME\?|N\/A|NUM!|NULL!)$/;

  function toNum(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const n = Number(String(v).trim().replace(/%$/, ''));
    if (String(v).trim() === '' || Number.isNaN(n)) throw new FormulaError('#VALUE!');
    return String(v).trim().endsWith('%') ? n / 100 : n;
  }
  const toStr = (v) => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));
  const toBool = (v) => (typeof v === 'string' ? (v.toUpperCase() === 'TRUE' ? true : v.toUpperCase() === 'FALSE' ? false : (() => { throw new FormulaError('#VALUE!'); })()) : !!toNum(v));

  function compare(a, b) {
    const num = (x) => x === null || typeof x === 'number' || typeof x === 'boolean';
    if (num(a) && num(b)) return toNum(a) - toNum(b);
    if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
    return typeof a === 'string' ? 1 : -1; // text sorts after numbers
  }

  // get(r, c) returns a cell's value (number | string | boolean | null) or throws FormulaError.
  function evaluate(formula, get) {
    const tree = parse(tokenize(String(formula).replace(/^=/, '')));

    function rangeValues(node) {
      const out = [];
      if ((node.r2 - node.r1 + 1) * (node.c2 - node.c1 + 1) > 200000) throw new FormulaError('#VALUE!');
      for (let r = node.r1; r <= node.r2; r++) for (let c = node.c1; c <= node.c2; c++) out.push(safeGet(r, c));
      return out;
    }
    function safeGet(r, c) {
      const v = get(r, c);
      if (typeof v === 'string' && ERR.test(v)) throw new FormulaError(v);
      return v === undefined ? null : v;
    }
    // Values for aggregate functions: ranges ignore text/blank, direct args are coerced.
    function numbers(args) {
      const out = [];
      for (const a of args) {
        if (a.n === 'range') { for (const v of rangeValues(a)) if (typeof v === 'number') out.push(v); }
        else if (a.n === 'ref') { const v = safeGet(a.r, a.c); if (typeof v === 'number') out.push(v); }
        else if (a.n !== 'empty') out.push(toNum(ev(a)));
      }
      return out;
    }

    const FUNCS = {
      SUM: (a) => numbers(a).reduce((x, y) => x + y, 0),
      AVERAGE: (a) => { const n = numbers(a); if (!n.length) throw new FormulaError('#DIV/0!'); return n.reduce((x, y) => x + y, 0) / n.length; },
      MIN: (a) => { const n = numbers(a); return n.length ? Math.min(...n) : 0; },
      MAX: (a) => { const n = numbers(a); return n.length ? Math.max(...n) : 0; },
      COUNT: (a) => numbers(a).length,
      COUNTA: (a) => { let k = 0; for (const x of a) { if (x.n === 'range') k += rangeValues(x).filter((v) => v !== null && v !== '').length; else { const v = ev(x); if (v !== null && v !== '') k++; } } return k; },
      ABS: (a) => Math.abs(toNum(ev(a[0]))),
      ROUND: (a) => { const f = Math.pow(10, a[1] ? toNum(ev(a[1])) : 0); const x = toNum(ev(a[0])) * f; return (Math.sign(x) * Math.round(Math.abs(x) + 1e-9)) / f; },
      INT: (a) => Math.floor(toNum(ev(a[0]))),
      SQRT: (a) => { const x = toNum(ev(a[0])); if (x < 0) throw new FormulaError('#NUM!'); return Math.sqrt(x); },
      POWER: (a) => Math.pow(toNum(ev(a[0])), toNum(ev(a[1]))),
      MOD: (a) => { const d = toNum(ev(a[1])); if (d === 0) throw new FormulaError('#DIV/0!'); const n = toNum(ev(a[0])); return n - d * Math.floor(n / d); },
      IF: (a) => (toBool(ev(a[0])) ? (a[1] ? ev(a[1]) : true) : a[2] ? ev(a[2]) : false),
      IFERROR: (a) => { try { return ev(a[0]); } catch (e) { if (e instanceof FormulaError) return ev(a[1]); throw e; } },
      AND: (a) => a.every((x) => toBool(ev(x))),
      OR: (a) => a.some((x) => toBool(ev(x))),
      NOT: (a) => !toBool(ev(a[0])),
      CONCATENATE: (a) => a.map((x) => toStr(ev(x))).join(''),
      CONCAT: (a) => a.map((x) => toStr(ev(x))).join(''),
      UPPER: (a) => toStr(ev(a[0])).toUpperCase(),
      LOWER: (a) => toStr(ev(a[0])).toLowerCase(),
      TRIM: (a) => toStr(ev(a[0])).trim().replace(/\s+/g, ' '),
      LEN: (a) => toStr(ev(a[0])).length,
      LEFT: (a) => toStr(ev(a[0])).slice(0, a[1] ? toNum(ev(a[1])) : 1),
      RIGHT: (a) => { const s = toStr(ev(a[0])); const n = a[1] ? toNum(ev(a[1])) : 1; return n ? s.slice(-n) : ''; },
    };

    function ev(node) {
      switch (node.n) {
        case 'num': case 'str': case 'bool': return node.v;
        case 'empty': return null;
        case 'ref': return safeGet(node.r, node.c);
        case 'range': throw new FormulaError('#VALUE!');
        case 'neg': return -toNum(ev(node.a));
        case 'pct': return toNum(ev(node.a)) / 100;
        case 'bin': {
          const a = ev(node.a);
          const b = ev(node.b);
          switch (node.op) {
            case '+': return toNum(a) + toNum(b);
            case '-': return toNum(a) - toNum(b);
            case '*': return toNum(a) * toNum(b);
            case '/': { const d = toNum(b); if (d === 0) throw new FormulaError('#DIV/0!'); return toNum(a) / d; }
            case '^': return Math.pow(toNum(a), toNum(b));
            case '&': return toStr(a) + toStr(b);
            case '=': return compare(a, b) === 0;
            case '<>': return compare(a, b) !== 0;
            case '<': return compare(a, b) < 0;
            case '>': return compare(a, b) > 0;
            case '<=': return compare(a, b) <= 0;
            case '>=': return compare(a, b) >= 0;
          }
          throw new FormulaUnsupported(node.op);
        }
        case 'call': {
          const fn = FUNCS[node.name];
          if (!fn) throw new FormulaUnsupported(node.name);
          return fn(node.args);
        }
      }
      throw new FormulaError('#VALUE!');
    }

    const result = ev(tree);
    if (typeof result === 'number' && !Number.isFinite(result)) throw new FormulaError('#NUM!');
    return result;
  }

  const api = { evaluate, FormulaError, FormulaUnsupported, colToNumber, numberToCol, parseCell };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZP.formula = api;
})(typeof window !== 'undefined' ? window : globalThis);
