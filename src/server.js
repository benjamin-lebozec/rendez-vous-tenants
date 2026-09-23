import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { env, oauthRedirectUri } from './env.js';
import fs from 'node:fs';
import {
  initConfig,
  getConfig,
  readConfigText,
  saveConfigText,
  configVersion,
  isConfigWritable,
  parseConfig,
  summarize,
  listBackups,
  readBackup,
  ConfigConflictError,
  BUILTIN_DEFAULTS,
  parseRawConfig,
  dumpConfig,
} from './config.js';
import { computeSlots } from './slots.js';
import {
  SCOPES,
  NotConnectedError,
  authMode,
  newOAuthClient,
  loadStoredToken,
  saveStoredToken,
  getBusy,
  invalidateFreeBusy,
  countBookingsPerDay,
  createBooking,
} from './google.js';
import { bookingPage, homePage, notFoundPage, adminPage, checkPage, loginPage, configEditorPage, configFormPage } from './views.js';
import { checkPassword, createSessionToken, hasAccess, sessionCookie } from './access.js';

const log = {
  info: (...a) => console.log(new Date().toISOString(), 'INFO', ...a),
  warn: (...a) => console.warn(new Date().toISOString(), 'WARN', ...a),
  error: (...a) => console.error(new Date().toISOString(), 'ERROR', ...a),
};


const sessionSecret = env.sessionSecret || crypto.randomBytes(32).toString('hex');
const secureCookies = env.baseUrl.startsWith('https://');

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

initConfig(
  {
    path: env.configPath,
    backupDir: path.join(env.dataDir, 'config-backups'),
    // dans l'image Docker, l'exemple est hors du dossier config/ (qui est monté)
    template: [path.join(root, 'config.example.yaml'), path.join(root, 'config', 'config.example.yaml')].find((f) =>
      fs.existsSync(f),
    ),
  },
  log,
);
const app = express();
app.disable('x-powered-by');
if (env.trustProxy) app.set('trust proxy', true);

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});
app.use('/static', express.static(path.join(root, 'public'), { maxAge: '1h' }));

const DAY = 86_400_000;

/** Tenant de l'URL, ou null après avoir répondu 404 / 401 (page protégée sans session). */
function tenantOr404(req, res) {
  const t = getConfig().tenants.get(req.params.slug);
  if (!t) {
    res.status(404).json({ error: 'Page introuvable' });
    return null;
  }
  if (!hasAccess(sessionSecret, t, req)) {
    res.status(401).json({ error: 'Session expirée, rechargez la page.' });
    return null;
  }
  return t;
}

function apiError(res, e, context) {
  if (e instanceof NotConnectedError) {
    log.error(`${context}: ${e.message}`);
    return res.status(503).json({ error: 'Prise de rendez-vous momentanément indisponible.' });
  }
  log.error(`${context}:`, e?.response?.data?.error?.message || e.message);
  return res.status(502).json({ error: 'Impossible de joindre Google Agenda, réessayez dans un instant.' });
}

/** Plage élargie et alignée sur des jours UTC, pour que le cache free/busy soit réutilisable. */
function busyWindow(from, to) {
  return [Math.floor(from / DAY) * DAY - DAY, Math.ceil(to / DAY) * DAY + DAY];
}

async function loadAvailability(tenant, from, to, { useCache }) {
  const [bMin, bMax] = busyWindow(from, to);
  const [busy, bookingsPerDay] = await Promise.all([
    getBusy(tenant, bMin, bMax, { useCache }),
    tenant.rules.max_per_day ? countBookingsPerDay(tenant, bMin, bMax) : {},
  ]);
  return { busy, bookingsPerDay };
}

// ---------------------------------------------------------------------------
// API publique
// ---------------------------------------------------------------------------
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/api/t/:slug/slots', async (req, res) => {
  const tenant = tenantOr404(req, res);
  if (!tenant) return;
  const duration = parseInt(req.query.duration, 10) || tenant.durations[0];
  if (!tenant.durations.includes(duration)) return res.status(400).json({ error: 'Durée invalide' });

  const now = Date.now();
  let from = Date.parse(req.query.from);
  let to = Date.parse(req.query.to);
  if (Number.isNaN(from) || Number.isNaN(to)) return res.status(400).json({ error: 'Paramètres from/to invalides' });
  from = Math.max(from, now);
  to = Math.min(to, from + 62 * DAY, now + (tenant.rules.max_days_ahead + 2) * DAY);
  if (from >= to) return res.json({ duration, slots: [] });

  try {
    const { busy, bookingsPerDay } = await loadAvailability(tenant, from, to, { useCache: true });
    const slots = computeSlots({ rules: tenant.rules, duration, busy, from, to, now, bookingsPerDay });
    res.set('Cache-Control', 'no-store');
    res.json({
      duration,
      slots: slots.map((s) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() })),
    });
  } catch (e) {
    apiError(res, e, `slots ${tenant.slug}`);
  }
});

