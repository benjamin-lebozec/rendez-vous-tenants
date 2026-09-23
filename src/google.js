// Accès Google Agenda : authentification (OAuth ou compte de service), free/busy, création d'événement.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { calendar as gcalendar } from '@googleapis/calendar';
import { OAuth2Client, JWT } from 'google-auth-library';
import { env, oauthRedirectUri } from './env.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'openid',
  'email',
];

export class NotConnectedError extends Error {}

// ---------------------------------------------------------------------------
// Stockage des refresh tokens OAuth (volume DATA_DIR)
// ---------------------------------------------------------------------------
const tokensDir = path.join(env.dataDir, 'tokens');

function tokenFile(account) {
  return path.join(tokensDir, `${account.toLowerCase().replace(/[^a-z0-9@._-]/g, '_')}.json`);
}

export function loadStoredToken(account) {
  try {
    return JSON.parse(fs.readFileSync(tokenFile(account), 'utf8'));
  } catch {
    return null;
  }
}

export function saveStoredToken(account, data) {
  fs.mkdirSync(tokensDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile(account), JSON.stringify({ ...data, account, saved_at: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });
  clients.delete(account);
}

// ---------------------------------------------------------------------------
// Clients authentifiés
// ---------------------------------------------------------------------------
let serviceAccountKey;
function getServiceAccountKey() {
  if (serviceAccountKey === undefined) {
    if (env.serviceAccountJson) serviceAccountKey = JSON.parse(env.serviceAccountJson);
    else if (env.serviceAccountFile) serviceAccountKey = JSON.parse(fs.readFileSync(env.serviceAccountFile, 'utf8'));
    else serviceAccountKey = null;
  }
  return serviceAccountKey;
}

export function authMode() {
  return env.serviceAccountFile || env.serviceAccountJson ? 'service_account' : 'oauth';
}

export function newOAuthClient() {
  if (!env.googleClientId || !env.googleClientSecret) {
    throw new NotConnectedError('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET non définis');
  }
  return new OAuth2Client({
    clientId: env.googleClientId,
    clientSecret: env.googleClientSecret,
    redirectUri: oauthRedirectUri,
  });
}

const clients = new Map(); // clé: account -> { key, api }

/** Retourne un client Calendar authentifié au nom de l'organisateur du tenant. */
export function calendarFor(organizer) {
  const { account } = organizer;
  let auth;
  let cacheKey;

  if (authMode() === 'service_account') {
    cacheKey = 'sa';
    const key = getServiceAccountKey();
    auth = () =>
      new JWT({ email: key.client_email, key: key.private_key, scopes: SCOPES.slice(0, 2), subject: account });
  } else {
    const refreshToken = organizer.refresh_token || loadStoredToken(account)?.refresh_token;
    if (!refreshToken) {
      throw new NotConnectedError(`le compte Google ${account} n'est pas connecté (voir /admin)`);
    }
    cacheKey = refreshToken;
    auth = () => {
      const c = newOAuthClient();
      c.setCredentials({ refresh_token: refreshToken });
      return c;
    };
  }

  const cached = clients.get(account);
  if (cached && cached.key === cacheKey) return cached.api;
  const api = gcalendar({ version: 'v3', auth: auth() });
  clients.set(account, { key: cacheKey, api });
  return api;
}

// ---------------------------------------------------------------------------
// Free/busy
// ---------------------------------------------------------------------------
const fbCache = new Map();

export function invalidateFreeBusy(slug) {
  for (const k of fbCache.keys()) if (k.startsWith(`${slug}|`)) fbCache.delete(k);
}

/**
 * Périodes occupées cumulées de tous les agendas à vérifier (organisateur + calendars[check]).
 * Échoue si un agenda n'est pas lisible : mieux vaut ne rien proposer que proposer un faux créneau.
 */
export async function getBusy(tenant, timeMin, timeMax, { useCache = true } = {}) {
  if (env.demoMode) return demoBusy(timeMin, timeMax);
  const key = `${tenant.slug}|${timeMin}|${timeMax}`;
  const hit = fbCache.get(key);
  if (useCache && hit && hit.expires > Date.now()) return hit.value;

  const ids = [
    tenant.organizer.calendar_id,
    ...tenant.calendars.filter((c) => c.check).map((c) => c.id),
  ];
  const uniqueIds = [...new Set(ids)];
  const api = calendarFor(tenant.organizer);
  const { data } = await api.freebusy.query({
    requestBody: {
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      items: uniqueIds.map((id) => ({ id })),
    },
  });

  const busy = [];
  for (const id of uniqueIds) {
    const cal = data.calendars?.[id];
    if (!cal || cal.errors?.length) {
      const reason = cal?.errors?.map((e) => e.reason).join(', ') || 'absent de la réponse';
      throw new Error(`agenda "${id}" illisible (${reason}) — vérifiez le partage avec ${tenant.organizer.account}`);
    }
    for (const b of cal.busy || []) busy.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
  }
  busy.sort((a, b) => a.start - b.start);

  if (useCache) {
    fbCache.set(key, { value: busy, expires: Date.now() + env.freeBusyCacheSeconds * 1000 });
    if (fbCache.size > 500) fbCache.delete(fbCache.keys().next().value);
  }
  return busy;
}

/** Nombre de RDV déjà pris via ce tenant, par jour (fuseau du tenant) — pour max_per_day. */
export async function countBookingsPerDay(tenant, timeMin, timeMax) {
  if (env.demoMode) return {};
  const api = calendarFor(tenant.organizer);
  const counts = {};
  let pageToken;
  do {
    const { data } = await api.events.list({
      calendarId: tenant.organizer.calendar_id,
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      privateExtendedProperty: [`rdv_tenant=${tenant.slug}`],
      singleEvents: true,
      maxResults: 250,
      timeZone: tenant.rules.timezone,
      pageToken,
    });
    for (const ev of data.items || []) {
      if (ev.status === 'cancelled' || !ev.start?.dateTime) continue;
      const day = ev.start.dateTime.slice(0, 10); // dateTime renvoyé dans le fuseau demandé
      counts[day] = (counts[day] || 0) + 1;
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return counts;
}

// ---------------------------------------------------------------------------
// Création de l'événement
// ---------------------------------------------------------------------------
export function renderTemplate(tpl, vars) {
  if (!tpl) return tpl;
  return String(tpl)
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] ?? '').toString())
    .trim();
}

