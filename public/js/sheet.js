// Spreadsheet editor (.xlsx / .xlsm). Several people can edit at the same time:
// only the cells you change are sent, and they are written into the current
// file on the server, so other people's cells are never overwritten.
(() => {
  'use strict';
  const { h, api } = ZP;
  const F = ZP.formula;

  const ROW_H = 26;
  const DEFAULT_COL_PX = 96;
  const key = (r, c) => r * 20000 + c;

  function fmtNum(n) {
    if (!Number.isFinite(n)) return String(n);
    return String(Math.round(n * 1e10) / 1e10);
  }

  // Turns what the person typed into a value (number, true/false, text or empty).
  function parseTyped(text, cell) {
    const t = text.trim();
    if (t === '') return null;
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
    if (/^[+-]?(\d+\.?\d*|\.\d+)%$/.test(t)) return Number(t.slice(0, -1)) / 100;
    if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    if (d && cell && cell.dt) return Math.round((Date.UTC(+d[1], +d[2] - 1, +d[3]) - Date.UTC(1899, 11, 30)) / 86400000);
    return text;
  }

  ZP.editors.sheet = {
    mount(body, data, host) {
      let version = data.version;
      let knownVersion = data.version;
      const editable = host.editable;
      const pending = new Map(); // "sheet|r|c" -> change
      let saving = false;
      let saveTimer = null;
      let needsRefresh = false;
      let destroyed = false;

      // ---- model
      function buildSheets(workbook) {
        return workbook.sheets.map((s) => {
          const cells = new Map();
          for (const [r, c, o] of s.cells) cells.set(key(r, c), Object.assign({ v0: o.v }, o));
          return { name: s.name, cells, rows: s.rows, cols: s.cols, widths: s.colWidths || {}, truncated: s.truncated, cv: new Map() };
        });
      }
      let sheets = buildSheets(data.workbook);
      let active = 0;
      let sel = { r: 1, c: 1 };
      let editing = null;

      // ---- formulas
      function recalc(sh) {
        sh.cv = new Map();
        const visiting = new Set();
        const valueOf = (r, c) => {
          const k = key(r, c);
          const cell = sh.cells.get(k);
          if (!cell) return null;
          if (!cell.f || cell.ro) return cell.v === undefined ? null : cell.v;
          if (sh.cv.has(k)) {
            const x = sh.cv.get(k);
            if (x && x.err) throw new F.FormulaError(x.err);
            if (x && x.unsupported) return cell.v === undefined ? null : cell.v;
            return x;
          }
          if (visiting.has(k)) throw new F.FormulaError('#REF!');
          visiting.add(k);
          try {
            const val = F.evaluate(cell.f, valueOf);
            sh.cv.set(k, val);
            return val;
          } catch (e) {
            if (e instanceof F.FormulaUnsupported) { sh.cv.set(k, { unsupported: true }); return cell.v === undefined ? null : cell.v; }
            if (e instanceof F.FormulaError) { sh.cv.set(k, { err: e.code }); throw e; }
            throw e;
          } finally {
            visiting.delete(k);
          }
        };
        for (const [k, cell] of sh.cells) {
          if (cell.f && !cell.ro && !sh.cv.has(k)) {
            const r = Math.floor(k / 20000), c = k % 20000;
            try { valueOf(r, c); } catch (_) { /* stored as an error value */ }
          }
        }
      }
      function value(sh, cell, k) {
        if (!cell) return null;
        if (cell.f && !cell.ro && sh.cv.has(k)) {
          const x = sh.cv.get(k);
          if (x && x.err) return x.err;
          if (x && x.unsupported) return cell.v === undefined ? null : cell.v;
          return x;
        }
        return cell.v === undefined ? null : cell.v;
      }
      function display(sh, r, c) {
        const k = key(r, c);
        const cell = sh.cells.get(k);
        if (!cell) return { text: '', cls: '' };
        const v = value(sh, cell, k);
        if (cell.f && sh.cv.get(k) && sh.cv.get(k).unsupported && (cell.v === null || cell.v === undefined)) return { text: '=' + cell.f, cls: 'fx' };
        if (v === null) return { text: '', cls: '' };
        if (typeof v === 'number') return { text: cell.d != null && v === cell.v0 ? cell.d : fmtNum(v), cls: 'num' };
        if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', cls: 'bool' };
        if (/^#[A-Z0-9/!?]+$/.test(v)) return { text: v, cls: 'err' };
        return { text: String(v), cls: '' };
      }
      sheets.forEach(recalc);

      // ---- layout
      const nameBox = h('div', { class: 'sh-name' }, 'A1');
      const fxBar = h('div', { class: 'sh-fx' });
      const table = h('table', { class: 'grid' });
      const scroll = h('div', { class: 'grid-scroll', tabindex: '0' }, table);
      const tabs = h('div', { class: 'sh-tabs' });
      const warn = h('div', { class: 'sh-warn hidden' });
      body.replaceChildren(h('div', { class: 'sheet' }, h('div', { class: 'sh-bar' }, nameBox, h('span', { class: 'fx-label', text: 'fx' }), fxBar), warn, scroll, tabs));

      const cur = () => sheets[active];
      const totalRows = () => Math.min(Math.max(cur().rows + 60, 100), 5000);
      const totalCols = () => Math.min(Math.max(cur().cols + 4, 12), 100);
      const colPx = (c) => (cur().widths[c] ? Math.max(48, Math.round(cur().widths[c] * 7 + 8)) : DEFAULT_COL_PX);
      const addr = (r, c) => F.numberToCol(c) + r;

      function rawText(cell) {
        if (!cell) return '';
        if (cell.f) return '=' + cell.f;
        const v = cell.v;
        return v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
      }

      let addingSheet = false;
      function renderTabs() {
        const list = sheets.map((s, i) => h('button', { class: 'sh-tab' + (i === active ? ' active' : ''), type: 'button', text: s.name, onclick: () => switchSheet(i) }));
        if (editable) {
          if (addingSheet) {
            let n = sheets.length + 1;
            while (sheets.some((s) => s.name.toLowerCase() === 'sheet' + n)) n++;
            const input = h('input', { class: 'sh-add-input', type: 'text', maxlength: '31', value: 'Sheet' + n, 'aria-label': 'Name of the new sheet' });
            let done = false;
            const finish = (ok) => { if (done) return; done = true; addingSheet = false; if (ok) createSheet(input.value); else renderTabs(); };
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
            input.addEventListener('blur', () => finish(false));
            list.push(input);
            setTimeout(() => { input.focus(); input.select(); }, 0);
          } else {
            list.push(h('button', { class: 'sh-tab sh-add', type: 'button', title: 'Add a new sheet', text: '+', onclick: () => { addingSheet = true; renderTabs(); } }));
          }
        }
        tabs.replaceChildren(...list);
      }

      async function createSheet(name) {
        renderTabs();
        host.setStatus('Adding sheet…');
        try {
          commitEditing();
          await save(); // send pending cell edits first
          const out = await api('/api/edit/' + encodeURIComponent(data.name) + '/sheets', { method: 'POST', json: { name } });
          version = out.version;
          await refresh(out.name);
          host.banner(null);
        } catch (err) {
          ZP.toast(err.message, true);
        }
        statusNow();
      }

      let renderedFirst = -1;
      let renderedCount = -1;
      function render(force) {
        const sh = cur();
        const rows = totalRows();
        const cols = totalCols();
        const viewH = scroll.clientHeight || 600;
        const first = Math.max(1, Math.floor(scroll.scrollTop / ROW_H) - 6);
        const count = Math.ceil(viewH / ROW_H) + 14;
        if (!force && first === renderedFirst && count === renderedCount) return;
        renderedFirst = first;
        renderedCount = count;
        const last = Math.min(rows, first + count);

        const colgroup = h('colgroup', null, h('col', { style: 'width:46px' }), ...Array.from({ length: cols }, (_, i) => h('col', { style: 'width:' + colPx(i + 1) + 'px' })));
        const head = h('tr', null, h('th', { class: 'corner' }), ...Array.from({ length: cols }, (_, i) => h('th', { class: 'ch' + (sel.c === i + 1 ? ' on' : ''), text: F.numberToCol(i + 1) })));
        const bodyRows = [];
        if (first > 1) bodyRows.push(h('tr', { class: 'spacer', style: 'height:' + (first - 1) * ROW_H + 'px' }));
        for (let r = first; r <= last; r++) {
          const tds = [h('th', { class: 'rh' + (sel.r === r ? ' on' : ''), text: String(r) })];
          for (let c = 1; c <= cols; c++) {
            const cell = sh.cells.get(key(r, c));
            const d = display(sh, r, c);
            const style = [];
            if (cell && cell.s) {
              if (cell.s.b) style.push('font-weight:700');
              if (cell.s.fg) style.push('color:' + cell.s.fg);
              if (cell.s.bg) style.push('background:' + cell.s.bg);
            }
            tds.push(h('td', { class: (d.cls + (sel.r === r && sel.c === c ? ' sel' : '') + (cell && cell.ro ? ' ro' : '')).trim(), 'data-r': String(r), 'data-c': String(c), style: style.join(';') || false, text: d.text }));
          }
          bodyRows.push(h('tr', { style: 'height:' + ROW_H + 'px' }, tds));
        }
        if (last < rows) bodyRows.push(h('tr', { class: 'spacer', style: 'height:' + (rows - last) * ROW_H + 'px' }));
        table.replaceChildren(colgroup, h('thead', null, head), h('tbody', null, bodyRows));
        editing = null;
      }

      function refreshBar() {
        nameBox.textContent = addr(sel.r, sel.c);
        const cell = cur().cells.get(key(sel.r, sel.c));
        fxBar.textContent = rawText(cell);
        fxBar.title = cell && cell.ro ? 'This cell is part of a shared/array formula — edit it in Excel.' : '';
      }

      function select(r, c, keepScroll) {
        r = Math.max(1, Math.min(r, totalRows()));
        c = Math.max(1, Math.min(c, totalCols()));
        const prev = table.querySelector('td.sel');
        if (prev) prev.classList.remove('sel');
        table.querySelectorAll('th.on').forEach((x) => x.classList.remove('on'));
        sel = { r, c };
        const td = table.querySelector('td[data-r="' + r + '"][data-c="' + c + '"]');
        if (td) td.classList.add('sel');
        refreshBar();
        if (!keepScroll) ensureVisible(r, c);
      }

      function ensureVisible(r, c) {
        const top = (r - 1) * ROW_H;
        if (top < scroll.scrollTop + ROW_H) scroll.scrollTop = Math.max(0, top - ROW_H);
        else if (top + ROW_H * 2 > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = top + ROW_H * 2 - scroll.clientHeight;
        render(false);
        const td = table.querySelector('td[data-r="' + r + '"][data-c="' + c + '"]');
        if (td) {
          td.classList.add('sel');
          const left = td.offsetLeft;
          if (left < scroll.scrollLeft + 46) scroll.scrollLeft = left - 46;
          else if (left + td.offsetWidth > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = left + td.offsetWidth - scroll.clientWidth + 4;
        }
        table.querySelectorAll('th.on').forEach((x) => x.classList.remove('on'));
      }

      function switchSheet(i) {
        commitEditing();
        active = i;
        sel = { r: 1, c: 1 };
        scroll.scrollTop = 0;
        scroll.scrollLeft = 0;
        warn.classList.toggle('hidden', !cur().truncated);
        warn.textContent = cur().truncated ? 'This sheet is large: only the first 3000 rows and 100 columns are shown.' : '';
        renderTabs();
        render(true);
        refreshBar();
      }

      // ---- editing
      function setCell(sh, r, c, text) {
        const k = key(r, c);
        let cell = sh.cells.get(k);
        if (cell && cell.ro) return false;
        const before = rawText(cell);
        if (text === before) return false;

        if (!cell) { cell = {}; sh.cells.set(k, cell); }
        delete cell.d;
        cell.v0 = undefined;
        let change;
        if (text.trim().startsWith('=') && text.trim().length > 1) {
          cell.f = text.trim().slice(1);
          cell.v = null;
          change = { sheet: sh.name, r, c, f: cell.f, v: null };
        } else {
          cell.f = null;
          cell.v = parseTyped(text, cell);
          change = { sheet: sh.name, r, c, v: cell.v, f: null };
        }
        pending.set(sh.name + '|' + r + '|' + c, change);
        return true;
      }

      // After recalculation, formula cells get their computed result stored in the change.
      function finishChanges(sh) {
        recalc(sh);
        for (const ch of pending.values()) {
          if (ch.sheet !== sh.name || !ch.f) continue;
          const k = key(ch.r, ch.c);
          const x = sh.cv.get(k);
          if (x && x.err) ch.v = x.err;
          else if (x && x.unsupported) ch.v = null;
          else ch.v = x === undefined ? null : x;
          const cell = sh.cells.get(k);
          if (cell) cell.v = ch.v;
        }
      }

      function startEdit(r, c, initial) {
        if (!editable) return;
        const sh = cur();
        const cell = sh.cells.get(key(r, c));
        if (cell && cell.ro) { ZP.toast('This cell is part of a shared/array formula — edit it in Excel.', true); return; }
        const td = table.querySelector('td[data-r="' + r + '"][data-c="' + c + '"]');
        if (!td) return;
        const input = h('input', { class: 'cell-input', type: 'text', spellcheck: 'false' });
        input.value = initial != null ? initial : rawText(cell);
        td.classList.add('editing');
        td.textContent = '';
        td.append(input);
        input.focus();
        if (initial == null) input.select(); else input.setSelectionRange(input.value.length, input.value.length);
        editing = { r, c, input, done: false };
        input.addEventListener('input', () => { fxBar.textContent = input.value; });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitEditing(); select(r + (e.shiftKey ? -1 : 1), c); scroll.focus(); }
          else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); commitEditing(); select(r, c + (e.shiftKey ? -1 : 1)); scroll.focus(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEditing(); scroll.focus(); }
        });
        input.addEventListener('blur', () => { if (editing && editing.input === input) commitEditing(); });
      }

      function cancelEditing() {
        if (!editing) return;
        const { r, c } = editing;
        editing.done = true;
        editing = null;
        render(true);
        select(r, c, true);
      }

      function commitEditing() {
        if (!editing || editing.done) return;
        const e = editing;
        e.done = true;
        editing = null;
        const sh = cur();
        if (setCell(sh, e.r, e.c, e.input.value)) {
          finishChanges(sh);
          scheduleSave();
        }
        render(true);
        select(e.r, e.c, true);
        afterEdit();
      }

      function clearCell() {
        if (!editable) return;
        const sh = cur();
        if (setCell(sh, sel.r, sel.c, '')) { finishChanges(sh); scheduleSave(); render(true); select(sel.r, sel.c, true); afterEdit(); }
      }

      function afterEdit() {
        statusNow();
        if (needsRefresh && !pending.size && !saving) refresh();
      }

      // ---- saving
      function statusNow() {
        if (!editable) return host.setStatus('Read only');
        if (saving) return host.setStatus('Saving…');
        if (pending.size) return host.setStatus('Unsaved changes', 'warn');
        host.setStatus('All changes saved', 'ok');
      }
      function scheduleSave() {
        statusNow();
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, 1200);
      }

      async function save() {
        clearTimeout(saveTimer);
        commitEditing();
        if (!editable || saving || !pending.size || destroyed) return;
        saving = true;
        const batch = Array.from(pending.entries());
        batch.forEach(([k]) => pending.delete(k));
        statusNow();
        try {
          const out = await api('/api/edit/' + encodeURIComponent(data.name) + '/cells', { method: 'PATCH', json: { changes: batch.map(([, ch]) => ch) } });
          if (out.version === knownVersion + 1) knownVersion = out.version;
          else needsRefresh = true; // someone else saved in between: merge their changes in
          version = out.version;
          if (out.skipped && out.skipped.length) ZP.toast('Not changed (shared/array formulas): ' + out.skipped.join(', '), true);
          host.banner(null);
        } catch (err) {
          for (const [k, ch] of batch) if (!pending.has(k)) pending.set(k, ch);
          saving = false;
          host.setStatus('Not saved — retrying…', 'err');
          if (err.status === 403 || err.status === 404 || err.status === 400) {
            host.banner(err.message);
            return;
          }
          saveTimer = setTimeout(save, 5000);
          return;
        }
        saving = false;
        statusNow();
        if (pending.size) scheduleSave();
        else if (needsRefresh) refresh();
      }

      async function refresh(goTo) {
        if (destroyed || pending.size || saving || editing) { needsRefresh = true; return; }
        needsRefresh = false;
        try {
          const fresh = await api('/api/edit/' + encodeURIComponent(data.name));
          if (destroyed || pending.size || editing) { needsRefresh = true; return; }
          const names = sheets.map((s) => s.name);
          const activeName = names[active];
          sheets = buildSheets(fresh.workbook);
          sheets.forEach(recalc);
          let idx = typeof goTo === 'string' ? sheets.findIndex((s) => s.name === goTo) : -1;
          if (idx < 0) idx = sheets.findIndex((s) => s.name === activeName);
          active = idx >= 0 ? idx : 0;
          if (names.join('|') !== sheets.map((s) => s.name).join('|')) {
            if (idx !== names.indexOf(activeName) || typeof goTo === 'string') sel = { r: 1, c: 1 };
            renderTabs();
            warn.classList.toggle('hidden', !cur().truncated);
          }
          knownVersion = version = fresh.version;
          render(true);
          select(sel.r, sel.c, true);
        } catch (_) { needsRefresh = true; }
      }

      // ---- events
      table.addEventListener('mousedown', (e) => {
        const td = e.target.closest('td');
        if (!td || td.classList.contains('editing')) return;
        e.preventDefault();
        commitEditing();
        select(+td.dataset.r, +td.dataset.c, true);
        scroll.focus();
      });
      table.addEventListener('dblclick', (e) => {
        const td = e.target.closest('td');
        if (td) startEdit(+td.dataset.r, +td.dataset.c);
      });
      scroll.addEventListener('scroll', () => {
        if (editing) commitEditing();
        render(false);
      });
      scroll.addEventListener('keydown', (e) => {
        if (editing) return;
        const { r, c } = sel;
        const mod = e.ctrlKey || e.metaKey;
        const move = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
        if (move) { e.preventDefault(); select(r + move[0], c + move[1]); }
        else if (e.key === 'Tab') { e.preventDefault(); select(r, c + (e.shiftKey ? -1 : 1)); }
        else if (e.key === 'Enter') { e.preventDefault(); if (editable) startEdit(r, c); else select(r + 1, c); }
        else if (e.key === 'F2') { e.preventDefault(); startEdit(r, c); }
        else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); clearCell(); }
        else if (e.key === 'PageDown') { e.preventDefault(); select(r + 15, c); }
        else if (e.key === 'PageUp') { e.preventDefault(); select(r - 15, c); }
        else if (e.key === 'Home') { e.preventDefault(); select(mod ? 1 : r, 1); }
        else if (!mod && !e.altKey && e.key.length === 1) { e.preventDefault(); startEdit(r, c, e.key); }
      });
      scroll.addEventListener('copy', (e) => {
        const cell = cur().cells.get(key(sel.r, sel.c));
        const k = key(sel.r, sel.c);
        e.clipboardData.setData('text/plain', cell && cell.f ? display(cur(), sel.r, sel.c).text : rawText(cell) || display(cur(), sel.r, sel.c).text);
        void k;
        e.preventDefault();
      });
      scroll.addEventListener('paste', (e) => {
        if (!editable || editing) return;
        const text = (e.clipboardData || window.clipboardData).getData('text/plain');
        if (!text) return;
        e.preventDefault();
        const grid = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((line) => line.split('\t'));
        if (grid.length * Math.max(...grid.map((x) => x.length)) > 5000) { ZP.toast('That is too much to paste at once (limit 5000 cells).', true); return; }
        const sh = cur();
        let any = false;
        grid.forEach((row, i) => row.forEach((val, j) => { if (setCell(sh, sel.r + i, sel.c + j, val)) any = true; }));
        if (any) { finishChanges(sh); scheduleSave(); render(true); select(sel.r, sel.c, true); }
      });

      host.showSave(editable);
      renderTabs();
      if (cur().truncated) { warn.textContent = 'This sheet is large: only the first 3000 rows and 100 columns are shown.'; warn.classList.remove('hidden'); }
      statusNow();
      setTimeout(() => { render(true); refreshBar(); }, 0);

      return {
        save,
        dirty: () => editable && (pending.size > 0 || saving || !!(editing && !editing.done && editing.input.value !== rawText(cur().cells.get(key(editing.r, editing.c))))),
        destroy() { destroyed = true; clearTimeout(saveTimer); },
        remoteChanged(entry) {
          if (entry.version !== knownVersion) {
            if (saving) return; // our own save: the save handler compares versions
            if (pending.size || editing) needsRefresh = true;
            else refresh();
          }
        },
      };
    },
  };
})();
