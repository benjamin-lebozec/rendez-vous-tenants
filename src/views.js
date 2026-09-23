// Rendu HTML côté serveur (pages simples, sans moteur de template).

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function safeColor(c) {
  return /^#[0-9a-f]{3,8}$|^[a-z]+$|^rgb\([\d\s,]+\)$/i.test(String(c)) ? c : '#1a73e8';
}

// change à chaque démarrage : évite qu'un navigateur garde d'anciens CSS/JS après une mise à jour
const ASSET_VERSION = Date.now().toString(36);

function layout({ title, body, accent, head = '' }) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/static/style.css?v=${ASSET_VERSION}">
<style>:root{--accent:${safeColor(accent || '#1a73e8')}}</style>
${head}
</head>
<body>
${body}
</body>
</html>`;
}

/** Données du tenant exposées au navigateur (rien de sensible). */
export function publicTenant(t) {
  return {
    slug: t.slug,
    title: t.title,
    description: t.description,
    timezone: t.rules.timezone,
    durations: t.durations,
    max_days_ahead: t.rules.max_days_ahead,
    form: t.form,
    conference: t.event.conference,
    location: t.event.location,
    confirmation_message: t.confirmation_message,
  };
}

export function bookingPage(t) {
  const json = JSON.stringify(publicTenant(t)).replace(/</g, '\\u003c');
  const logo = t.branding.logo_url ? `<img class="logo" src="${esc(t.branding.logo_url)}" alt="">` : '';
  return layout({
    title: t.title,
    accent: t.branding.color,
    body: `
<main class="card" id="app">
  <aside class="intro">
    ${logo}
    <h1>${esc(t.title)}</h1>
    ${t.description ? `<p class="desc">${esc(t.description).replace(/\n/g, '<br>')}</p>` : ''}
    <ul class="meta">
      <li><span class="ico">⏱</span><span id="durationLabel"></span></li>
      ${t.event.conference === 'google_meet' ? '<li><span class="ico">🎥</span>Visioconférence Google Meet</li>' : ''}
      ${t.event.location ? `<li><span class="ico">📍</span>${esc(t.event.location)}</li>` : ''}
      <li><span class="ico">🌍</span><span id="tzLabel"></span></li>
    </ul>
    <div id="durationPicker" class="durations" hidden></div>
  </aside>

  <section class="step" id="stepPick">
    <h2>Choisissez un créneau</h2>
    <div class="picker">
      <div class="calendar">
        <div class="cal-head">
          <button type="button" class="nav" id="prevMonth" aria-label="Mois précédent">‹</button>
          <strong id="monthLabel"></strong>
          <button type="button" class="nav" id="nextMonth" aria-label="Mois suivant">›</button>
        </div>
        <div class="cal-grid" id="calGrid"></div>
      </div>
      <div class="slots">
        <h3 id="dayLabel">Sélectionnez une date</h3>
        <div id="slotList" class="slot-list"></div>
      </div>
    </div>
    <p class="status" id="pickStatus" role="status"></p>
  </section>

  <section class="step" id="stepForm" hidden>
    <button type="button" class="back" id="backToPick">‹ Changer de créneau</button>
    <h2>Vos coordonnées</h2>
    <p class="chosen" id="chosenLabel"></p>
    <form id="bookingForm" novalidate>
      <div class="row">
        <label>Prénom *<input name="first_name" required maxlength="100" autocomplete="given-name"></label>
        <label>Nom *<input name="last_name" required maxlength="100" autocomplete="family-name"></label>
      </div>
      <label>Email *<input name="email" type="email" required maxlength="200" autocomplete="email"></label>
      <label>Téléphone *<input name="phone" type="tel" required maxlength="30" autocomplete="tel"></label>
      ${
        t.form.message !== 'hidden'
          ? `<label>${esc(t.form.message_label)}${t.form.message === 'required' ? ' *' : ''}<textarea name="message" rows="3" maxlength="2000"${t.form.message === 'required' ? ' required' : ''}></textarea></label>`
          : ''
      }
      <label class="hp" aria-hidden="true">Site web<input name="website" tabindex="-1" autocomplete="off"></label>
      <p class="error" id="formError" role="alert"></p>
      <button type="submit" class="primary" id="submitBtn">Confirmer le rendez-vous</button>
    </form>
  </section>

  <section class="step" id="stepDone" hidden>
    <div class="done-ico">✓</div>
    <h2>Rendez-vous confirmé</h2>
    <p class="chosen" id="doneLabel"></p>
    <p id="doneMeet"></p>
    <p class="muted" id="doneMsg"></p>
  </section>
