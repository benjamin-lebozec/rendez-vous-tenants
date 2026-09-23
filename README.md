# rendez-vous-tenants

Pages de prise de rendez-vous basées sur les disponibilités d'un ou plusieurs agendas Google.

- **Multi-pages** : chaque page (`/<slug>`) a ses agendas, ses horaires, ses durées, son formulaire et son style.
- **Mot de passe par page** (optionnel) : `password: ""` = page publique.
- **Disponibilités croisées** : un créneau n'est proposé que si **tous** les agendas vérifiés sont libres (le vôtre + ceux de vos collègues).
- **Réservation** : nom, prénom, email et téléphone obligatoires. L'événement est créé dans votre agenda avec vos collègues et le visiteur en invités (Google envoie les invitations), avec un **lien Google Meet** par défaut.
- **Réglages proches de Google Agenda** : horaires hebdomadaires, horaires à une date précise, durées, pas entre créneaux, temps tampon avant/après, délai de prévenance, fenêtre de réservation, max de RDV par jour.
- Horaires affichés dans le fuseau du visiteur. Nouvelle vérification juste avant la création, pour éviter les doubles réservations.

## Démarrage rapide

```bash
cp .env.example .env                              # variables communes
docker compose up -d --build                      # config/config.yaml est créé depuis l'exemple s'il manque
```

Essai sans Google : `DEMO_MODE=true` dans `.env`, puis ouvrir http://localhost:3000/demo-equipe.

## Accès Google

### Option A — OAuth (Gmail ou Workspace)

