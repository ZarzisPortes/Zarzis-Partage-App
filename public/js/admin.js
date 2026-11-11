// Roles and people dialog (Chief only): create roles, choose what each role may do.
(() => {
  'use strict';
  const { $, h, api, toast, roleChip, PERM_LABELS } = ZP;

  // -------------------------------------------- roles and people (Chief)
  let adminTab = 'members';
  let adminData = null;

  async function openAdmin() {
    $('admin-dialog').showModal();
    await loadAdmin();
  }
  async function loadAdmin() {
    try {
      adminData = await api('/api/admin/members');
      renderAdmin();
    } catch (err) {
      toast(err.message, true);
    }
  }
  $('btn-admin').addEventListener('click', () => { adminTab = 'roles'; openAdmin(); });
  $('admin-close').addEventListener('click', () => $('admin-dialog').close());
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => { adminTab = tab.dataset.tab; renderAdmin(); });
  }

  function renderAdmin() {
    if (!adminData) return;
    for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.tab === adminTab);
    $('admin-body').replaceChildren(...(adminTab === 'members' ? membersView() : rolesView()));
  }

  function membersView() {
    const assignable = adminData.roles.filter((r) => r.id !== 'member');
    const items = [h('p', { class: 'hint', text: 'Everyone is automatically a Member. Tick extra roles to give a person more (or different) powers. Changes save immediately.' })];
    for (const m of adminData.members) {
      const boxes = assignable.map((r) => {
        const locked = r.id === 'chief' && m.chiefByConfig;
        const input = h('input', { type: 'checkbox', value: r.id, checked: m.roles.includes(r.id) || locked ? 'checked' : false, disabled: locked ? 'disabled' : false, title: locked ? 'Chief is set in the .env file' : false });
        return h('label', { class: 'check' }, input, roleChip(r));
      });
      const box = h('div', { class: 'checks' }, boxes);
      box.addEventListener('change', async () => {
        const ids = Array.from(box.querySelectorAll('input:checked')).map((i) => i.value);
        try {
          await api('/api/admin/members/' + encodeURIComponent(m.email) + '/roles', { method: 'PUT', json: { roles: ids } });
          toast('Saved roles for ' + (m.nickname || m.email) + '.');
          ZP.refresh();
        } catch (err) {
          toast(err.message, true);
          loadAdmin();
        }
      });
      items.push(
        h(
          'div',
          { class: 'member' },
          h('div', { class: 'member-top' },
            m.picture ? h('img', { class: 'avatar', src: m.picture, alt: '', referrerpolicy: 'no-referrer' }) : null,
            h('div', null, h('strong', { text: m.nickname || m.name || m.email }), h('br'), h('span', { text: m.email }))),
          assignable.length ? box : h('span', { class: 'hint', text: 'No extra roles exist yet. Create some under “Roles”.' })
        )
      );
    }
    if (adminData.members.length === 0) items.push(h('div', { class: 'empty', text: 'Nobody has signed in yet.' }));
    return items;
  }

  function roleForm(role) {
    const isNew = !role;
    const builtin = role && role.builtin;
    const name = h('input', { type: 'text', maxlength: '30', placeholder: 'Role name, e.g. Accounting', value: role ? role.name : '', disabled: builtin ? 'disabled' : false });
    const color = h('input', { type: 'color', value: role ? role.color : '#1d4f91', disabled: builtin ? 'disabled' : false, title: 'Role colour' });
    const checks = {};
    const permBoxes = Object.entries(PERM_LABELS).map(([key, label]) => {
      const on = role ? role.permissions[key] : key !== 'delete';
      checks[key] = h('input', { type: 'checkbox', checked: on ? 'checked' : false, disabled: role && role.id === 'chief' ? 'disabled' : false });
      return h('label', { class: 'check' }, checks[key], label);
    });
    const save = h('button', { class: 'btn small', type: 'button', text: isNew ? 'Create role' : 'Save changes' });
    const actions = [save];
    if (role && !builtin) {
      actions.unshift(h('button', { class: 'btn small danger', type: 'button', text: 'Delete role', onclick: async () => {
        if (!window.confirm('Delete the role “' + role.name + '”? People lose it and files lose it from their restrictions.')) return;
        try { await api('/api/admin/roles/' + role.id, { method: 'DELETE' }); toast('Role deleted.'); await loadAdmin(); ZP.refresh(); } catch (err) { toast(err.message, true); }
      } }));
    }
    save.addEventListener('click', async () => {
      const body = { name: name.value, color: color.value, permissions: Object.fromEntries(Object.entries(checks).map(([k, el]) => [k, el.checked])) };
      try {
        if (isNew) await api('/api/admin/roles', { method: 'POST', json: body });
        else await api('/api/admin/roles/' + role.id, { method: 'PUT', json: body });
        toast(isNew ? 'Role created.' : 'Role saved.');
        await loadAdmin();
        ZP.refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
    const lockedNote = role && role.id === 'chief' ? h('p', { class: 'hint', text: 'The Chief can do everything, including managing roles and file access. This cannot be changed.' }) : null;
    const memberNote = builtin && role.id === 'member' ? h('p', { class: 'hint', text: 'Applies to everyone. Untick all to make the room view-only for people without another role.' }) : null;
    return h('div', { class: 'role-card' }, h('div', { class: 'role-form' },
      role ? roleChip(role) : h('strong', { text: 'New role' }),
      h('div', { class: 'role-row' }, name, color),
      h('div', { class: 'checks' }, permBoxes), lockedNote, memberNote,
      role && role.id === 'chief' ? null : h('div', { class: 'role-actions' }, actions)));
  }

  function rolesView() {
    const order = ['chief', 'member'];
    const sorted = adminData.roles.slice().sort((a, b) => {
      const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
      return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib) || a.name.localeCompare(b.name);
    });
    return [
      h('p', { class: 'hint', text: 'A role is a set of permissions. Give it to people on the People tab. To protect one particular file, use the “Access” button next to it.' }),
      roleForm(null),
      ...sorted.map((r) => roleForm(r)),
    ];
  }


  ZP.admin = { open: openAdmin, setTab(t) { adminTab = t; } };
})();