</main>
<script>window.__TENANT__ = ${json};</script>
<script src="/static/app.js?v=${ASSET_VERSION}" defer></script>`,
  });
}

export function homePage(site, tenants) {
  const items = tenants
    .map((t) => `<li><a href="/${esc(t.slug)}">${esc(t.title)}</a>${t.password ? ' 🔒' : ''}${t.description ? `<p>${esc(t.description)}</p>` : ''}</li>`)
    .join('');
  return layout({
    title: site.title,
    body: `<main class="card simple"><h1>${esc(site.title)}</h1>${items ? `<ul class="tenant-list">${items}</ul>` : '<p class="muted">Aucune page publique.</p>'}</main>`,
  });
}

export function loginPage(t, error = '') {
  const logo = t.branding.logo_url ? `<img class="logo" src="${esc(t.branding.logo_url)}" alt="">` : '';
  return layout({
    title: t.title,
    accent: t.branding.color,
    body: `<main class="card simple narrow">
      ${logo}
      <h1>${esc(t.title)}</h1>
      <p class="muted">Cette page de réservation est protégée par un mot de passe.</p>
      <form method="post" action="/${esc(t.slug)}" class="login">
        <label>Mot de passe<input type="password" name="password" required autofocus autocomplete="current-password"></label>
        ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
        <button type="submit" class="primary">Accéder</button>
      </form>
    </main>`,
  });
}

export function notFoundPage() {
  return layout({ title: 'Page introuvable', body: '<main class="card simple"><h1>Page introuvable</h1></main>' });
}

export function adminPage({ tenants, statuses, mode, flash, redirectUri }) {
  const rows = tenants
    .map((t) => {
      const st = statuses.get(t.organizer.account);
      const cals = t.calendars
        .map((c) => `${esc(c.id)}<small>${c.check ? ' · dispo' : ''}${c.invite ? ' · invité' : ''}</small>`)
        .join('<br>');
      return `<tr>
        <td><a href="/${esc(t.slug)}" target="_blank">/${esc(t.slug)}</a><br><small>${esc(t.title)}</small></td>
        <td>${esc(t.organizer.account)}<br><small>${esc(t.organizer.calendar_id)}</small></td>
        <td>${cals || '<small>—</small>'}</td>
        <td>${t.password ? '🔒 protégée' : '<small>publique</small>'}</td>
        <td>${st ? '<span class="ok">connecté</span>' : '<span class="ko">non connecté</span>'}</td>
        <td><a class="btn" href="/admin/check/${esc(t.slug)}">Tester</a></td>
      </tr>`;
    })
    .join('');

  const accounts = [...new Set(tenants.map((t) => t.organizer.account))];
  const connect =
    mode === 'oauth'
      ? `<h2>Connexion des comptes Google</h2>
         <p class="muted">URI de redirection à déclarer dans la console Google Cloud : <code>${esc(redirectUri)}</code></p>
         <ul class="accounts">${accounts
           .map(
             (a) =>
               `<li>${esc(a)} — ${statuses.get(a) ? '<span class="ok">connecté</span>' : '<span class="ko">non connecté</span>'}
                <a class="btn" href="/admin/oauth/start?login_hint=${encodeURIComponent(a)}">${statuses.get(a) ? 'Reconnecter' : 'Connecter'}</a></li>`,
           )
           .join('')}</ul>`
      : `<p class="muted">Mode compte de service (délégation au niveau du domaine) : aucune connexion manuelle nécessaire.</p>`;

  return layout({
    title: 'Administration',
    body: `<main class="card simple wide">
      <h1>Administration</h1>
      ${flash ? `<p class="flash">${esc(flash)}</p>` : ''}
      <div class="admin-head"><h2>Pages</h2><a class="btn" href="/admin/config">Modifier la configuration</a></div>
      <table class="admin"><thead><tr><th>Page</th><th>Organisateur</th><th>Agendas</th><th>Accès</th><th>Compte</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      ${connect}
    </main>`,
  });
}

export function configFormPage({ writable, path }) {
  return layout({
    title: 'Configuration',
    body: `<main class="card simple wide cfg">
      <p class="crumbs"><a href="/admin">‹ Administration</a></p>
      <div class="cfg-top">
        <h1>Configuration</h1>
        <div class="cfg-actions">
          <span class="dirty" id="dirty" hidden>modifications non enregistrées</span>
          <button type="button" class="btn" id="validate">Vérifier</button>
          <button type="button" class="primary small" id="save"${writable ? '' : ' disabled'}>Enregistrer</button>
        </div>
      </div>
      ${writable ? '' : `<p class="flash warn">Le fichier <code>${esc(path)}</code> n'est pas accessible en écriture : l'enregistrement est impossible. En Docker, montez le dossier <code>config/</code> sans <code>:ro</code>.</p>`}
      <div class="result" id="result" role="status"></div>
      <div class="cfg-layout">
        <nav class="cfg-nav" id="nav" aria-label="Pages"></nav>
        <section class="cfg-panel" id="panel"><p class="muted">Chargement…</p></section>
      </div>
      <p class="muted small-print">L'enregistrement réécrit <code>${esc(path)}</code> (les commentaires YAML ne sont pas conservés) et garde l'ancienne version en sauvegarde.
        <a href="/admin/config/yaml">Éditer le YAML brut / restaurer une sauvegarde</a></p>
    </main>
    <script src="/static/admin-form.js?v=${ASSET_VERSION}" defer></script>`,
  });
}

export function configEditorPage({ text, version, writable, path, backups, defaultOrganizer }) {
  const data = JSON.stringify({ version, defaultOrganizer }).replace(/</g, '\\u003c');
  const backupItems = backups
    .map((b) => {
      const date = b.name.replace(/^config-|\.yaml$/g, '').replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}).*/, '$1 $2:$3:$4 UTC');
      return `<li><span>${esc(date)}</span> <button type="button" class="link" data-backup="${esc(b.name)}">Charger dans l'éditeur</button></li>`;
    })
    .join('');
  return layout({
    title: 'Configuration',
    body: `<main class="card simple wide">
      <p><a href="/admin">‹ Administration</a> · <a href="/admin/config">Éditeur par formulaire</a></p>
      <h1>Configuration — YAML (avancé)</h1>
      <p class="muted">Fichier <code>${esc(path)}</code>. Chaque enregistrement est vérifié puis appliqué immédiatement ; la version précédente est sauvegardée.
        Les valeurs <code>\${VAR}</code> sont lues dans l'environnement : gardez-y les secrets. Toutes les options sont documentées dans <code>config.example.yaml</code>.</p>
      ${writable ? '' : `<p class="flash warn">Le fichier n'est pas accessible en écriture : l'enregistrement échouera. En Docker, montez le dossier <code>config/</code> sans <code>:ro</code>.</p>`}
      <div class="toolbar">
        <button type="button" class="btn" id="addTenant">+ Nouvelle page</button>
        <button type="button" class="btn" id="validate">Vérifier</button>
        <button type="button" class="primary small" id="save"${writable ? '' : ' disabled'}>Enregistrer <kbd>Ctrl+S</kbd></button>
        <span class="dirty" id="dirty" hidden>modifications non enregistrées</span>
      </div>
      <div class="result" id="result" role="status"></div>
      <textarea id="editor" class="code" spellcheck="false" autocapitalize="off" autocomplete="off">${esc(text)}</textarea>
      <h2>Sauvegardes</h2>
      <ul class="backups" id="backups">${backupItems}</ul>
      <p class="muted">${backupItems ? '' : 'Aucune sauvegarde pour l’instant. '}Charger une sauvegarde la place dans l'éditeur : il faut ensuite enregistrer pour la restaurer.</p>
    </main>
    <script>window.__CONFIG_EDITOR__ = ${data};</script>
    <script src="/static/admin-config.js?v=${ASSET_VERSION}" defer></script>`,
  });
}

export function checkPage(t, lines) {
  return layout({
    title: `Test — ${t.slug}`,
    body: `<main class="card simple wide"><h1>Test de /${esc(t.slug)}</h1>
      <ul class="check">${lines.map(([ok, msg]) => `<li class="${ok ? 'ok' : 'ko'}">${ok ? '✓' : '✗'} ${esc(msg)}</li>`).join('')}</ul>
      <p><a href="/admin">‹ Retour</a></p></main>`,
  });
}
