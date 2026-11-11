'use strict';

// Discord-style roles.
//
//  * Everybody who signs in automatically has the built-in "Member" role.
//  * The chief can create more roles (e.g. "Accounting"), give each a colour and
//    permissions, and assign them to people.
//  * Permissions: view (see files and open them in the editor), download,
//    upload (add NEW files), edit (modify / replace existing files), delete.
//    Without "view" a person sees no files at all.
//  * A file can be restricted to certain roles. For a restricted file ONLY those
//    roles (and the chief) may replace or delete it; the general permissions
//    are ignored for that file. Everyone can still view and download it.
//  * "Chief" is a built-in role with every power, including managing roles.
//    People listed in CHIEF_EMAILS are always chief.

const PERMISSIONS = ['view', 'download', 'upload', 'edit', 'delete'];
const CHIEF_ID = 'chief';
const MEMBER_ID = 'member';

function defaultRoles() {
  return {
    [CHIEF_ID]: {
      id: CHIEF_ID,
      name: 'Chief',
      color: '#c0392b',
      builtin: true,
      permissions: { view: true, download: true, upload: true, edit: true, delete: true },
    },
    [MEMBER_ID]: {
      id: MEMBER_ID,
      name: 'Member',
      color: '#667085',
      builtin: true,
      permissions: { view: true, download: true, upload: true, edit: true, delete: true },
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

module.exports = { PERMISSIONS, CHIEF_ID, MEMBER_ID, defaultRoles, cleanPermissions, isChiefUser, buildContext, canModify, canUpload };
