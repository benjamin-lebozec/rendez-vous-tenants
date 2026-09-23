// Chargement / validation de config.yaml, avec rechargement à chaud.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { load as loadYaml, dump as dumpYaml } from 'js-yaml';
import { DateTime } from 'luxon';
import { WEEKDAYS, parseTimeRange } from './slots.js';

const RESERVED_SLUGS = new Set(['admin', 'api', 'static', 'healthz', 'favicon.ico', 'robots.txt']);

export const BUILTIN_DEFAULTS = {
  timezone: 'Europe/Paris',
  durations: [30],
  slot_interval: null, // null = égal à la durée
  buffer_before: 0,
  buffer_after: 0,
  min_notice: '4h',
  max_days_ahead: 30,
  max_per_day: null,
  weekly_hours: {
    mon: ['09:00-12:00', '14:00-18:00'],
    tue: ['09:00-12:00', '14:00-18:00'],
    wed: ['09:00-12:00', '14:00-18:00'],
    thu: ['09:00-12:00', '14:00-18:00'],
    fri: ['09:00-12:00', '14:00-17:00'],
    sat: [],
    sun: [],
  },
  date_overrides: {},
  calendars: [],
  form: {
    message: 'optional', // hidden | optional | required
    message_label: 'Message (optionnel)',
  },
  event: {
    summary: 'RDV {{first_name}} {{last_name}} — {{title}}',
    description:
      'Rendez-vous pris via la page « {{title}} ».\n\n' +
      'Nom : {{first_name}} {{last_name}}\nEmail : {{email}}\nTéléphone : {{phone}}\n\n{{message}}',
    location: null,
    conference: 'google_meet', // google_meet | none
    guests_can_see_other_guests: true,
    guests_can_modify: false,
    guests_can_invite_others: false,
  },
  branding: {
    color: '#1a73e8',
    logo_url: null,
  },
  confirmation_message: 'Une invitation a été envoyée à votre adresse email.',
  listed: false,
  password: '', // vide = page publique
};

/** "${VAR}" ou "${VAR:-défaut}" dans n'importe quelle chaîne. */
function interpolate(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_, name, def) => process.env[name] ?? def ?? '');
  }
  if (Array.isArray(value)) return value.map(interpolate);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v)]));
  }
  return value;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Fusion profonde ; les tableaux et valeurs scalaires de `over` remplacent ceux de `base`. */
export function deepMerge(base, over) {
  if (over === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

/** 90 | "90" | "90m" | "4h" | "2d" -> minutes */
export function parseMinutes(v, field) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|h|d|j)?$/i.exec(String(v).trim());
  if (!m) throw new Error(`${field}: durée invalide "${v}" (ex : 30, "30m", "4h", "2d")`);
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  return Math.round(unit === 'h' ? n * 60 : unit === 'd' || unit === 'j' ? n * 1440 : n);
}

