// Protection des pages par mot de passe : cookie signé (HMAC), un par tenant.
import crypto from 'node:crypto';

const SESSION_DAYS = 30;

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

export function cookieName(slug) {
  return `rdv_${slug.replace(/-/g, '_')}`;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function checkPassword(tenant, candidate) {
  return crypto.timingSafeEqual(sha256(candidate ?? ''), sha256(tenant.password));
}

// La signature dépend du mot de passe : le changer dans config.yaml invalide les sessions existantes.
function sign(secret, tenant, exp) {
  return crypto.createHmac('sha256', secret).update(`${tenant.slug}|${exp}|${tenant.password}`).digest('base64url');
}

export function createSessionToken(secret, tenant, now = Date.now()) {
  const exp = now + SESSION_DAYS * 86_400_000;
  return `${exp}.${sign(secret, tenant, exp)}`;
}

export function isSessionValid(secret, tenant, token, now = Date.now()) {
  const [expStr, sig] = String(token || '').split('.');
  const exp = Number(expStr);
  if (!sig || !(exp > now)) return false;
  const expected = sign(secret, tenant, exp);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

/** true si la page est publique ou si la requête porte une session valide. */
export function hasAccess(secret, tenant, req) {
  if (!tenant.password) return true;
  return isSessionValid(secret, tenant, parseCookies(req.headers.cookie)[cookieName(tenant.slug)]);
}

export function sessionCookie(tenant, token, secure) {
  return [
    `${cookieName(tenant.slug)}=${token}`,
    'Path=/',
    `Max-Age=${SESSION_DAYS * 86_400}`,
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}
