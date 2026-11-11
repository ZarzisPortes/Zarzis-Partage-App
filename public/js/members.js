// Left side: who am I, and who is in the room (grouped by role, like Discord).
(() => {
  'use strict';
  const { $, h, api, toast, state, roleChip, PERM_LABELS } = ZP;

  const ORDER_CHIEF = 'chief';

  function roleById(id) {
    return state.roles.find((r) => r.id === id);
  }

  // The highest role decides the group and the colour of the name.
  function rankedRoles(member) {
    const roles = member.roleIds.map(roleById).filter(Boolean);
    roles.sort((a, b) => (a.id === ORDER_CHIEF ? -1 : b.id === ORDER_CHIEF ? 1 : a.name.localeCompare(b.name)));
    return roles;
  }

  function avatar(member, color) {
    if (member.picture) {
      const img = h('img', { class: 'm-avatar', src: member.picture, alt: '', referrerpolicy: 'no-referrer' });
      img.onerror = () => img.replaceWith(initial(member, color));
      return img;
    }
    return initial(member, color);
  }
  function initial(member, color) {
    return h('span', { class: 'm-avatar m-initial', style: 'background:' + color, text: (member.nickname || member.email)[0].toUpperCase() });
  }

  function renderMe() {
    const me = state.me;
    if (!me) return;
    const mine = state.members.find((m) => m.email === me.email) || { roleIds: state.access.roleIds.filter((id) => id !== 'member'), nickname: me.nickname, email: me.email, picture: me.picture };
    const roles = rankedRoles(mine);
    const top = roles[0] || roleById('member') || { color: '#667085', name: 'Member' };
    const perms = state.access.permissions;

    $('me-card').replaceChildren(
      h('div', { class: 'me-top' },
        avatar({ nickname: me.nickname, email: me.email, picture: me.picture }, top.color),
        h('div', { class: 'me-id' },
          h('strong', { style: 'color:' + top.color, text: me.nickname || me.email }),
          h('span', { text: me.email }))),
      h('div', { class: 'me-label', text: 'Your roles' }),
      h('div', { class: 'chips' }, (roles.length ? roles : [roleById('member') || { name: 'Member', color: '#667085' }]).map(roleChip)),
      h('div', { class: 'me-label', text: 'What you can do' }),
      h('ul', { class: 'perm-list' }, Object.entries(PERM_LABELS).map(([k, label]) => h('li', { class: perms[k] ? 'ok' : 'no' }, h('i', { text: perms[k] ? '✓' : '✕' }), label)))
    );
  }

  function renderMembers() {
    const online = new Set(state.online);
    const groups = new Map();
    for (const m of state.members) {
      const top = rankedRoles(m)[0] || roleById('member') || { id: 'member', name: 'Member', color: '#667085' };
      if (!groups.has(top.id)) groups.set(top.id, { role: top, list: [] });
      groups.get(top.id).list.push(m);
    }
    const ordered = Array.from(groups.values()).sort((a, b) => {
      const rank = (r) => (r.id === ORDER_CHIEF ? 0 : r.id === 'member' ? 2 : 1);
      return rank(a.role) - rank(b.role) || a.role.name.localeCompare(b.role.name);
    });

    $('members').replaceChildren(
      ...ordered.map((g) => {
        g.list.sort((a, b) => (online.has(b.email) - online.has(a.email)) || a.nickname.localeCompare(b.nickname));
        const onlineCount = g.list.filter((m) => online.has(m.email)).length;
        return h('div', { class: 'm-group' },
          h('div', { class: 'm-group-head', style: 'color:' + g.role.color }, h('i', { class: 'dot', style: 'background:' + g.role.color }), g.role.name + ' — ' + g.list.length, onlineCount ? h('span', { class: 'm-online-count', text: onlineCount + ' online' }) : null),
          ...g.list.map((m) => {
            const roles = rankedRoles(m);
            const extra = roles.slice(1);
            const isOn = online.has(m.email);
            const row = h(
              state.access.isChief ? 'button' : 'div',
              { class: 'm-row' + (isOn ? ' on' : ' off') + (state.access.isChief ? ' clickable' : ''), type: state.access.isChief ? 'button' : false, title: state.access.isChief ? 'Click to change ' + m.nickname + '’s roles' : m.email },
              h('span', { class: 'm-av-wrap' }, avatar(m, g.role.color), h('i', { class: 'presence' + (isOn ? ' on' : '') })),
              h('span', { class: 'm-name', style: 'color:' + g.role.color, text: m.nickname }),
              ...extra.map((r) => h('i', { class: 'dot', title: r.name, style: 'background:' + r.color }))
            );
            if (state.access.isChief) row.addEventListener('click', () => openAssign(m));
            return row;
          })
        );
      })
    );
    if (!state.members.length) $('members').replaceChildren(h('div', { class: 'empty small', text: 'Nobody has joined yet.' }));
  }

  // ---- assign roles (Chief): click a name, tick roles, saved immediately
  let assignEmail = null;
  function openAssign(member) {
    assignEmail = member.email;
    $('assign-title').textContent = 'Roles for ' + member.nickname;
    $('assign-sub').textContent = member.email + ' · everybody is also a Member. Changes save immediately.';
    drawAssign(member);
    if (!$('assign-dialog').open) $('assign-dialog').showModal();
  }
  function drawAssign(member) {
    const assignable = state.roles.filter((r) => r.id !== 'member');
    const box = $('assign-roles');
    box.replaceChildren(
      ...assignable.map((r) => {
        const locked = r.id === ORDER_CHIEF && member.envChief;
        const input = h('input', { type: 'checkbox', value: r.id, checked: member.roleIds.includes(r.id) ? 'checked' : false, disabled: locked ? 'disabled' : false });
        return h('label', { class: 'check' }, input, roleChip(r), locked ? h('small', { class: 'hint', text: 'set in .env' }) : null,
          h('small', { class: 'perm-sum', text: Object.keys(PERM_LABELS).filter((k) => r.permissions[k]).map((k) => PERM_LABELS[k].replace(/ files?$/, '').toLowerCase()).join(', ') || 'view only?' }));
      })
    );
    if (!assignable.length) box.replaceChildren(h('p', { class: 'hint', text: 'There are no roles yet. Press “Manage roles” to create some.' }));
    box.onchange = async () => {
      const ids = Array.from(box.querySelectorAll('input:checked')).map((i) => i.value);
      try {
        await api('/api/admin/members/' + encodeURIComponent(member.email) + '/roles', { method: 'PUT', json: { roles: ids } });
        member.roleIds = ids.concat(member.envChief && !ids.includes(ORDER_CHIEF) ? [ORDER_CHIEF] : []);
        toast('Saved roles for ' + member.nickname + '.');
        ZP.refresh();
      } catch (err) {
        toast(err.message, true);
        drawAssign(member);
      }
    };
  }
  $('assign-close').addEventListener('click', () => $('assign-dialog').close());

  function render() {
    renderMe();
    renderMembers();
    $('btn-admin').classList.toggle('hidden', !state.access.isChief);
    // keep an open assign dialog in step with fresh data
    if (assignEmail && $('assign-dialog').open) {
      const m = state.members.find((x) => x.email === assignEmail);
      if (m && !document.activeElement.closest('#assign-roles')) drawAssign(m);
    }
  }

  // Name colour + role of a person, for the chat.
  function senderInfo(email) {
    const m = state.members.find((x) => x.email === email);
    if (!m) return null;
    const top = rankedRoles(m)[0] || roleById('member') || { name: 'Member', color: '#667085' };
    return { nickname: m.nickname, role: top };
  }

  ZP.members = { render, senderInfo };
})();