// Anti-abus minimal en mémoire
const hits = new Map();
function rateLimited(key, limit = env.bookingRateLimit) {
  const now = Date.now();
  const windowMs = env.bookingRateWindowMinutes * 60_000;
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 10_000) hits.delete(hits.keys().next().value);
  return list.length > limit;
}

// Sérialise les réservations par organisateur pour éviter les doubles réservations concurrentes
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(key, run);
  run.finally(() => locks.get(key) === run && locks.delete(key)).catch(() => {});
  return run;
}

const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[a-z]{2,}$/i;

function validateGuest(body, tenant) {
  const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  const g = {
    first_name: clean(body.first_name, 100),
    last_name: clean(body.last_name, 100),
    email: clean(body.email, 200).toLowerCase(),
    phone: clean(body.phone, 30),
    message: tenant.form.message === 'hidden' ? '' : String(body.message ?? '').trim().slice(0, 2000),
  };
  const errors = {};
  if (!g.first_name) errors.first_name = 'Prénom requis';
  if (!g.last_name) errors.last_name = 'Nom requis';
  if (!EMAIL_RE.test(g.email)) errors.email = 'Email invalide';
  if (!/^\+?[0-9 ().-]{6,30}$/.test(g.phone) || g.phone.replace(/\D/g, '').length < 6) errors.phone = 'Téléphone invalide';
  if (tenant.form.message === 'required' && !g.message) errors.message = 'Message requis';
  return { guest: g, errors };
}

app.post('/api/t/:slug/book', express.json({ limit: '16kb' }), async (req, res) => {
  const tenant = tenantOr404(req, res);
  if (!tenant) return;
  const body = req.body || {};

  if (body.website) return res.status(400).json({ error: 'Requête refusée' }); // pot de miel
  if (rateLimited(`book|${req.ip}`)) return res.status(429).json({ error: 'Trop de tentatives, réessayez plus tard.' });

  const { guest, errors } = validateGuest(body, tenant);
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Formulaire incomplet', fields: errors });

  const duration = parseInt(body.duration, 10) || tenant.durations[0];
  const start = Date.parse(body.start);
  if (!tenant.durations.includes(duration) || Number.isNaN(start)) {
    return res.status(400).json({ error: 'Créneau invalide' });
  }

  try {
    const result = await withLock(tenant.organizer.account, async () => {
      // revérification sans cache juste avant de créer l'événement
      const now = Date.now();
      const { busy, bookingsPerDay } = await loadAvailability(tenant, start, start + DAY, { useCache: false });
      const ok = computeSlots({ rules: tenant.rules, duration, busy, from: start, to: start + 1, now, bookingsPerDay })
        .some((s) => s.start === start);
      if (!ok) return null;
      const booking = await createBooking(tenant, { start, end: start + duration * 60_000, guest });
      invalidateFreeBusy(tenant.slug);
      return booking;
    });
    if (!result) return res.status(409).json({ error: "Ce créneau n'est plus disponible, merci d'en choisir un autre." });

    log.info(`RDV créé [${tenant.slug}] ${new Date(start).toISOString()} ${guest.email} (event ${result.id})`);
    res.json({
      start: new Date(start).toISOString(),
      end: new Date(start + duration * 60_000).toISOString(),
      meet_url: result.meetUrl,
    });
  } catch (e) {
    apiError(res, e, `book ${tenant.slug}`);
  }
});

