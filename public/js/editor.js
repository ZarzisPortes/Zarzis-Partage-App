// The editor pane on the right. It opens a file, picks the right editor for it
// (spreadsheet, Word text, plain text), manages the "someone is editing" lock
// and warns before unsaved work is lost.
(() => {
  'use strict';
  const { $, h, api, toast, state } = ZP;

  let cur = null; // { name, data, ctrl, lockTimer, host }

  const enc = encodeURIComponent;

  function setStatus(text, kind) {
    const el = $('ed-status');
    el.textContent = text || '';
    el.className = 'ed-status' + (kind ? ' ' + kind : '');
  }

  function banner(text, actions) {
    const box = $('ed-banner');
    if (!text) { box.classList.add('hidden'); box.replaceChildren(); return; }
    box.classList.remove('hidden');
    box.replaceChildren(h('span', { text }), ...(actions || []).map((a) => h('button', { class: 'btn small', type: 'button', text: a.label, onclick: a.run })));
  }

  function show(on) {
    $('editor').classList.toggle('hidden', !on);
    $('editor-empty').classList.toggle('hidden', on);
    $('layout').classList.toggle('editor-open', on);
  }

  async function releaseLock(c) {
    if (!c) return;
    clearInterval(c.lockTimer);
    if (c.hasLock) {
      c.hasLock = false;
      try { await api('/api/edit/' + enc(c.name) + '/lock', { method: 'DELETE', keepalive: true }); } catch (_) { /* expires by itself */ }
    }
  }

  async function close(force) {
    if (!cur) return true;
    if (!force && cur.ctrl && cur.ctrl.dirty()) {
      if (!window.confirm('You have unsaved changes in “' + cur.name + '”. Close without saving?')) return false;
    }
    const c = cur;
    cur = null;
    try { c.ctrl && c.ctrl.destroy(); } catch (_) { /* ignore */ }
    await releaseLock(c);
    $('ed-body').replaceChildren();
    banner(null);
    setStatus('');
    show(false);
    return true;
  }

  async function open(name) {
    if (cur && cur.name === name) return;
    if (!(await close(false))) return;

    show(true);
    $('ed-name').textContent = name;
    $('ed-save').classList.add('hidden');
    $('ed-download').classList.toggle('hidden', !state.access.permissions.download);
    $('ed-download').href = ZP.contentUrl(name, true);
    banner(null);
    setStatus('Opening…');
    $('ed-body').replaceChildren(h('div', { class: 'ed-loading', text: 'Opening “' + name + '”…' }));

    const c = { name, data: null, ctrl: null, lockTimer: null, hasLock: false };
    cur = c;

    let data;
    try {
      data = await api('/api/edit/' + enc(name));
    } catch (err) {
      if (cur !== c) return;
      $('ed-body').replaceChildren(h('div', { class: 'ed-loading err', text: err.message }));
      setStatus('');
      return;
    }
    if (cur !== c) return; // another file was opened meanwhile
    c.data = data;

    // Text and Word: one editor at a time.
    let editable = data.canEdit;
    if (data.kind !== 'sheet' && data.canEdit) {
      try {
        await api('/api/edit/' + enc(name) + '/lock', { method: 'POST' });
        c.hasLock = true;
        c.lockTimer = setInterval(() => {
          api('/api/edit/' + enc(name) + '/lock', { method: 'POST' }).catch(() => setStatus('Lost the editing lock — save and reopen', 'warn'));
        }, 30000);
      } catch (err) {
        editable = false;
        banner(err.status === 409 ? err.message + ' You can read it, but not change it right now.' : err.message, [{ label: 'Try again', run: () => reopen(name) }]);
      }
    } else if (!data.canEdit) {
      banner('Read only: your role is not allowed to modify this file.');
    }
    if (cur !== c) return;

    const host = {
      name,
      editable,
      setStatus,
      banner,
      reopen: () => reopen(name),
      save: () => (c.ctrl ? c.ctrl.save() : Promise.resolve()),
      showSave(on) { $('ed-save').classList.toggle('hidden', !on); },
    };
    c.host = host;
    $('ed-body').replaceChildren();
    try {
      c.ctrl = ZP.editors[data.kind].mount($('ed-body'), data, host);
    } catch (err) {
      console.error(err);
      $('ed-body').replaceChildren(h('div', { class: 'ed-loading err', text: 'Could not display this file: ' + err.message }));
    }
  }

  async function reopen(name) {
    await close(true);
    await open(name);
  }

  $('ed-close').addEventListener('click', () => close(false));
  $('ed-save').addEventListener('click', () => { if (cur && cur.ctrl) cur.ctrl.save(); });

  // Called after every refresh of the file list.
  function onState() {
    if (!cur || !cur.ctrl) return;
    const entry = state.files.find((f) => f.name === cur.name);
    if (!entry) {
      banner('This file was deleted or renamed by someone else.', [{ label: 'Close', run: () => close(true) }]);
      return;
    }
    if (cur.ctrl.remoteChanged) cur.ctrl.remoteChanged(entry);
  }

  window.addEventListener('beforeunload', (e) => {
    if (cur && cur.ctrl && cur.ctrl.dirty()) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('pagehide', () => { if (cur) releaseLock(cur); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && cur && cur.ctrl && !$('editor').classList.contains('hidden')) {
      e.preventDefault();
      cur.ctrl.save();
    }
  });

  ZP.editor = { open, close, onState, isOpen: () => !!cur, current: () => (cur ? cur.name : null) };
  void toast;
})();
