// Page logic: sign-in screens, polling, files, scoreboard, uploads.
(() => {
  'use strict';
  const { $, h, api, toast, formatDate, formatSize, fileKind, contentUrl, state } = ZP;
  const POLL_MS = 4000;

  const view = { rev: 0, activity: [], totalActivity: 0, limit: 50, search: '', seenFiles: null, maxActivityId: null, polling: false, timer: null };

  // -------------------------------------------------------------- views
  const LOGIN_ERRORS = {
    not_allowed: 'This Google account is not on the list for the Shared Room. Ask your administrator to add your email address.',
    cancelled: 'Sign-in was cancelled. Press the button to try again.',
    state: 'The sign-in took too long or was interrupted. Please try again.',
    google: 'Google could not sign you in. Please try again in a moment.',
    not_configured: 'The server has no Google sign-in details yet. Your administrator needs to finish the setup (see README).',
  };

  function showLogin(errorCode) {
    stopPolling();
    ZP.editor.close(true);
    $('view-app').classList.add('hidden');
    $('view-login').classList.remove('hidden');
    const box = $('login-error');
    if (errorCode) {
      box.textContent = LOGIN_ERRORS[errorCode] || 'Something went wrong. Please try again.';
      box.classList.remove('hidden');
    } else {
      box.classList.add('hidden');
    }
  }

  function renderUser() {
    const me = state.me;
    $('who-nick').textContent = me.nickname || me.name || me.email;
    $('who-email').textContent = me.email;
    const img = $('avatar');
    if (me.picture) {
      img.src = me.picture;
      img.classList.remove('hidden');
      img.onerror = () => img.classList.add('hidden');
    } else {
      img.classList.add('hidden');
    }
  }

  function enterApp() {
    $('view-login').classList.add('hidden');
    $('view-app').classList.remove('hidden');
    state.access = { isChief: !!state.me.isChief, roleIds: state.me.roleIds || ['member'], permissions: state.me.permissions || state.access.permissions };
    renderUser();
    if (!state.me.nickname) openNickname(true);
    else startPolling();
  }

  // ----------------------------------------------------------- nickname
  let nickRequired = false;

  function openNickname(required) {
    nickRequired = required;
    const dlg = $('nick-dialog');
    $('nick-title').textContent = required ? 'Welcome! What should we call you?' : 'Change your nickname';
    $('nick-help').hidden = !required;
    $('nick-cancel').classList.toggle('hidden', required);
    $('nick-error').classList.add('hidden');
    $('nick-input').value = required ? '' : state.me.nickname || '';
    if (!dlg.open) dlg.showModal();
    $('nick-input').focus();
    $('nick-input').select();
  }

  $('nick-dialog').addEventListener('cancel', (e) => { if (nickRequired) e.preventDefault(); });
  $('nick-cancel').addEventListener('click', () => $('nick-dialog').close());

  $('nick-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('nick-save');
    btn.disabled = true;
    try {
      const out = await api('/api/me/nickname', { method: 'PUT', json: { nickname: $('nick-input').value } });
      const wasRequired = nickRequired;
      state.me.nickname = out.nickname;
      renderUser();
      $('nick-dialog').close();
      nickRequired = false;
      if (wasRequired) startPolling();
      else { toast('Nickname saved. New activity will use “' + out.nickname + '”.'); poll(true); }
    } catch (err) {
      const box = $('nick-error');
      box.textContent = err.message;
      box.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-rename').addEventListener('click', () => openNickname(false));
  $('btn-logout').addEventListener('click', async () => {
    if (!(await ZP.editor.close(false))) return;
    try { await api('/auth/logout', { method: 'POST' }); } catch (_) { /* ignore */ }
    state.me = null;
    view.rev = 0;
    view.seenFiles = null;
    view.maxActivityId = null;
    showLogin();
  });

  // ------------------------------------------------------------ polling
  function startPolling() {
    stopPolling();
    poll(true);
    view.timer = setInterval(() => { if (!document.hidden) poll(false); }, POLL_MS);
  }
  function stopPolling() {
    if (view.timer) clearInterval(view.timer);
    view.timer = null;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && view.timer) poll(false); });

  async function poll(force) {
    if (view.polling) { if (force) setTimeout(() => poll(true), 400); return; }
    view.polling = true;
    try {
      const q = new URLSearchParams({ since: force ? 0 : view.rev, limit: view.limit });
      const data = await api('/api/state?' + q.toString());
      const prevOnline = JSON.stringify(state.online);
      const prevEditing = JSON.stringify(state.editing);
      state.online = data.online || [];
      state.editing = data.editing || {};

      if (ZP.chat) ZP.chat.onRev(data.chatRev);
      if (data.unchanged) {
        if (JSON.stringify(state.online) !== prevOnline) ZP.members.render();
        if (JSON.stringify(state.editing) !== prevEditing) renderFiles();
        return;
      }
      view.rev = data.rev;
      state.files = data.files;
      state.roles = data.roles || [];
      state.members = data.members || [];
      state.access = data.access || state.access;
      view.activity = data.activity;
      view.totalActivity = data.totalActivity;
      render();
    } catch (err) {
      if (err.status === 401) showLogin();
      else if (err.code === 'nickname_required') openNickname(true);
      // network hiccups are ignored: the next poll retries
    } finally {
      view.polling = false;
    }
  }
  ZP.refresh = () => poll(true);

  // ---------------------------------------------------------- rendering
  function render() {
    renderAccess();
    renderFiles();
    renderBoard();
    ZP.members.render();
    if (ZP.chat) ZP.chat.render();
    ZP.editor.onState();
  }

  function renderAccess() {
    const p = state.access.permissions;
    const canAdd = p.upload || p.edit;
    $('dropzone').classList.toggle('hidden', !canAdd);
    $('btn-new').classList.toggle('hidden', !p.upload);
    $('btn-trash').classList.toggle('hidden', !(state.access.isChief || p.delete));
    $('readonly-note').classList.toggle('hidden', canAdd);
  }

  function openFile(f) {
    const p = state.access.permissions;
    if (f.editKind && p.view) ZP.editor.open(f.name);
    else if (f.previewable && p.view) openPreview(f);
    else if (p.download) window.location.href = contentUrl(f.name, true);
    else toast('Your role is not allowed to open or download this file.', true);
  }

  function renderFiles() {
    const p = state.access.permissions;
    const q = view.search.trim().toLowerCase();
    const files = state.files
      .filter((f) => !q || f.name.toLowerCase().includes(q))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

    const firstLoad = view.seenFiles === null;
    const seen = view.seenFiles || {};

    $('files').replaceChildren(
      ...files.map((f) => {
        const changed = !firstLoad && seen[f.name] !== f.updatedAt;
        const kind = fileKind(f.name);
        const lock = state.editing[f.name];

        const nameEl = h('a', {
          class: 'fname',
          href: p.download ? contentUrl(f.name, true) : '#',
          title: f.editKind ? 'Click to open in the editor' : f.previewable ? 'Click to preview' : 'Click to download',
          text: f.name,
          onclick: (e) => { e.preventDefault(); openFile(f); },
        });

        const meta = h('div', { class: 'fmeta' }, formatSize(f.size) + ' · ', h('b', { text: f.updatedBy.nickname || f.updatedBy.email }), ' · ' + formatDate(f.updatedAt) + (f.version > 1 ? ' · v' + f.version : ''));
        const roleNames = (f.editRoles || []).map((id) => (state.roles.find((r) => r.id === id) || {}).name).filter(Boolean);
        if (lock) meta.append(h('br'), h('span', { class: 'editing-now', text: '✏️ ' + lock.by + ' is editing' }));
        if (roleNames.length) meta.append(h('br'), h('span', { class: 'lock', text: '🔒 Only ' + roleNames.join(', ') + ' (and the Chief) can edit or delete' }));
        if (!f.canEdit && !f.canDelete) meta.append(h('br'), h('span', { class: 'ro', text: 'Read only for you' }));

        const actions = h('div', { class: 'fact' },
          f.editKind && p.view ? h('button', { class: 'btn small', type: 'button', text: f.canEdit ? 'Edit' : 'Open', onclick: () => ZP.editor.open(f.name) }) : null,
          !f.editKind && f.previewable && p.view ? h('button', { class: 'btn small', type: 'button', text: 'View', onclick: () => openPreview(f) }) : null,
          p.download ? h('a', { class: 'btn small ghost', href: contentUrl(f.name, true), text: 'Download' }) : null,
          state.access.isChief ? h('button', { class: 'btn small ghost', type: 'button', text: 'Access', onclick: () => openAccess(f) }) : null,
          f.canEdit ? h('button', { class: 'btn small ghost', type: 'button', text: 'Rename', onclick: () => openRename(f) }) : null,
          f.canDelete ? h('button', { class: 'btn small ghost', type: 'button', text: 'Delete', onclick: () => askDelete(f) }) : null
        );

        return h('li', { class: 'file' + (changed ? ' flash' : '') }, h('div', { class: 'ficon ' + kind.cls, text: kind.label }), h('div', { class: 'finfo' }, nameEl, meta), actions);
      })
    );

    view.seenFiles = {};
    for (const f of state.files) view.seenFiles[f.name] = f.updatedAt;

    $('file-count').textContent = state.files.length ? String(state.files.length) : '';
    $('files-empty').textContent = !p.view ? 'Your role is not allowed to view files.' : state.files.length ? 'No file matches your search.' : 'No files yet — drop the first one above.';
    $('files-empty').classList.toggle('hidden', files.length > 0);
  }

  function renderBoard() {
    const firstLoad = view.maxActivityId === null;
    const prevMax = view.maxActivityId || 0;

    $('board').replaceChildren(
      ...view.activity.map((a) =>
        h('tr', { class: !firstLoad && a.id > prevMax ? 'new' : '' },
          h('td', { class: 'when', text: formatDate(a.ts) }),
          h('td', { class: 'who-cell' }, h('strong', { text: a.nickname || '—' }), h('span', { text: a.email })),
          h('td', { class: 'fcell' },
            h('span', { class: 'badge ' + a.action.replace(/\s+/g, '-'), text: a.action }),
            ' ', a.file || '',
            a.detail ? h('span', { class: 'detail', text: a.detail }) : null)
        )
      )
    );

    const topId = view.activity.length ? view.activity[0].id : 0;
    view.maxActivityId = Math.max(prevMax, topId);
    $('board-empty').classList.toggle('hidden', view.activity.length > 0);
    $('btn-more').classList.toggle('hidden', view.totalActivity <= view.activity.length);
  }

  $('btn-more').addEventListener('click', () => { view.limit += 100; poll(true); });
  $('search').addEventListener('input', (e) => { view.search = e.target.value; renderFiles(); });

  // -------------------------------------------------------------- delete
  let pendingDelete = null;
  function askDelete(file) {
    pendingDelete = file;
    $('confirm-name').textContent = file.name;
    $('confirm-dialog').showModal();
  }
  $('confirm-no').addEventListener('click', () => $('confirm-dialog').close());
  $('confirm-yes').addEventListener('click', async () => {
    const file = pendingDelete;
    $('confirm-dialog').close();
    if (!file) return;
    try {
      await api('/api/files/' + encodeURIComponent(file.name), { method: 'DELETE' });
      toast('Deleted “' + file.name + '”.');
    } catch (err) {
      toast(err.message, true);
    }
    poll(true);
  });

  // -------------------------------------------------------------- rename
  let renameFile = null;
  function openRename(file) {
    renameFile = file;
    $('rename-error').classList.add('hidden');
    $('rename-name').value = file.name;
    $('rename-dialog').showModal();
    const input = $('rename-name');
    input.focus();
    const dot = file.name.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : file.name.length); // select the name, not “.xlsx”
  }
  $('rename-cancel').addEventListener('click', () => $('rename-dialog').close());
  $('rename-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('rename-save').click(); } });
  $('rename-save').addEventListener('click', async () => {
    const file = renameFile;
    const btn = $('rename-save');
    btn.disabled = true;
    try {
      const out = await api('/api/files/' + encodeURIComponent(file.name) + '/rename', { method: 'PUT', json: { name: $('rename-name').value } });
      $('rename-dialog').close();
      toast('Renamed to “' + out.name + '”.');
      const wasOpen = ZP.editor.current() === file.name;
      if (wasOpen) await ZP.editor.close(true);
      await poll(true);
      if (wasOpen) ZP.editor.open(out.name);
    } catch (err) {
      const box = $('rename-error');
      box.textContent = err.message;
      box.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });

  // --------------------------------------------------------------- trash
  async function loadTrash() {
    let data;
    try { data = await api('/api/trash'); } catch (err) { toast(err.message, true); return; }
    $('trash-note').textContent = 'Deleted files and older versions of changed files are kept here' +
      (data.days ? ' for ' + data.days + ' days' : '') + '. Restoring never overwrites a file that exists now.';
    $('trash-empty').classList.toggle('hidden', data.items.length > 0);
    $('trash-list').replaceChildren(...data.items.map((it) => {
      const kind = fileKind(it.name);
      const restore = h('button', { class: 'btn small', type: 'button', text: 'Restore', onclick: async (e) => {
        e.target.disabled = true;
        try {
          const out = await api('/api/trash/restore', { method: 'POST', json: { id: it.id } });
          toast('Restored “' + out.name + '”.');
          poll(true);
          loadTrash();
        } catch (err) { toast(err.message, true); e.target.disabled = false; }
      } });
      const purge = data.canPurge ? h('button', { class: 'btn small ghost', type: 'button', text: 'Delete forever', onclick: async () => {
        if (!window.confirm('Delete “' + it.name + '” forever? This cannot be undone.')) return;
        try { await api('/api/trash/' + encodeURIComponent(it.id), { method: 'DELETE' }); poll(true); loadTrash(); } catch (err) { toast(err.message, true); }
      } }) : null;
      return h('li', { class: 'file' },
        h('div', { class: 'ficon ' + kind.cls, text: kind.label }),
        h('div', { class: 'finfo' },
          h('span', { class: 'fname', text: it.name }),
          h('div', { class: 'fmeta' }, it.reasonText + ' · ' + formatSize(it.size) + ' · ' + formatDate(it.ts) + (it.by ? ' · by ' + it.by : ''),
            it.reason === 'deleted' && it.nameTaken ? h('span', { class: 'ro', text: ' · a file with this name exists now, it will be restored as “(restored)”' }) : null)),
        h('div', { class: 'fact' }, restore, purge));
    }));
  }
  $('btn-trash').addEventListener('click', () => { $('trash-dialog').showModal(); loadTrash(); });
  $('trash-close').addEventListener('click', () => $('trash-dialog').close());

  // ------------------------------------------------------------- preview
  function openPreview(file) {
    const url = contentUrl(file.name, false);
    const isImage = /\.(png|jpe?g|gif|webp)$/i.test(file.name);
    $('preview-title').textContent = file.name;
    $('preview-download').classList.toggle('hidden', !state.access.permissions.download);
    $('preview-download').href = contentUrl(file.name, true);
    $('preview-body').replaceChildren(isImage ? h('img', { src: url, alt: file.name }) : h('iframe', { src: url, title: file.name }));
    $('preview-dialog').showModal();
  }
  $('preview-close').addEventListener('click', () => $('preview-dialog').close());
  $('preview-dialog').addEventListener('close', () => $('preview-body').replaceChildren());
  $('preview-dialog').addEventListener('click', (e) => { if (e.target === $('preview-dialog')) $('preview-dialog').close(); });

  // --------------------------------------------------- per-file access
  let accessFile = null;
  function openAccess(file) {
    accessFile = file;
    $('access-name').textContent = file.name;
    const custom = state.roles.filter((r) => !r.builtin);
    $('access-none').classList.toggle('hidden', custom.length > 0);
    $('access-save').classList.toggle('hidden', custom.length === 0);
    $('access-roles').replaceChildren(...custom.map((r) =>
      h('label', { class: 'check' }, h('input', { type: 'checkbox', value: r.id, checked: (file.editRoles || []).includes(r.id) ? 'checked' : false }), ZP.roleChip(r))));
    $('access-dialog').showModal();
  }
  $('access-cancel').addEventListener('click', () => $('access-dialog').close());
  $('access-save').addEventListener('click', async () => {
    const ids = Array.from($('access-roles').querySelectorAll('input:checked')).map((i) => i.value);
    try {
      await api('/api/files/' + encodeURIComponent(accessFile.name) + '/access', { method: 'PUT', json: { editRoles: ids } });
      toast(ids.length ? 'File is now restricted.' : 'Restriction removed.');
      $('access-dialog').close();
      poll(true);
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ------------------------------------------------------------ new file
  $('btn-new').addEventListener('click', () => {
    $('new-error').classList.add('hidden');
    $('new-name').value = '';
    $('new-dialog').showModal();
    $('new-name').focus();
  });
  $('new-cancel').addEventListener('click', () => $('new-dialog').close());
  $('new-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('new-create').click(); } });
  $('new-create').addEventListener('click', async () => {
    const kind = (document.querySelector('input[name="newkind"]:checked') || {}).value;
    const btn = $('new-create');
    btn.disabled = true;
    try {
      const out = await api('/api/new', { method: 'POST', json: { name: $('new-name').value, kind } });
      $('new-dialog').close();
      await poll(true);
      setTimeout(() => ZP.editor.open(out.name), 300);
    } catch (err) {
      const box = $('new-error');
      box.textContent = err.message;
      box.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });

  // -------------------------------------------------------------- upload
  let uploadChain = Promise.resolve();

  function queueUploads(fileList) {
    for (const file of fileList) {
      const row = h('li', { class: 'up' },
        h('div', { class: 'up-row' }, h('span', { class: 'up-name', text: file.name }), h('span', { class: 'up-status', text: 'Waiting…' })),
        h('div', { class: 'bar' }, h('i')));
      $('upload-list').prepend(row);
      uploadChain = uploadChain.then(() => uploadOne(file, row));
    }
  }

  function setRow(row, cls, status, pct) {
    row.className = 'up' + (cls ? ' ' + cls : '');
    row.querySelector('.up-status').textContent = status;
    if (pct != null) row.querySelector('.bar i').style.width = pct + '%';
  }

  function uploadOne(file, row) {
    return new Promise((resolve) => {
      if (file.size > state.cfg.maxUploadBytes) {
        setRow(row, 'fail', 'Too large (limit ' + formatSize(state.cfg.maxUploadBytes) + ')', 100);
        return resolve();
      }
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('X-Requested-With', 'zp');
      xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setRow(row, '', Math.round((e.loaded / e.total) * 100) + '%', (e.loaded / e.total) * 100);
      };
      xhr.onload = () => {
        let body = null;
        try { body = JSON.parse(xhr.responseText); } catch (_) { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300) {
          setRow(row, 'ok', body && body.action === 'Updated' ? '✓ Replaced with the new version' : '✓ Uploaded', 100);
          poll(true);
        } else if (xhr.status === 401) {
          showLogin();
        } else {
          setRow(row, 'fail', (body && body.error) || 'Failed (' + xhr.status + ')', 100);
        }
        setTimeout(() => row.remove(), xhr.status < 300 ? 6000 : 20000);
        resolve();
      };
      xhr.onerror = () => {
        setRow(row, 'fail', 'Connection lost — try again', 100);
        setTimeout(() => row.remove(), 20000);
        resolve();
      };
      setRow(row, '', '0%', 0);
      xhr.send(file);
    });
  }

  $('btn-choose').addEventListener('click', () => $('file-input').click());
  $('dropzone').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file-input').click(); } });
  $('file-input').addEventListener('change', (e) => { queueUploads(Array.from(e.target.files)); e.target.value = ''; });

  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  const canDrop = () => !$('view-app').classList.contains('hidden') && state.me && state.me.nickname && (state.access.permissions.upload || state.access.permissions.edit);

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !canDrop()) return;
    e.preventDefault();
    dragDepth++;
    $('drop-overlay').classList.remove('hidden');
    $('dropzone').classList.add('over');
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) { $('drop-overlay').classList.add('hidden'); $('dropzone').classList.remove('over'); }
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // stops the browser from opening the file instead
    dragDepth = 0;
    $('drop-overlay').classList.add('hidden');
    $('dropzone').classList.remove('over');
    if ($('view-app').classList.contains('hidden') || !state.me || !state.me.nickname) return;
    if (!canDrop()) return toast('Your role cannot add or change files.', true);

    const files = [];
    let skippedFolders = 0;
    const items = e.dataTransfer.items;
    if (items && items.length) {
      for (const item of Array.from(items)) {
        if (item.kind !== 'file') continue;
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry && entry.isDirectory) { skippedFolders++; continue; }
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    } else {
      files.push(...Array.from(e.dataTransfer.files));
    }
    if (skippedFolders) toast('Folders cannot be uploaded. Put them in a .zip file first.', true);
    if (files.length) queueUploads(files);
  });

  // ---------------------------------------------------------------- boot
  async function boot() {
    const params = new URLSearchParams(location.search);
    const errorCode = params.get('error');
    if (errorCode) history.replaceState(null, '', '/');

    try { state.cfg = Object.assign(state.cfg, await api('/api/config')); } catch (_) { /* defaults */ }
    try {
      state.me = await api('/api/me');
    } catch (err) {
      showLogin(errorCode);
      return;
    }
    enterApp();
  }

  boot();
})();
