// Variables d'environnement communes à tous les tenants.
import path from 'node:path';

function bool(v, def = false) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const port = parseInt(process.env.PORT || '3000', 10);

export const env = {
  port,
  baseUrl: (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  configPath: path.resolve(process.env.CONFIG_PATH || 'config/config.yaml'),
  dataDir: path.resolve(process.env.DATA_DIR || 'data'),
  trustProxy: bool(process.env.TRUST_PROXY, false),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // Clé de signature des sessions des pages protégées (aléatoire si vide : sessions perdues au redémarrage)
  sessionSecret: process.env.SESSION_SECRET || '',

  // OAuth (compte Google classique ou Workspace)
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',

  // Alternative Workspace : compte de service avec délégation au niveau du domaine
  serviceAccountFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE || '',
  serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',

  // Anti-abus : réservations max par IP et par fenêtre
  bookingRateLimit: parseInt(process.env.BOOKING_RATE_LIMIT || '5', 10),
  bookingRateWindowMinutes: parseInt(process.env.BOOKING_RATE_WINDOW_MINUTES || '15', 10),

  // Mode démo : aucun appel Google, disponibilités simulées (pour tester l'interface)
  demoMode: bool(process.env.DEMO_MODE, false),

  // Cache des disponibilités (secondes)
  freeBusyCacheSeconds: parseInt(process.env.FREEBUSY_CACHE_SECONDS || '60', 10),
};

export const oauthRedirectUri = `${env.baseUrl}/admin/oauth/callback`;