function normalizeRanges(v, field) {
  if (v === null || v === undefined || v === false) return [];
  const list = Array.isArray(v) ? v : String(v).split(',');
  const ranges = list.map((s) => String(s).trim()).filter(Boolean);
  for (const r of ranges) {
    try {
      parseTimeRange(r);
    } catch (e) {
      throw new Error(`${field}: ${e.message}`);
    }
  }
  return ranges;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeCalendar(entry, i, slug) {
  const c = typeof entry === 'string' ? { id: entry } : { ...entry };
  if (!c.id) throw new Error(`tenant "${slug}": calendars[${i}] doit avoir un "id"`);
  const looksLikeEmail = EMAIL_RE.test(c.id) && !c.id.endsWith('calendar.google.com');
  return {
    id: c.id,
    check: c.check !== false,
    // on invite par défaut les agendas qui sont des personnes (adresse email)
    invite: c.invite ?? looksLikeEmail,
  };
}

function normalizeTenant(slug, raw, defaults) {
  const where = `tenant "${slug}"`;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`${where}: slug invalide (a-z, 0-9, -)`);
  if (RESERVED_SLUGS.has(slug)) throw new Error(`${where}: slug réservé`);

  const t = deepMerge(deepMerge(BUILTIN_DEFAULTS, defaults), raw || {});
  // weekly_hours n'est pas fusionné jour par jour : un jour non listé est fermé
  t.weekly_hours = raw?.weekly_hours ?? defaults.weekly_hours ?? BUILTIN_DEFAULTS.weekly_hours;

  if (!t.title) t.title = slug;
  if (!DateTime.local().setZone(t.timezone).isValid) throw new Error(`${where}: timezone invalide "${t.timezone}"`);

  const organizer = typeof t.organizer === 'string' ? { account: t.organizer } : t.organizer;
  if (!organizer?.account) throw new Error(`${where}: "organizer.account" (email du compte Google) est requis`);

  const durations = (Array.isArray(t.durations) ? t.durations : [t.durations]).map((d) =>
    parseMinutes(d, `${where}.durations`),
  );
  if (!durations.length || durations.some((d) => !(d > 0))) throw new Error(`${where}: durations invalides`);

  const weekly = {};
  for (const d of WEEKDAYS) weekly[d] = normalizeRanges(t.weekly_hours?.[d], `${where}.weekly_hours.${d}`);
  const unknownDays = Object.keys(t.weekly_hours || {}).filter((d) => !WEEKDAYS.includes(d));
  if (unknownDays.length) throw new Error(`${where}.weekly_hours: jours inconnus ${unknownDays.join(', ')} (mon..sun)`);

  const overrides = {};
  for (const [date, v] of Object.entries(t.date_overrides || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${where}.date_overrides: date invalide "${date}"`);
    overrides[date] = normalizeRanges(v, `${where}.date_overrides.${date}`);
  }

  if (!['hidden', 'optional', 'required'].includes(t.form.message)) {
    throw new Error(`${where}.form.message: hidden | optional | required`);
  }
  if (!['google_meet', 'none'].includes(t.event.conference)) {
    throw new Error(`${where}.event.conference: google_meet | none`);
  }

  const maxDays = parseInt(t.max_days_ahead, 10);
  if (!(maxDays >= 0)) throw new Error(`${where}.max_days_ahead invalide`);

  return {
    slug,
    title: String(t.title),
    description: t.description ? String(t.description) : '',
    listed: !!t.listed,
    password: t.password === null || t.password === undefined ? '' : String(t.password),
    organizer: {
      account: organizer.account,
      calendar_id: organizer.calendar_id || 'primary',
      refresh_token: organizer.refresh_token || null,
    },
    calendars: (t.calendars || []).map((c, i) => normalizeCalendar(c, i, slug)),
    rules: {
      timezone: t.timezone,
      slot_interval: t.slot_interval ? parseMinutes(t.slot_interval, `${where}.slot_interval`) : null,
      buffer_before: parseMinutes(t.buffer_before, `${where}.buffer_before`),
      buffer_after: parseMinutes(t.buffer_after, `${where}.buffer_after`),
      min_notice: parseMinutes(t.min_notice, `${where}.min_notice`),
      max_days_ahead: maxDays,
      max_per_day: t.max_per_day ? parseInt(t.max_per_day, 10) : null,
      weekly_hours: weekly,
      date_overrides: overrides,
    },
    durations,
    form: t.form,
    event: t.event,
    branding: t.branding,
    confirmation_message: t.confirmation_message,
  };
}

export function parseConfig(text) {
  const doc = interpolate(loadYaml(text) || {});
  if (!isPlainObject(doc.tenants) || !Object.keys(doc.tenants).length) {
    throw new Error('config: la clé "tenants" doit contenir au moins un tenant');
  }
  const tenants = new Map();
  for (const [slug, raw] of Object.entries(doc.tenants)) {
    tenants.set(slug, normalizeTenant(slug, raw, doc.defaults || {}));
  }
  return { tenants, site: { title: doc.site?.title || 'Prise de rendez-vous' } };
}

/** YAML brut, sans substitution des ${VAR} : c'est ce que l'éditeur de formulaire manipule. */
export function parseRawConfig(text) {
  const doc = loadYaml(text) || {};
  if (!isPlainObject(doc)) throw new Error('config: le fichier doit contenir un objet YAML');
  return doc;
}

/** Objet de config (édité par le formulaire) -> YAML, avec site/defaults/tenants en tête. */
export function dumpConfig(doc) {
  const { site, defaults, tenants, ...rest } = doc;
  const ordered = { ...(site ? { site } : {}), ...(defaults ? { defaults } : {}), tenants, ...rest };
  return (
    '# Fichier géré depuis /admin/config — options documentées dans config.example.yaml\n' +
    dumpYaml(ordered, { lineWidth: 120, noRefs: true })
  );
}

let current = null;
let configPath = null;
let backupDir = null;
const MAX_BACKUPS = 30;

export class ConfigConflictError extends Error {}

export function getConfig() {
  return current;
}

/** Empreinte du fichier : détecte une modification concurrente entre l'ouverture de l'éditeur et l'enregistrement. */
export function configVersion(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function readConfigText() {
  return fs.readFileSync(configPath, 'utf8');
}

export function isConfigWritable() {
  try {
    fs.accessSync(configPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Résumé lisible d'une config valide (retour de "Vérifier"). */
export function summarize(cfg) {
  return [...cfg.tenants.values()].map((t) => ({
    slug: t.slug,
    title: t.title,
    organizer: t.organizer.account,
    calendars: t.calendars.length,
    protected: !!t.password,
  }));
}

/** Valide puis écrit le nouveau YAML (sauvegarde de l'ancien) et l'applique immédiatement. */
export function saveConfigText(text, expectedVersion) {
  const previous = readConfigText();
  if (expectedVersion && configVersion(previous) !== expectedVersion) {
    throw new ConfigConflictError('le fichier a été modifié entre-temps (autre onglet ou édition directe)');
  }
  const parsed = parseConfig(text); // lève une erreur si invalide : rien n'est écrit
  if (previous !== text) {
    backup(previous);
    // écriture sur place (pas de rename) pour rester compatible avec un bind mount Docker
    fs.writeFileSync(configPath, text);
  }
  current = parsed;
  return parsed;
}

function backup(text) {
  fs.mkdirSync(backupDir, { recursive: true });
  const name = `config-${new Date().toISOString().replace(/[:.]/g, '-')}.yaml`;
  fs.writeFileSync(path.join(backupDir, name), text, { mode: 0o600 });
  for (const old of listBackups().slice(MAX_BACKUPS)) fs.rmSync(path.join(backupDir, old.name), { force: true });
}

export function listBackups() {
  try {
    return fs
      .readdirSync(backupDir)
      .filter((f) => /^config-[\dT-]+Z\.yaml$/.test(f))
      .sort()
      .reverse()
      .map((name) => ({ name, size: fs.statSync(path.join(backupDir, name)).size }));
  } catch {
    return [];
  }
}

export function readBackup(name) {
  if (!/^config-[\dT-]+Z\.yaml$/.test(name)) throw new Error('nom de sauvegarde invalide');
  return fs.readFileSync(path.join(backupDir, name), 'utf8');
}

/**
 * @param {object} opts
 * @param {string} opts.path       fichier config.yaml
 * @param {string} opts.backupDir  dossier des sauvegardes
 * @param {string} [opts.template] fichier copié si config.yaml n'existe pas encore
 */
export function initConfig({ path: file, backupDir: dir, template }, log = console) {
  configPath = file;
  backupDir = dir;
  if (!fs.existsSync(file) && template && fs.existsSync(template)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(template, file);
    log.warn(`${file} absent : créé à partir de l'exemple, à personnaliser dans /admin/config`);
  }
  current = parseConfig(fs.readFileSync(file, 'utf8'));
  log.info(`config chargée : ${current.tenants.size} tenant(s) [${[...current.tenants.keys()].join(', ')}]`);
  fs.watchFile(file, { interval: 2000 }, () => {
    try {
      current = parseConfig(fs.readFileSync(file, 'utf8'));
      log.info(`config rechargée : ${current.tenants.size} tenant(s)`);
    } catch (e) {
      log.error(`config invalide, ancienne version conservée : ${e.message}`);
    }
  });
  return current;
}
