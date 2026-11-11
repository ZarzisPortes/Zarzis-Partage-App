// Plain text editor (.txt, .md, .csv, .json, ...).
(() => {
  'use strict';
  const { h, api } = ZP;

  ZP.editors.text = {
    mount(body, data, host) {
      let version = data.version;
      let saved = data.text;
      let saving = false;

      const area = h('textarea', { class: 'text-area', spellcheck: 'false', wrap: 'off' });
      area.value = data.text;
      if (!host.editable) area.readOnly = true;
      body.replaceChildren(area);

      const dirty = () => host.editable && area.value !== saved;
      const refreshStatus = () => host.setStatus(!host.editable ? 'Read only' : dirty() ? 'Unsaved changes' : 'All changes saved', !host.editable ? '' : dirty() ? 'warn' : 'ok');
      host.showSave(host.editable);
      refreshStatus();
      area.addEventListener('input', refreshStatus);

      async function save() {
        if (!host.editable || saving || !dirty()) return;
        saving = true;
        host.setStatus('Saving…');
        const text = area.value;
        try {
          const out = await api('/api/edit/' + encodeURIComponent(data.name) + '/text', { method: 'PUT', json: { text, baseVersion: version, bom: data.bom } });
          version = out.version;
          saved = text;
          host.banner(null);
        } catch (err) {
          host.setStatus('Not saved', 'err');
          host.banner(err.message, err.body && err.body.changed ? [{ label: 'Reload latest (discard my changes)', run: () => host.reopen() }] : null);
          saving = false;
          return;
        }
        saving = false;
        refreshStatus();
      }

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
