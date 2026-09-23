import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionToken, isSessionValid, hasAccess, checkPassword, cookieName, sessionCookie } from '../src/access.js';
import { parseConfig } from '../src/config.js';

const secret = 's3cret';
const tenant = { slug: 'demo-equipe', password: 'hunter2' };
const req = (cookie) => ({ headers: { cookie } });

test('page sans mot de passe : accès libre', () => {
  assert.equal(hasAccess(secret, { slug: 'x', password: '' }, req()), true);
});

test('mot de passe', () => {
  assert.equal(checkPassword(tenant, 'hunter2'), true);
  assert.equal(checkPassword(tenant, 'hunter'), false);
  assert.equal(checkPassword(tenant, undefined), false);
});

test('session signée', () => {
  const token = createSessionToken(secret, tenant);
  assert.equal(hasAccess(secret, tenant, req(`other=1; ${cookieName(tenant.slug)}=${token}`)), true);
  assert.equal(hasAccess(secret, tenant, req()), false);
  // mauvaise clé, autre page, mot de passe changé, jeton altéré, jeton expiré
  assert.equal(isSessionValid('autre', tenant, token), false);
  assert.equal(isSessionValid(secret, { ...tenant, slug: 'autre' }, token), false);
  assert.equal(isSessionValid(secret, { ...tenant, password: 'nouveau' }, token), false);
  assert.equal(isSessionValid(secret, tenant, token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))), false);
  assert.equal(isSessionValid(secret, tenant, token, Date.now() + 31 * 86_400_000), false);
  assert.equal(isSessionValid(secret, tenant, 'n.importe.quoi'), false);
});

test('cookie', () => {
  const c = sessionCookie(tenant, 'tok', true);
  assert.match(c, /^rdv_demo_equipe=tok; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax; Secure$/);
  assert.doesNotMatch(sessionCookie(tenant, 'tok', false), /Secure/);
});

test('config : password hérité des défauts et surchargeable', () => {
  const cfg = parseConfig(`
defaults: { password: commun }
tenants:
  a: { organizer: x@ex.com }
  b: { organizer: x@ex.com, password: "" }
  c: { organizer: x@ex.com, password: 1234 }
`);
  assert.equal(cfg.tenants.get('a').password, 'commun');
  assert.equal(cfg.tenants.get('b').password, '');
  assert.equal(cfg.tenants.get('c').password, '1234');
});
