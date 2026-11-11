// Small room chat under the list of people. The sender's name and role come from
// the live member list, so a role change shows up on old messages too.
(() => {
  'use strict';
  const { $, h, api, toast, state } = ZP;

  let messages = [];
  let rev = -1;
  let fetching = false;
  let canModerate = false;

  const time = (iso) => {
    const d = new Date(iso);
    const today = new Date();
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === today.toDateString() ? hm : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + hm;
  };

  function render() {
    const list = $('chat-list');
    if (!list) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    const me = state.me && state.me.email;
    list.replaceChildren(
      ...(messages.length
        ? messages.map((m) => {
            const info = ZP.members.senderInfo(m.email);
            const color = info ? info.role.color : '#667085';
            const del = m.email === me || canModerate
              ? h('button', { class: 'chat-del', type: 'button', title: 'Delete message', 'aria-label': 'Delete message', text: '×', onclick: async () => {
                  try { await api('/api/chat/' + m.id, { method: 'DELETE' }); await load(); } catch (e) { toast(e.message, true); }
                } })
              : null;
            return h('div', { class: 'chat-msg' + (m.email === me ? ' mine' : '') },
              h('div', { class: 'chat-meta' },
                h('strong', { style: 'color:' + color, text: (info && info.nickname) || m.nickname || m.email }),
                info ? h('span', { class: 'chat-role', style: 'color:' + color + ';border-color:' + color, text: info.role.name }) : null,
                h('span', { class: 'chat-time', text: time(m.ts) }),
                del),
              h('div', { class: 'chat-text', text: m.text }));
          })
        : [h('div', { class: 'chat-empty', text: 'No messages yet. Say hello 👋' })])
    );
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  async function load() {
    if (fetching) return;
    fetching = true;
    try {
      const data = await api('/api/chat');
      messages = data.messages;
      rev = data.rev;
      canModerate = !!data.canModerate;
      render();
    } catch (_) { /* next poll retries */ } finally { fetching = false; }
  }

  function onRev(serverRev) {
    if (serverRev === undefined || serverRev === rev) return;
    load();
  }

  $('chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      await api('/api/chat', { method: 'POST', json: { text } });
      await load();
      const list = $('chat-list');
      list.scrollTop = list.scrollHeight;
    } catch (err) {
      input.value = text;
      toast(err.message, true);
    }
  });
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('chat-form').requestSubmit(); }
  });

  ZP.chat = { onRev, render };
})();
