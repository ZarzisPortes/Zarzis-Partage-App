// Left side: who am I, and who is in the room (grouped by role, like Discord).
(() => {
  'use strict';
  const { $, h, api, toast, state, roleChip, PERM_LABELS, PERM_SHORT } = ZP;

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
      h('div', { class: 'perm-chips' }, Object.keys(PERM_LABELS).map((k) => h('span', { class: 'pchip ' + (perms[k] ? 'ok' : 'no'), title: PERM_LABELS[k] + (perms[k] ? '' : ' - not allowed') },
        h('i', { text: perms[k] ? '✓' : '–' }), PERM_SHORT[k][0].toUpperCase() + PERM_SHORT[k].slice(1))))
    );
  }

  // ---- who may do what to whom (the server checks again; this only decides what to show)
  const myPerms = () => state.access.permissions || {};
  const iCan = (action) => state.access.isChief || !!myPerms()[action];
  function permsOf(member) {
    const out = {};
    for (const id of ['member', ...member.roleIds]) {
      const r = roleById(id);
      if (r) for (const [k, v] of Object.entries(r.permissions)) if (v) out[k] = true;
    }
    return out;
  }
  // null = allowed, otherwise the reason it is not.
  function modDenied(member, action) {
    if (!iCan(action)) return 'no';
    if (member.email === state.me.email) return 'self';
    if (member.envChief) return 'Chief set in the server settings';
    if (state.access.isChief) return null;
    if (member.roleIds.includes(ORDER_CHIEF)) return 'Only a Chief can ' + action + ' another Chief.';
    const p = permsOf(member);
    if (p.kick || p.ban) return 'Only a Chief can ' + action + ' someone who can kick or ban people.';
    return null;
  }
  function canManage(member) {
    if (member.email === state.me.email) return false;
    return state.access.isChief || iCan('kick') || iCan('ban');
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
            const manage = canManage(m);
            const row = h(
              manage ? 'button' : 'div',
              { class: 'm-row' + (isOn ? ' on' : ' off') + (manage ? ' clickable' : ''), type: manage ? 'button' : false, title: manage ? 'Click to manage ' + m.nickname : m.email },
              h('span', { class: 'm-av-wrap' }, avatar(m, g.role.color), h('i', { class: 'presence' + (isOn ? ' on' : '') })),
              h('span', { class: 'm-name', style: 'color:' + g.role.color, text: m.nickname }),
              ...extra.map((r) => h('i', { class: 'dot', title: r.name, style: 'background:' + r.color }))
            );
            if (manage) row.addEventListener('click', () => openAssign(m));
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
    $('assign-title').textContent = (state.access.isChief ? 'Manage ' : 'Moderate ') + member.nickname;
    $('assign-sub').textContent = member.email + (state.access.isChief ? ' · everybody is also a Member. Role changes save immediately.' : '');
    $('assign-roles-wrap').classList.toggle('hidden', !state.access.isChief);
    drawAssign(member);
    drawMod(member);
    if (!$('assign-dialog').open) $('assign-dialog').showModal();
  }

  function drawMod(member) {
    const kickWhy = modDenied(member, 'kick');
    const banWhy = modDenied(member, 'ban');
    const showKick = iCan('kick'), showBan = iCan('ban');
    $('assign-mod').classList.toggle('hidden', !(showKick || showBan));
    $('mod-kick').classList.toggle('hidden', !showKick);
    $('mod-kick').disabled = !!kickWhy;
    document.querySelector('#assign-mod .mod-ban').classList.toggle('hidden', !showBan);
    $('mod-ban').disabled = !!banWhy;
    $('mod-reason').disabled = !!banWhy;
    const why = [kickWhy, banWhy].find((x) => x && x !== 'no' && x !== 'self');
    $('assign-mod-note').textContent = why
      ? (why.startsWith('Only') ? why : 'This person is a ' + why + ' and cannot be removed.')
      : 'Kick removes ' + member.nickname + ' from the room right away (they can sign in again). Ban also blocks their e-mail address until you lift the ban.';
  }
  $('mod-kick').addEventListener('click', async () => {
    const m = state.members.find((x) => x.email === assignEmail);
    if (!m || !window.confirm('Kick ' + m.nickname + ' out of the room? They lose their nickname and roles, and can sign in again.')) return;
    try {
      await api('/api/members/' + encodeURIComponent(m.email) + '/kick', { method: 'POST', json: {} });
      toast(m.nickname + ' was kicked out.');
      $('assign-dialog').close();
      ZP.refresh();
    } catch (err) { toast(err.message, true); }
  });
  $('mod-ban').addEventListener('click', async () => {
    const m = state.members.find((x) => x.email === assignEmail);
    if (!m || !window.confirm('Ban ' + m.email + '? They are removed now and cannot sign in until the ban is lifted.')) return;
    try {
      await api('/api/bans', { method: 'POST', json: { email: m.email, reason: $('mod-reason').value } });
      toast(m.email + ' is banned.');
      $('mod-reason').value = '';
      $('assign-dialog').close();
      ZP.refresh();
    } catch (err) { toast(err.message, true); }
  });

  // ---- banned addresses
  function drawBans() {
    const list = state.bans || [];
    $('bans-empty').classList.toggle('hidden', list.length > 0);
    $('bans-list').replaceChildren(...list.map((b) => h('li', { class: 'file' },
      h('div', { class: 'ficon ban', text: '⛔' }),
      h('div', { class: 'finfo' },
        h('span', { class: 'fname', text: b.email }),
        h('div', { class: 'fmeta', text: (b.nickname ? b.nickname + ' · ' : '') + 'banned by ' + b.by + ' · ' + ZP.formatDate(b.ts) + (b.reason ? ' · “' + b.reason + '”' : '') })),
      h('div', { class: 'fact' }, h('button', { class: 'btn small', type: 'button', text: 'Lift ban', onclick: async () => {
        try { await api('/api/bans/' + encodeURIComponent(b.email), { method: 'DELETE' }); toast(b.email + ' may sign in again.'); await ZP.refresh(); } catch (err) { toast(err.message, true); }
      } })))));
  }
  $('btn-bans').addEventListener('click', () => { drawBans(); $('bans-dialog').showModal(); });
  $('bans-close').addEventListener('click', () => $('bans-dialog').close());
  $('bans-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/bans', { method: 'POST', json: { email: $('bans-email').value, reason: $('bans-reason').value } });
      toast($('bans-email').value.trim() + ' is banned.');
      $('bans-email').value = ''; $('bans-reason').value = '';
      await ZP.refresh();
    } catch (err) { toast(err.message, true); }
  });
  function drawAssign(member) {
    const assignable = state.roles.filter((r) => r.id !== 'member');
    const box = $('assign-roles');
    box.replaceChildren(
      ...assignable.map((r) => {
        const locked = r.id === ORDER_CHIEF && member.envChief;
        const input = h('input', { type: 'checkbox', value: r.id, checked: member.roleIds.includes(r.id) ? 'checked' : false, disabled: locked ? 'disabled' : false });
        return h('label', { class: 'check' }, input, roleChip(r), locked ? h('small', { class: 'hint', text: 'set in .env' }) : null,
          h('small', { class: 'perm-sum', text: Object.keys(PERM_SHORT).filter((k) => r.permissions[k]).map((k) => PERM_SHORT[k]).join(', ') || 'no powers' }));
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
    $('btn-bans').classList.toggle('hidden', !iCan('ban'));
    if ($('bans-dialog').open) drawBans();
    // keep an open assign dialog in step with fresh data
    if (assignEmail && $('assign-dialog').open) {
      const m = state.members.find((x) => x.email === assignEmail);
      if (!m) $('assign-dialog').close(); // person left the room meanwhile
      else if (!document.activeElement.closest('#assign-roles')) { drawAssign(m); drawMod(m); }
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
