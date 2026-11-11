'use strict';
// Runs with plain Node (no packages needed):  npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sanitizeFileName, cleanNickname, inlineTypeFor, csvCell, contentDisposition } = require('../src/util');
const { Store } = require('../src/db');

// ---- file names
assert.strictEqual(sanitizeFileName('Budget 2026.xlsx'), 'Budget 2026.xlsx');
assert.strictEqual(sanitizeFileName('../../etc/passwd'), 'passwd');
assert.strictEqual(sanitizeFileName('C:\\Users\\me\\rapport.docx'), 'rapport.docx');
assert.strictEqual(sanitizeFileName('a<b>c:d"e|f?g*h.txt'), 'a_b_c_d_e_f_g_h.txt');
assert.strictEqual(sanitizeFileName('nul.txt'), '_nul.txt');
assert.strictEqual(sanitizeFileName('..'), null);
assert.strictEqual(sanitizeFileName(''), null);
assert.strictEqual(sanitizeFileName('trailing dot.'), 'trailing dot');
assert.strictEqual(sanitizeFileName('facture été.pdf'), 'facture été.pdf');
assert.ok(Buffer.byteLength(sanitizeFileName('x'.repeat(400) + '.pdf')) <= 200);
assert.ok(sanitizeFileName('x'.repeat(400) + '.pdf').endsWith('.pdf'));

// ---- nicknames
assert.strictEqual(cleanNickname('  John   from Accounting '), 'John from Accounting');
assert.strictEqual(cleanNickname('a'), null);
assert.strictEqual(cleanNickname('x'.repeat(41)), null);
assert.strictEqual(cleanNickname('<b>Hi</b>'), 'bHi/b');

// ---- inline types / csv / headers
assert.strictEqual(inlineTypeFor('x.PDF'), 'application/pdf');
assert.strictEqual(inlineTypeFor('x.html'), null);
assert.strictEqual(inlineTypeFor('x.svg'), null);
assert.strictEqual(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
assert.ok(contentDisposition('attachment', 'été.pdf').includes("filename*=UTF-8''%C3%A9t%C3%A9.pdf"));

// ---- database
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-test-'));
const file = path.join(dir, 'db.json');
let db = new Store(file);
db.upsertLogin({ email: 'Maria@Gmail.com', name: 'Maria S', picture: '' });
assert.strictEqual(db.getUser('maria@gmail.com').nickname, '');
db.setNickname('maria@gmail.com', 'Maria');
db.putFile({ name: 'Report.xlsx', size: 10, version: 1 });
assert.ok(db.getFile('report.XLSX'), 'file lookup is case-insensitive');
db.addActivity({ email: 'maria@gmail.com', nickname: 'Maria', action: 'Uploaded', file: 'Report.xlsx', size: 10 });
db.commit();

db = new Store(file); // reload from disk
assert.strictEqual(db.getUser('maria@gmail.com').nickname, 'Maria');
assert.strictEqual(db.data.activity.length, 1);
assert.strictEqual(db.data.activity[0].action, 'Uploaded');
assert.ok(db.data.activity[0].ts.endsWith('Z'));
const revBefore = db.data.rev;
db.removeFile('REPORT.xlsx');
db.addActivity({ email: 'a@b.c', nickname: 'x', action: 'Deleted', file: 'Report.xlsx' });
db.commit();
assert.ok(db.data.rev > revBefore);
assert.strictEqual(db.getFile('Report.xlsx'), null);
assert.strictEqual(db.data.activity[1].id, 2);

// ---- roles and permissions
const P = require('../src/permissions');
const roles = P.defaultRoles();
roles.r_acc = { id: 'r_acc', name: 'Accounting', color: '#123456', permissions: { upload: true, edit: true, delete: false } };
roles.r_view = { id: 'r_view', name: 'Viewer', color: '#654321', permissions: { upload: false, edit: false, delete: false } };
const chiefEmails = ['boss@gmail.com'];
const ctx = (email, rs) => P.buildContext({ email, roles: rs || [] }, roles, chiefEmails);

const boss = ctx('boss@gmail.com');
const maria = ctx('maria@gmail.com', ['r_acc']);
const john = ctx('john@gmail.com');
assert.ok(boss.chief && boss.perms.delete);
assert.ok(!maria.chief);
assert.ok(P.buildContext({ email: 'x@y.z', roles: ['chief'] }, roles, []).chief, 'chief role makes a chief');

// default: Member can do everything on unrestricted files
assert.ok(P.canModify(john, { editRoles: [] }, 'edit') && P.canModify(john, { editRoles: [] }, 'delete'));

// Chief turns Member into read-only; Accounting role grants upload+edit but not delete
roles.member.permissions = { upload: false, edit: false, delete: false };
const john2 = ctx('john@gmail.com');
const maria2 = ctx('maria@gmail.com', ['r_acc']);
assert.ok(!P.canUpload(john2) && !P.canModify(john2, { editRoles: [] }, 'edit'));
assert.ok(P.canUpload(maria2) && P.canModify(maria2, { editRoles: [] }, 'edit') && !P.canModify(maria2, { editRoles: [] }, 'delete'));

// restricted file: only listed roles (and chief); general permissions are ignored
const locked = { editRoles: ['r_acc'] };
assert.ok(P.canModify(maria2, locked, 'delete'), 'listed role may delete a restricted file');
assert.ok(!P.canModify(john2, locked, 'edit'));
roles.member.permissions = { upload: true, edit: true, delete: true };
assert.ok(!P.canModify(ctx('john@gmail.com'), locked, 'edit'), 'Member powers do not bypass a restriction');
assert.ok(P.canModify(boss, locked, 'delete'));
assert.ok(!P.canModify(ctx('v@gmail.com', ['r_view']), locked, 'edit'));
assert.ok(!P.canModify(ctx('ghost@gmail.com', ['deleted_role']), locked, 'edit'), 'unknown roles are ignored');

// ---- old databases (no roles yet) are upgraded
const oldFile = path.join(dir, 'old.json');
fs.writeFileSync(oldFile, JSON.stringify({ rev: 3, nextActivityId: 2, users: { 'a@b.c': { email: 'a@b.c', nickname: 'A' } }, files: {}, activity: [] }));
const oldDb = new Store(oldFile);
assert.ok(oldDb.data.roles.chief && oldDb.data.roles.member);
assert.deepStrictEqual(oldDb.getUser('a@b.c').roles, []);
assert.strictEqual(oldDb.hasChief([]), false);
assert.strictEqual(oldDb.hasChief(['boss@gmail.com']), true);

fs.rmSync(dir, { recursive: true, force: true });
console.log('All tests passed.');