// ---------------------------------------------------------------------------
// Administration (HTTP Basic, utilisateur quelconque + ADMIN_PASSWORD)
// ---------------------------------------------------------------------------
function adminAuth(req, res, next) {
  if (!env.adminPassword) return res.status(404).send(notFoundPage());
  const [scheme, value] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && value) {
    const pass = Buffer.from(value, 'base64').toString().split(':').slice(1).join(':');
    const a = crypto.createHash('sha256').update(pass).digest();
    const b = crypto.createHash('sha256').update(env.adminPassword).digest();
    if (crypto.timingSafeEqual(a, b)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="admin", charset="UTF-8"').status(401).send('Authentification requise');
}

function connectionStatuses(tenants) {
  const statuses = new Map();
  for (const t of tenants) {
    const ok = env.demoMode || authMode() === 'service_account' || !!t.organizer.refresh_token || !!loadStoredToken(t.organizer.account)?.refresh_token;
    statuses.set(t.organizer.account, statuses.get(t.organizer.account) || ok);
  }
  return statuses;
}

app.get('/admin', adminAuth, (req, res) => {
  const tenants = [...getConfig().tenants.values()];
  const flash = req.query.connected ? `Compte ${req.query.connected} connecté.` : req.query.error || '';
  res.send(adminPage({ tenants, statuses: connectionStatuses(tenants), mode: authMode(), flash, redirectUri: oauthRedirectUri }));
});

app.get('/admin/check/:slug', adminAuth, async (req, res) => {
  const t = getConfig().tenants.get(req.params.slug);
  if (!t) return res.status(404).send(notFoundPage());
  const lines = [];
  const now = Date.now();
  try {
    const busy = await getBusy(t, now, now + 7 * DAY, { useCache: false });
    lines.push([true, `Free/busy OK sur ${1 + t.calendars.filter((c) => c.check).length} agenda(s), ${busy.length} période(s) occupée(s) sur 7 jours`]);
    const slots = computeSlots({ rules: t.rules, duration: t.durations[0], busy, from: now, to: now + 7 * DAY, now });
    lines.push([slots.length > 0, `${slots.length} créneau(x) de ${t.durations[0]} min proposé(s) sur 7 jours`]);
    if (t.rules.max_per_day) {
      await countBookingsPerDay(t, now, now + DAY);
      lines.push([true, 'Lecture des événements (max_per_day) OK']);
    }
  } catch (e) {
    lines.push([false, e?.response?.data?.error?.message || e.message]);
  }
  res.send(checkPage(t, lines));
});


// --- Édition de la configuration --------------------------------------------
// Protection CSRF : les écritures passent par fetch() en JSON (pré-vol CORS obligatoire
// depuis un autre site) et l'en-tête Origin, s'il est présent, doit être le nôtre.
function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  const allowed = [env.baseUrl, `${req.protocol}://${req.get('host')}`];
  if (origin && !allowed.includes(origin)) return res.status(403).json({ error: 'Origine refusée' });
  if (!req.is('application/json')) return res.status(415).json({ error: 'JSON attendu' });
  next();
}

const adminJson = express.json({ limit: '1mb' });

// Éditeur par formulaire (par défaut)
app.get('/admin/config', adminAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.send(configFormPage({ writable: isConfigWritable(), path: env.configPath }));
});

app.get('/admin/api/config', adminAuth, (req, res) => {
  const text = readConfigText();
  res.set('Cache-Control', 'no-store');
  let doc = null;
  let error = null;
  try {
    doc = parseRawConfig(text);
  } catch (e) {
    error = e.message;
  }
  res.json({ version: configVersion(text), doc, error, builtin: BUILTIN_DEFAULTS, writable: isConfigWritable(), backups: listBackups() });
});

// dryRun = vérification seule
app.post('/admin/api/config', adminAuth, sameOrigin, adminJson, (req, res) => {
  const doc = req.body?.doc;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return res.status(400).json({ ok: false, error: 'Config manquante' });
  let text;
  try {
    text = dumpConfig(doc);
    if (req.body.dryRun) return res.json({ ok: true, tenants: summarize(parseConfig(text)) });
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
  if (!isConfigWritable()) {
    return res.status(500).json({ ok: false, error: `${env.configPath} n'est pas accessible en écriture` });
  }
  try {
    const cfg = saveConfigText(text, req.body.version);
    invalidateAll();
    log.info(`config modifiée via /admin (formulaire) : ${cfg.tenants.size} tenant(s)`);
    res.json({ ok: true, version: configVersion(text), tenants: summarize(cfg), backups: listBackups() });
  } catch (e) {
    const status = e instanceof ConfigConflictError ? 409 : 400;
    res.status(status).json({ ok: false, conflict: status === 409, error: e.message });
  }
});

// Éditeur YAML brut (mode avancé)
app.get('/admin/config/yaml', adminAuth, (req, res) => {
  const text = readConfigText();
  res.set('Cache-Control', 'no-store');
  res.send(
    configEditorPage({
      text,
      version: configVersion(text),
      writable: isConfigWritable(),
      path: env.configPath,
      backups: listBackups(),
      defaultOrganizer: [...getConfig().tenants.values()][0]?.organizer.account || 'moi@exemple.com',
    }),
  );
});

app.post('/admin/config/validate', adminAuth, sameOrigin, adminJson, (req, res) => {
  try {
    res.json({ ok: true, tenants: summarize(parseConfig(String(req.body?.text ?? ''))) });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/admin/config', adminAuth, sameOrigin, adminJson, (req, res) => {
  const text = String(req.body?.text ?? '');
  if (!isConfigWritable()) {
    return res.status(500).json({ ok: false, error: `${env.configPath} n'est pas accessible en écriture` });
  }
  try {
    const cfg = saveConfigText(text, req.body?.version);
    invalidateAll();
    log.info(`config modifiée via /admin : ${cfg.tenants.size} tenant(s)`);
    res.json({ ok: true, version: configVersion(text), tenants: summarize(cfg), backups: listBackups() });
  } catch (e) {
    const status = e instanceof ConfigConflictError ? 409 : 400;
    res.status(status).json({ ok: false, conflict: status === 409, error: e.message });
  }
});

app.get('/admin/config/backups/:name', adminAuth, (req, res) => {
  try {
    res.type('text/plain').send(readBackup(req.params.name));
  } catch {
    res.status(404).send('Sauvegarde introuvable');
  }
});

const oauthStates = new Map();

app.get('/admin/oauth/start', adminAuth, (req, res) => {
  let client;
  try {
    client = newOAuthClient();
  } catch (e) {
    return res.redirect(`/admin?error=${encodeURIComponent(e.message)}`);
  }
  const state = crypto.randomBytes(24).toString('hex');
  oauthStates.set(state, Date.now() + 10 * 60_000);
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
    login_hint: req.query.login_hint || undefined,
  });
  res.redirect(url);
});

