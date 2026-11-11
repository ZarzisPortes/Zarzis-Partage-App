// Shared helpers and state. Loaded first; every other script uses window.ZP.
window.ZP = (() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Builds DOM safely (text is always inserted as text, never as HTML).
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }

  async function api(path, opts) {
    opts = opts || {};
    const init = {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'zp' },
    };
    if (opts.keepalive) init.keepalive = true;
    if (opts.json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.json);
    }
    const res = await fetch(path, init);
    let body = null;
    try { body = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok) {
      const err = new Error((body && body.error) || 'Error ' + res.status);
      err.status = res.status;
      err.code = body && body.error;
      err.body = body || {};
      throw err;
    }
    return body;
  }

  function toast(message, isError) {
    const t = h('div', { class: 'toast' + (isError ? ' error' : ''), text: message });
    $('toasts').append(t);
    setTimeout(() => t.remove(), isError ? 7000 : 4000);
  }

  const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  function formatDate(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : dateFmt.format(d);
  }

  function formatSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB'];
    let v = bytes / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
  }

  const KINDS = {
    xls: ['xls', 'xlsx', 'xlsm', 'csv', 'ods'],
    doc: ['doc', 'docx', 'docm', 'odt', 'rtf'],
    pdf: ['pdf'],
    img: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tif', 'tiff'],
    ppt: ['ppt', 'pptx', 'odp'],
    zip: ['zip', 'rar', '7z', 'gz', 'tar'],
    txt: ['txt', 'log', 'md', 'json', 'xml', 'ini', 'tsv'],
  };
  function fileKind(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    for (const [cls, list] of Object.entries(KINDS)) {
      if (list.includes(ext)) return { cls, label: ext.length > 4 ? ext.slice(0, 4) : ext.toUpperCase() };
    }
    return { cls: '', label: name.includes('.') ? ext.slice(0, 4).toUpperCase() : 'FILE' };
  }

  function contentUrl(name, download) {
    return '/api/files/' + encodeURIComponent(name) + '/content' + (download ? '?download=1' : '');
  }

  const PERM_LABELS = {
    view: 'View files',
    download: 'Download files',
    upload: 'Add new files',
    edit: 'Modify files',
    delete: 'Delete files',
  };

  function roleChip(role) {
    return h('span', { class: 'chip' }, h('i', { class: 'dot', style: 'background:' + role.color }), role.name);
  }

  const state = {
    me: null,
    cfg: { maxUploadBytes: 200 * 1024 * 1024 },
    roles: [],
    members: [],
    online: [],
    editing: {},
    files: [],
    access: { isChief: false, roleIds: ['member'], permissions: { view: true, download: true, upload: true, edit: true, delete: true } },
  };

  return { $, h, api, toast, formatDate, formatSize, fileKind, contentUrl, PERM_LABELS, roleChip, state, editors: {} };
})();
