'use strict';

// Discord-style roles.
//
//  * Everybody who signs in automatically has the built-in "Member" role.
//  * The chief can create more roles (e.g. "Accounting"), give each a colour and
//    permissions, and assign them to people.
//  * Permissions: view (see files and open them in the editor), download,
//    upload (add NEW files), edit (modify / replace existing files), delete,
//    and the moderation powers kick and ban (see MOD_PERMISSIONS).
//    Without "view" a person sees no files at all.
//  * A file can be restricted to certain roles. For a restricted file ONLY those
//    roles (and the chief) may replace or delete it; the general permissions
//    are ignored for that file. Everyone can still view and download it.
//  * "Chief" is a built-in role with every power, including managing roles.
//    People listed in CHIEF_EMAILS are always chief.

const FILE_PERMISSIONS = ['view', 'download', 'upload', 'edit', 'delete'];
// Moderation powers. Nobody has them unless the Chief gives them to a role.
//   kick = remove a person from the room (they may sign in again)
//   ban  = block an e-mail address from the room (and lift bans again)
const MOD_PERMISSIONS = ['kick', 'ban'];
const PERMISSIONS = [...FILE_PERMISSIONS, ...MOD_PERMISSIONS];
const CHIEF_ID = 'chief';
const MEMBER_ID = 'member';

function defaultRoles() {
  return {
    [CHIEF_ID]: {
      id: CHIEF_ID,
      name: 'Chief',
      color: '#c0392b',
      builtin: true,
      permissions: { view: true, download: true, upload: true, edit: true, delete: true, kick: true, ban: true },
    },
    [MEMBER_ID]: {
      id: MEMBER_ID,
      name: 'Member',
      color: '#667085',
      builtin: true,
      permissions: { view: true, download: true, upload: true, edit: true, delete: true, kick: false, ban: false },
    },
  };
}

function cleanPermissions(input) {
  const out = {};
  for (const p of PERMISSIONS) out[p] = !!(input && input[p]);
  return out;
}

function isChiefUser(user, chiefEmails) {
  return chiefEmails.includes(user.email) || (user.roles || []).includes(CHIEF_ID);
}

// Everything the server needs to know about what one person may do.
function buildContext(user, roles, chiefEmails) {
  const chief = isChiefUser(user, chiefEmails);
  const roleIds = [MEMBER_ID];
  for (const id of user.roles || []) if (roles[id] && !roleIds.includes(id)) roleIds.push(id);
  if (chief && !roleIds.includes(CHIEF_ID)) roleIds.push(CHIEF_ID);

  const perms = Object.fromEntries(PERMISSIONS.map((p) => [p, false]));
  for (const id of roleIds) {
    for (const p of PERMISSIONS) if (roles[id] && roles[id].permissions[p]) perms[p] = true;
  }
  if (chief) for (const p of PERMISSIONS) perms[p] = true;
  return { chief, roleIds, perms };
}

// perm is 'edit' (replace) or 'delete'.
function canModify(ctx, file, perm) {
  if (ctx.chief) return true;
  if (file && file.editRoles && file.editRoles.length) {
    return file.editRoles.some((id) => ctx.roleIds.includes(id));
  }
  return !!ctx.perms[perm];
}

function canUpload(ctx) {
  return ctx.chief || !!ctx.perms.upload;
}

// Can `actor` kick/ban `target`?  action is 'kick' or 'ban'.
// targetUser may be null (banning an e-mail that never signed in).
// Returns null when allowed, otherwise a sentence explaining why not.
function moderationDenied({ actorCtx, actorEmail, targetEmail, targetUser, roles, chiefEmails, action }) {
  const verb = action === 'ban' ? 'ban' : 'kick';
  if (!actorCtx.chief && !actorCtx.perms[action]) return 'Your role is not allowed to ' + verb + ' people.';
  if (String(targetEmail).toLowerCase() === String(actorEmail).toLowerCase()) return 'You cannot ' + verb + ' yourself.';
  if (chiefEmails.includes(String(targetEmail).toLowerCase())) return 'This person is a Chief set in the server settings and cannot be ' + verb + (verb === 'ban' ? 'ned.' : 'ed.');
  if (actorCtx.chief) return null;
  if (targetUser) {
    const tctx = buildContext(targetUser, roles, chiefEmails);
    if (tctx.chief) return 'Only a Chief can ' + verb + ' another Chief.';
    if (tctx.perms.kick || tctx.perms.ban) return 'Only a Chief can ' + verb + ' someone who can kick or ban people.';
  }
  return null;
}

module.exports = { FILE_PERMISSIONS, MOD_PERMISSIONS, moderationDenied, PERMISSIONS, CHIEF_ID, MEMBER_ID, defaultRoles, cleanPermissions, isChiefUser, buildContext, canModify, canUpload };