1. Dans [Google Cloud Console](https://console.cloud.google.com/) : créer un projet et activer **Google Calendar API**.
2. *Écran de consentement OAuth* : type « Externe » (ou « Interne » en Workspace), ajouter les scopes
   `calendar.events` et `calendar.freebusy`. Passez l'application **en production** : en mode « Test », les refresh tokens expirent au bout de 7 jours.
3. *Identifiants → ID client OAuth → Application Web*, URI de redirection autorisée :
   `https://<BASE_URL>/admin/oauth/callback`
4. Renseigner `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BASE_URL` et `ADMIN_PASSWORD` dans `.env`.
5. Ouvrir `https://<BASE_URL>/admin` (utilisateur quelconque + `ADMIN_PASSWORD`) et cliquer **Connecter** pour chaque compte organisateur. Le refresh token est stocké dans le volume `/data`.
6. Bouton **Tester** : vérifie que chaque agenda de la page est lisible et compte les créneaux proposés.

Plutôt que de passer par `/admin`, vous pouvez aussi fournir un refresh token directement :
`organizer.refresh_token: ${GOOGLE_REFRESH_TOKEN_MOI}` dans la config.

### Option B — Workspace, compte de service

Compte de service avec **délégation au niveau du domaine** sur les scopes
`https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/calendar.freebusy`.
Monter la clé JSON et définir `GOOGLE_SERVICE_ACCOUNT_FILE`. Le service agit au nom de chaque `organizer.account`, sans connexion manuelle.

### Agendas des collègues

Le compte organisateur doit pouvoir **voir au minimum les disponibilités (libre/occupé)** de chaque agenda listé dans `calendars` : partage explicite, ou partage par défaut au sein du domaine Workspace. Si un agenda est illisible, la page ne propose aucun créneau (plutôt que de proposer un faux créneau) et l'erreur apparaît dans les logs et dans `/admin` → Tester.

Les collègues reçoivent une invitation : l'événement apparaît dans leur agenda comme n'importe quelle réunion.

## Configuration

| Où | Quoi |
|---|---|
| `.env` | commun : URL publique, identifiants Google, mot de passe admin, anti-abus |
| `config/config.yaml` | les pages et leurs réglages : modifiable dans **`/admin/config`** ou directement (relu à chaud) |

Toutes les options sont commentées dans [`config/config.example.yaml`](config/config.example.yaml). En résumé :

```yaml
defaults:            # appliqué à toutes les pages (fusion profonde)
  timezone: Europe/Paris
  durations: [30]
  min_notice: 4h
  weekly_hours: { mon: ["09:00-12:00", "14:00-18:00"], ... }

tenants:
  demo-equipe:                         # -> https://<BASE_URL>/demo-equipe
    title: Démo produit
    organizer: { account: moi@exemple.com }
    calendars:
      - alice@exemple.com              # dispo vérifiée + invitée
      - { id: salle@group.calendar.google.com, invite: false }  # dispo uniquement
      - { id: manager@exemple.com, check: false }               # invitée uniquement
    durations: [45, 60]
    event: { conference: google_meet }
```

### Édition depuis l'admin

`/admin` → **Modifier la configuration** ouvre un éditeur par formulaire :
- à gauche, **Paramètres communs** (appliqués à toutes les pages) et la liste des pages, **+ Nouvelle page**, et pour chaque page : Dupliquer / Supprimer / Voir la page ;
- par onglets : **Général** (adresse, titre, description, mot de passe, apparence), **Agendas** (organisateur, collègues : bloque les créneaux / invité), **Créneaux** (durées, intervalle, temps libre, prévenance, horizon, max par jour, fuseau), **Disponibilités** (horaires par jour, dates fermées ou à horaires spécifiques), **Formulaire & invitation** ;
- un champ vide = valeur héritée des paramètres communs (affichée en grisé) ;
- **Vérifier** / **Enregistrer** (Ctrl+S) : une config invalide est refusée avec le champ en cause ; sinon elle est appliquée immédiatement et l'ancienne version est gardée dans `/data/config-backups` (30 dernières).

L'enregistrement depuis le formulaire réécrit le fichier : les commentaires YAML ne sont pas conservés. Les valeurs `${VAR}` le sont. Un éditeur YAML brut reste disponible (`/admin/config/yaml`), notamment pour restaurer une sauvegarde. Si le fichier a été modifié ailleurs entre-temps, l'enregistrement est refusé plutôt que d'écraser.

Le dossier `config/` doit être accessible en écriture par le conteneur (utilisateur `node`, uid 1000). Si besoin : `sudo chown 1000 config config/config.yaml`.

### Pages protégées par mot de passe

```yaml
tenants:
  clients-vip:
    password: "${CLIENTS_VIP_PASSWORD}"   # ou en clair ; vide / absent = page publique
```

Le visiteur saisit le mot de passe une fois ; une session de 30 jours est ensuite gardée dans un cookie signé propre à la page. Changer le mot de passe déconnecte toutes les sessions de cette page. Définissez `SESSION_SECRET`, sinon les visiteurs devront ressaisir le mot de passe après chaque redémarrage. Les essais sont limités à 10 par IP toutes les 15 min. Un `password` dans `defaults` protège toutes les pages ; une page peut le remplacer par `""` pour redevenir publique.

`${VAR}` / `${VAR:-défaut}` dans le YAML est remplacé par la variable d'environnement correspondante.
Les modèles `event.summary` / `event.description` / `event.location` acceptent `{{first_name}}`, `{{last_name}}`, `{{email}}`, `{{phone}}`, `{{message}}`, `{{title}}`, `{{slug}}`.

### Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `BASE_URL` | `http://localhost:PORT` | URL publique (sert à construire la redirection OAuth) |
| `PORT` | `3000` | |
| `ADMIN_PASSWORD` | — | active `/admin` |
| `SESSION_SECRET` | aléatoire | signe les sessions des pages protégées |
| `TRUST_PROXY` | `false` | `true` derrière un reverse proxy |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | option OAuth |
| `GOOGLE_SERVICE_ACCOUNT_FILE` / `_JSON` | — | option compte de service |
| `CONFIG_PATH` | `/app/config/config.yaml` | |
| `DATA_DIR` | `/data` | stockage des tokens |
| `FREEBUSY_CACHE_SECONDS` | `60` | cache des disponibilités affichées |
| `BOOKING_RATE_LIMIT` / `BOOKING_RATE_WINDOW_MINUTES` | `5` / `15` | réservations max par IP |
| `DEMO_MODE` | `false` | aucun appel Google, disponibilités simulées |

## Déploiement

Une seule image, sans état hors du volume `/data`. Mettez-la derrière un reverse proxy HTTPS (Caddy, Traefik, Nginx) avec `TRUST_PROXY=true`.

## Développement

```bash
npm install
DEMO_MODE=true npm run dev
npm test
```

## Limites connues

- Anti-abus et verrou anti-double-réservation en mémoire : prévus pour **une seule instance**.
- Annulation / report : le visiteur répond à l'invitation Google, et l'organisateur gère l'événement dans son agenda.
