// Word (.docx) text editor. Edits the TEXT of paragraphs; pictures, tables,
// headers, fonts and page layout inside the file are left exactly as they are.
(() => {
  'use strict';
  const { h, api } = ZP;

  ZP.editors.docx = {
    mount(body, data, host) {
      let version = data.version;
      let saving = false;
      // items: { i: original index | null, text, orig, locked, tl, inTable, style }
      let items = data.paragraphs.map((p) => ({ i: p.i, text: p.text, orig: p.text, locked: p.locked, tl: p.tl, inTable: p.inTable, style: p.style }));
      const removedOriginals = () => data.paragraphs.filter((p) => !items.some((it) => it.i === p.i)).length;

      const page = h('div', { class: 'doc-page' });
      const note = h('div', { class: 'doc-note', text: 'You are editing the text. Pictures, tables, headers and page layout stay exactly as they are in the Word file. Paragraphs marked 🔒 contain pictures, links or fields — change those in Word.' });
      body.replaceChildren(h('div', { class: 'doc-scroll' }, note, page));

      const dirty = () => host.editable && (removedOriginals() > 0 || items.some((it) => it.i === null || it.text !== it.orig));
      function status() {
        host.setStatus(!host.editable ? 'Read only' : dirty() ? 'Unsaved changes' : 'All changes saved', !host.editable ? '' : dirty() ? 'warn' : 'ok');
      }
      host.showSave(host.editable);

      function grow(area) {
        area.style.height = 'auto';
        area.style.height = area.scrollHeight + 2 + 'px';
      }

      function headingClass(style) {
        const m = /^Heading\s?(\d)/i.exec(style || '');
        if (m) return 'h' + Math.min(+m[1], 4);
        if (/^Title/i.test(style || '')) return 'h0';
        return '';
      }

      function render(focusIndex) {
        const rows = items.map((it, idx) => {
          const cls = 'dp ' + headingClass(it.style) + (it.inTable ? ' intable' : '') + (it.locked ? ' locked' : '');
          let field;
          if (it.locked || !host.editable) {
            field = h('div', { class: 'dp-text' + (it.locked ? ' ro' : '') }, (it.locked ? '🔒 ' : '') + (it.text || ' '));
          } else {
            field = h('textarea', { class: 'dp-text', rows: '1', spellcheck: 'true' });
            field.value = it.text;
            field.addEventListener('input', () => { it.text = field.value; grow(field); status(); });
            field.addEventListener('keydown', (e) => {
              // Enter at the end of a main-text paragraph starts a new one.
              if (e.key === 'Enter' && !e.shiftKey && it.tl && field.selectionStart === field.value.length && !e.isComposing) {
                e.preventDefault();
                insertAfter(idx);
              }
            });
            setTimeout(() => grow(field), 0);
          }
          const tools = [];
          if (host.editable && it.tl && !it.locked) tools.push(h('button', { class: 'dp-btn', type: 'button', title: 'Delete this paragraph', 'aria-label': 'Delete paragraph', text: '×', onclick: () => removeAt(idx) }));
          if (host.editable && it.tl) tools.push(h('button', { class: 'dp-btn', type: 'button', title: 'Add a paragraph below', 'aria-label': 'Add paragraph below', text: '+', onclick: () => insertAfter(idx) }));
          return h('div', { class: cls, 'data-idx': String(idx) }, field, h('div', { class: 'dp-tools' }, tools));
        });
        page.replaceChildren(...rows);
        if (focusIndex != null) {
          const f = page.querySelector('[data-idx="' + focusIndex + '"] textarea');
          if (f) f.focus();
        }
        status();
      }

      function insertAfter(idx) {
        const base = items[idx];
        items.splice(idx + 1, 0, { i: null, text: '', orig: '', locked: false, tl: true, inTable: false, style: base.style && /^(Heading|Title)/i.test(base.style) ? '' : base.style });
        render(idx + 1);
      }
      function removeAt(idx) {
        const it = items[idx];
        if (it.text.trim() && !window.confirm('Delete this paragraph?')) return;
        items.splice(idx, 1);
        render(Math.min(idx, items.length - 1));
      }

      async function save() {
        if (!host.editable || saving || !dirty()) return;
        saving = true;
        host.setStatus('Saving…');
        try {
          await api('/api/edit/' + encodeURIComponent(data.name) + '/docx', {
            method: 'PUT',
            json: { baseVersion: version, items: items.map((it) => ({ i: it.i, text: it.text })) },
          });
        } catch (err) {
          saving = false;
          host.setStatus('Not saved', 'err');
          host.banner(err.message, err.body && err.body.changed ? [{ label: 'Reload latest (discard my changes)', run: () => host.reopen() }] : null);
          return;
        }
        saving = false;
        host.reopen(); // reload so paragraph numbers match the saved file
      }

      render(null);
      return {
        save,
        dirty,
        destroy() {},
        remoteChanged(entry) {
          if (entry.version !== version && !saving) {
            host.banner('Someone replaced this file with a newer version.', [{ label: 'Load it', run: () => host.reopen() }]);
          }
        },
      };
    },
  };
})();