export async function createBooking(tenant, { start, end, guest }) {
  const vars = { ...guest, title: tenant.title, slug: tenant.slug };
  const attendees = [
    ...tenant.calendars.filter((c) => c.invite).map((c) => ({ email: c.id })),
    { email: guest.email, displayName: `${guest.first_name} ${guest.last_name}` },
  ];
  // dédoublonnage (ex. l'invité est aussi un collègue)
  const seen = new Set([tenant.organizer.account.toLowerCase()]);
  const uniqueAttendees = attendees.filter((a) => {
    const k = a.email.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const ev = tenant.event;
  const requestBody = {
    summary: renderTemplate(ev.summary, vars),
    description: renderTemplate(ev.description, vars),
    location: ev.location ? renderTemplate(ev.location, vars) : undefined,
    start: { dateTime: new Date(start).toISOString(), timeZone: tenant.rules.timezone },
    end: { dateTime: new Date(end).toISOString(), timeZone: tenant.rules.timezone },
    attendees: uniqueAttendees,
    guestsCanSeeOtherGuests: ev.guests_can_see_other_guests,
    guestsCanModify: ev.guests_can_modify,
    guestsCanInviteOthers: ev.guests_can_invite_others,
    extendedProperties: {
      private: { rdv_tenant: tenant.slug, rdv_phone: guest.phone },
    },
  };
  if (ev.conference === 'google_meet') {
    requestBody.conferenceData = {
      createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
    };
  }

  if (env.demoMode) {
    demoBookings.push({ start, end });
    return { id: `demo-${demoBookings.length}`, htmlLink: null, meetUrl: 'https://meet.google.com/abc-defg-hij' };
  }

  const api = calendarFor(tenant.organizer);
  const { data } = await api.events.insert({
    calendarId: tenant.organizer.calendar_id,
    conferenceDataVersion: 1,
    sendUpdates: 'all',
    requestBody,
  });
  return {
    id: data.id,
    htmlLink: data.htmlLink,
    meetUrl: data.hangoutLink || data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri || null,
  };
}

// ---------------------------------------------------------------------------
// Mode démo : une réunion fictive chaque jour à 10h (UTC) + les RDV pris
// ---------------------------------------------------------------------------
const demoBookings = [];
function demoBusy(timeMin, timeMax) {
  const busy = [...demoBookings];
  for (let d = Math.floor(timeMin / 86_400_000) * 86_400_000; d < timeMax; d += 86_400_000) {
    busy.push({ start: d + 10 * 3_600_000, end: d + 11 * 3_600_000 });
  }
  return busy.sort((a, b) => a.start - b.start);
}