// Pas de Basic auth ici : l'accès est protégé par le "state" généré depuis /admin/oauth/start
app.get('/admin/oauth/callback', async (req, res) => {
  const { state, code, error } = req.query;
  const exp = oauthStates.get(state);
  oauthStates.delete(state);
  if (!exp || exp < Date.now()) return res.status(400).send('Lien expiré, recommencez depuis /admin');
  if (error || !code) return res.redirect(`/admin?error=${encodeURIComponent(`Connexion refusée : ${error || 'code manquant'}`)}`);
  try {
    const client = newOAuthClient();
    const { tokens } = await client.getToken(code);
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: env.googleClientId });
    const email = ticket.getPayload().email;
    if (!tokens.refresh_token) throw new Error('Google n’a pas renvoyé de refresh token');
    const missing = SCOPES.slice(0, 2).filter((s) => !String(tokens.scope).includes(s));
    if (missing.length) throw new Error(`autorisations manquantes : ${missing.join(', ')}`);
    saveStoredToken(email, { refresh_token: tokens.refresh_token, scope: tokens.scope });
    invalidateAll();
    log.info(`compte Google connecté : ${email}`);
    res.redirect(`/admin?connected=${encodeURIComponent(email)}`);
  } catch (e) {
    log.error('oauth callback:', e.message);
    res.redirect(`/admin?error=${encodeURIComponent(`Échec de connexion : ${e.message}`)}`);
  }
});

function invalidateAll() {
  for (const slug of getConfig().tenants.keys()) invalidateFreeBusy(slug);
}

// ---------------------------------------------------------------------------
// Pages publiques
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  const cfg = getConfig();
  res.send(homePage(cfg.site, [...cfg.tenants.values()].filter((t) => t.listed)));
});

app.get('/:slug', (req, res) => {
  const t = getConfig().tenants.get(req.params.slug);
  if (!t) return res.status(404).send(notFoundPage());
  res.set('Cache-Control', 'no-store');
  if (!hasAccess(sessionSecret, t, req)) return res.status(401).send(loginPage(t));
  res.send(bookingPage(t));
});

app.post('/:slug', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
  const t = getConfig().tenants.get(req.params.slug);
  if (!t) return res.status(404).send(notFoundPage());
  if (!t.password) return res.redirect(303, `/${t.slug}`);
  if (rateLimited(`login|${t.slug}|${req.ip}`, 10)) {
    return res.status(429).send(loginPage(t, 'Trop de tentatives, réessayez dans quelques minutes.'));
  }
  if (!checkPassword(t, req.body?.password)) {
    log.warn(`mot de passe incorrect [${t.slug}] depuis ${req.ip}`);
    return res.status(401).send(loginPage(t, 'Mot de passe incorrect.'));
  }
  res.set('Set-Cookie', sessionCookie(t, createSessionToken(sessionSecret, t), secureCookies));
  res.redirect(303, `/${t.slug}`);
});

app.use((req, res) => res.status(404).send(notFoundPage()));

app.listen(env.port, () => {
  log.info(`écoute sur :${env.port} — ${env.baseUrl} (auth Google : ${env.demoMode ? 'DÉMO, aucun appel Google' : authMode()})`);
  if (!env.adminPassword) log.warn('ADMIN_PASSWORD non défini : /admin désactivé');
  if (!env.sessionSecret) log.warn('SESSION_SECRET non défini : les visiteurs des pages protégées devront ressaisir le mot de passe après chaque redémarrage');
  if (authMode() === 'oauth' && (!env.googleClientId || !env.googleClientSecret)) {
    log.warn('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET non définis');
  }
});
