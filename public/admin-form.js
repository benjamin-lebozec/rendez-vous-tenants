// Éditeur de configuration par formulaire. Manipule l'objet YAML brut (les ${VAR} restent tels quels)
// et le renvoie au serveur, qui le valide, l'écrit et l'applique.
(() => {
  const $ = (id) => document.getElementById(id);
  const api = (p) => new URL(p, location.origin).href; // sans identifiants (http://user:pass@…)

  const DAYS = [
    ['mon', 'Lundi'],
    ['tue', 'Mardi'],
    ['wed', 'Mercredi'],
    ['thu', 'Jeudi'],
    ['fri', 'Vendredi'],
    ['sat', 'Samedi'],
    ['sun', 'Dimanche'],
  ];
  const RESERVED = ['admin', 'api', 'static', 'healthz', 'favicon.ico', 'robots.txt'];
  const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const state = { doc: null, builtin: null, version: null, saved: '', sel: { kind: 'defaults' }, tab: 'general' };

  // ------------------------------------------------------------------ utilitaires
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

  function set(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    const chain = [];
    for (const k of keys.slice(0, -1)) {
      if (!isObj(o[k])) o[k] = {};
      chain.push([o, k]);
      o = o[k];
    }
    const last = keys[keys.length - 1];
    if (value === undefined) delete o[last];
    else o[last] = value;
    // supprime les objets devenus vides (ex. event: {})
    for (const [parent, k] of chain.reverse()) if (isObj(parent[k]) && !Object.keys(parent[k]).length) delete parent[k];
    changed();
  }

  function merge(base, over) {
    if (over === undefined) return base;
    if (!isObj(base) || !isObj(over)) return over;
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
    return out;
  }

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const ranges = (v) => (Array.isArray(v) ? v : v ? String(v).split(',') : []).map((s) => String(s).trim()).filter(Boolean);

  function fmt(v) {
    if (v === undefined || v === null || v === '') return '—';
    if (v === true) return 'Oui';
    if (v === false) return 'Non';
    if (Array.isArray(v)) return v.join(', ');
    return String(v);
  }

  // ------------------------------------------------------------------ état courant
  const tenants = () => (state.doc.tenants = isObj(state.doc.tenants) ? state.doc.tenants : {});
  const isDefaults = () => state.sel.kind === 'defaults';

  function target() {
    if (isDefaults()) return (state.doc.defaults = isObj(state.doc.defaults) ? state.doc.defaults : {});
    return tenants()[state.sel.slug];
  }

  /** Valeurs héritées par l'élément courant (défauts intégrés, puis "defaults" pour une page). */
  function inherited() {
    if (isDefaults()) return state.builtin;
    const d = state.doc.defaults || {};
    const m = merge(state.builtin, d);
    m.weekly_hours = d.weekly_hours ?? state.builtin.weekly_hours;
    return m;
  }

  const inhWord = () => (isDefaults() ? 'défaut' : 'hérité');

  function changed() {
    const dirty = JSON.stringify(state.doc) !== state.saved;
    $('dirty').hidden = !dirty;
  }

  // ------------------------------------------------------------------ champs génériques
  function row(label, control, hint, cls = '') {
    return h('div', { class: `field ${cls}` }, h('label', {}, h('span', { class: 'lbl', text: label }), control), hint ? h('small', { class: 'hint', text: hint }) : null);
  }

  function objFor(opts) {
    return opts.root ? state.doc : target();
  }

  function textField(path, label, opts = {}) {
    const obj = objFor(opts);
    const inh = opts.root ? undefined : get(inherited(), path);
    const cur = get(obj, path);
    const attrs = {
      value: opts.format ? opts.format(cur) : cur ?? '',
      placeholder: opts.placeholder ?? (inh !== undefined && inh !== null && inh !== '' ? `${inhWord()} : ${fmt(inh)}` : ''),
      oninput: (e) => {
        const v = e.target.value;
        set(obj, path, v.trim() === '' ? undefined : opts.parse ? opts.parse(v) : v);
        opts.after?.();
      },
      class: opts.mono ? 'mono' : undefined,
      type: opts.type || 'text',
      list: opts.list,
      min: opts.min,
      rows: opts.rows,
      spellcheck: opts.mono ? 'false' : undefined,
    };
    const control = opts.textarea ? h('textarea', attrs) : h('input', attrs);
    return row(label, control, opts.hint, opts.cls);
  }

  const parseDuration = (v) => (/^\s*\d+\s*$/.test(v) ? parseInt(v, 10) : v.trim());
  const parseInt10 = (v) => (Number.isNaN(parseInt(v, 10)) ? undefined : parseInt(v, 10));

  function selectField(path, label, options, opts = {}) {
    const obj = objFor(opts);
    const inh = get(inherited(), path);
    const cur = get(obj, path);
    const inhLabel = options.find(([v]) => v === inh)?.[1] ?? fmt(inh);
    const sel = h(
      'select',
      {
        onchange: (e) => {
          const raw = e.target.value;
          const opt = options.find(([v]) => String(v) === raw);
          set(obj, path, raw === '' ? undefined : opt ? opt[0] : raw);
        },
      },
      h('option', { value: '', text: `${inhWord() === 'défaut' ? 'Par défaut' : 'Hérité'} (${inhLabel})` }),
      options.map(([v, l]) => h('option', { value: String(v), text: l, selected: cur !== undefined && cur === v })),
    );
    return row(label, sel, opts.hint, opts.cls);
  }

  const boolField = (path, label, hint) => selectField(path, label, [[true, 'Oui'], [false, 'Non']], { hint });

  function colorField(path, label) {
    const obj = target();
    const inh = get(inherited(), path);
    const text = h('input', {
      class: 'mono',
      value: get(obj, path) ?? '',
      placeholder: `${inhWord()} : ${fmt(inh)}`,
      oninput: (e) => {
        set(obj, path, e.target.value.trim() || undefined);
        if (/^#[0-9a-f]{6}$/i.test(e.target.value)) picker.value = e.target.value;
      },
    });
    const picker = h('input', {
      type: 'color',
      value: /^#[0-9a-f]{6}$/i.test(get(obj, path) ?? inh) ? get(obj, path) ?? inh : '#1a73e8',
      oninput: (e) => {
        text.value = e.target.value;
        set(obj, path, e.target.value);
      },
    });
    return row(label, h('div', { class: 'inline' }, picker, text));
  }

  // ------------------------------------------------------------------ plages horaires
  function rangeEditor(list, onChange) {
    // list : tableau de "HH:MM-HH:MM" ; onChange(nouvelleListe, structurel)
    const wrap = h('div', { class: 'ranges' });
    list.forEach((r, i) => {
      const [a = '', b = ''] = r.split('-').map((x) => x.trim());
      const update = () => {
        let end = endIn.value;
        if (end === '00:00' && startIn.value !== '00:00') end = '24:00'; // minuit en fin de plage
        list[i] = `${startIn.value}-${end}`; // en place : les éditions suivantes partent de cette valeur
        onChange([...list], false);
      };
      const startIn = h('input', { type: 'time', step: 300, value: a, onchange: update });
      const endIn = h('input', { type: 'time', step: 300, value: b === '24:00' ? '00:00' : b, onchange: update });
      wrap.append(
        h(
          'span',
          { class: 'range' },
          startIn,
          '–',
          endIn,
          h('button', { type: 'button', class: 'icon', title: 'Supprimer la plage', text: '✕', onclick: () => onChange(list.filter((_, j) => j !== i), true) }),
        ),
      );
    });
    wrap.append(
      h('button', {
        type: 'button',
        class: 'link',
        text: '+ plage',
        onclick: () => {
          const lastEnd = list.length ? list[list.length - 1].split('-')[1] : '09:00';
          const start = lastEnd === '24:00' ? '09:00' : lastEnd;
          const [hh, mm] = start.split(':').map(Number);
          const end = `${String(Math.min(hh + 2, 23)).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
          onChange([...list, `${start}-${end}`], true);
        },
      }),
    );
    return wrap;
  }

  function weeklyWidget() {
    const t = target();
    const own = t.weekly_hours !== undefined;
    const inh = inherited().weekly_hours || {};
    const box = h('div', { class: 'block' });
    box.append(
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: own,
          onchange: (e) => {
            if (e.target.checked) set(t, 'weekly_hours', Object.fromEntries(DAYS.map(([d]) => [d, ranges(inh[d])])));
            else set(t, 'weekly_hours', undefined);
            renderPanel();
          },
        }),
        isDefaults() ? ' Personnaliser les horaires par défaut' : ' Horaires propres à cette page',
      ),
    );
    const hours = own ? t.weekly_hours : inh;
    const table = h('div', { class: `week${own ? '' : ' readonly'}` });
    for (const [d, name] of DAYS) {
      const list = ranges(hours[d]);
      const open = list.length > 0;
      const line = h('div', { class: 'day-row' }, h('span', { class: 'day-name', text: name }));
      if (!own) {
        line.append(h('span', { class: open ? '' : 'muted', text: open ? list.join(', ') : 'Fermé' }));
      } else {
        const write = (next, structural) => {
          t.weekly_hours = { ...t.weekly_hours, [d]: next };
          changed();
          if (structural) renderPanel();
        };
        line.append(
          h(
            'label',
            { class: 'check' },
            h('input', { type: 'checkbox', checked: open, onchange: (e) => write(e.target.checked ? ['09:00-12:00', '14:00-18:00'] : [], true) }),
            open ? ' Ouvert' : ' Fermé',
          ),
        );
        if (open) line.append(rangeEditor(list, write));
      }
      table.append(line);
    }
    box.append(table);
    if (!own) box.append(h('small', { class: 'hint', text: isDefaults() ? 'Horaires intégrés à l’application.' : 'Horaires des paramètres communs.' }));
    return box;
  }

  function overridesWidget() {
    const t = target();
    const own = isObj(t.date_overrides) ? t.date_overrides : {};
    const box = h('div', { class: 'block' });
    const entries = Object.entries(own).sort(([a], [b]) => a.localeCompare(b));
    const write = (obj, structural = true) => {
      set(t, 'date_overrides', Object.keys(obj).length ? obj : undefined);
      if (structural) renderPanel();
    };

    if (!isDefaults()) {
      const common = Object.entries(state.doc.defaults?.date_overrides || {});
      if (common.length) {
        box.append(
          h('small', {
            class: 'hint',
            text: `Dates des paramètres communs (s'appliquent aussi ici) : ${common
              .map(([d, r]) => `${d} ${ranges(r).length ? ranges(r).join(', ') : 'fermé'}`)
              .join(' · ')}. Une même date ajoutée ci-dessous les remplace.`,
          }),
        );
      }
    }
    if (!entries.length) box.append(h('p', { class: 'muted', text: 'Aucune date particulière.' }));

    for (const [date, val] of entries) {
      const list = ranges(val);
      const closed = list.length === 0;
      box.append(
        h(
          'div',
          { class: 'day-row' },
          h('input', {
            type: 'date',
            value: date,
            onchange: (e) => {
              const nd = e.target.value;
              if (!nd || (nd !== date && own[nd] !== undefined)) return renderPanel();
              const next = {};
              for (const [k, v] of Object.entries(own)) next[k === date ? nd : k] = v;
              write(next);
            },
          }),
          h(
            'select',
            { onchange: (e) => write({ ...own, [date]: e.target.value === 'closed' ? [] : ['09:00-12:00'] }) },
            h('option', { value: 'closed', text: 'Fermé', selected: closed }),
            h('option', { value: 'open', text: 'Horaires spécifiques', selected: !closed }),
          ),
          closed ? null : rangeEditor(list, (next, structural) => write({ ...own, [date]: next }, structural)),
          h('button', {
            type: 'button',
            class: 'icon',
            title: 'Supprimer cette date',
            text: '✕',
            onclick: () => {
              const next = { ...own };
              delete next[date];
              write(next);
            },
          }),
        ),
      );
    }
    box.append(
      h('button', {
        type: 'button',
        class: 'link',
        text: '+ Ajouter une date',
        onclick: () => {
          const d = new Date();
          let key;
          do {
            d.setDate(d.getDate() + 1);
            key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          } while (own[key] !== undefined);
          write({ ...own, [key]: [] });
        },
      }),
    );
    return box;
  }

  // ------------------------------------------------------------------ agendas
  function calendarsWidget() {
    const t = target();
    const list = (Array.isArray(t.calendars) ? t.calendars : []).map((c) => (typeof c === 'string' ? { id: c } : { ...c }));
    const autoInvite = (id) => EMAIL_RE.test(id) && !id.endsWith('calendar.google.com');
    const write = (next, structural) => {
      // forme la plus compacte : une simple chaîne quand tout est par défaut
      const out = next
        .filter((c) => c.id !== undefined)
        .map((c) => {
          const o = { id: c.id };
          if (c.check === false) o.check = false;
          if (c.invite !== undefined && c.invite !== autoInvite(c.id)) o.invite = c.invite;
          return Object.keys(o).length === 1 ? c.id : o;
        });
      set(t, 'calendars', out.length ? out : undefined);
      if (structural) renderPanel();
    };

    const table = h(
      'table',
      { class: 'cals' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Agenda (email ou ID)' }), h('th', { text: 'Bloque les créneaux' }), h('th', { text: 'Invité' }), h('th'))),
    );
    const tbody = h('tbody');
    list.forEach((c, i) => {
      const invite = c.invite ?? autoInvite(c.id || '');
      tbody.append(
        h(
          'tr',
          {},
          h('td', {}, h('input', { value: c.id || '', placeholder: 'collegue@exemple.com', class: 'mono', oninput: (e) => { list[i].id = e.target.value.trim(); write(list, false); } })),
          h('td', { class: 'center' }, h('input', { type: 'checkbox', checked: c.check !== false, onchange: (e) => { list[i].check = e.target.checked; write(list, false); } })),
          h('td', { class: 'center' }, h('input', { type: 'checkbox', checked: invite, onchange: (e) => { list[i].invite = e.target.checked; write(list, false); } })),
          h('td', {}, h('button', { type: 'button', class: 'icon', title: 'Retirer', text: '✕', onclick: () => write(list.filter((_, j) => j !== i), true) })),
        ),
      );
    });
    if (!list.length) tbody.append(h('tr', {}, h('td', { colspan: 4, class: 'muted', text: 'Seul l’agenda de l’organisateur est utilisé.' })));
    table.append(tbody);
    return h(
      'div',
      { class: 'block' },
      table,
      h('button', { type: 'button', class: 'link', text: '+ Ajouter un agenda', onclick: () => write([...list, { id: '' }], true) }),
      h('small', {
        class: 'hint',
        text: '« Bloque les créneaux » : ses indisponibilités sont prises en compte. « Invité » : la personne reçoit l’invitation. L’organisateur doit avoir accès au moins aux disponibilités de chaque agenda.',
      }),
    );
  }

  // ------------------------------------------------------------------ onglets
  function tabGeneral() {
    const t = target();
    const out = [];
    if (isDefaults()) {
      out.push(textField('site.title', 'Titre de la page d’accueil', { root: true, placeholder: 'Prise de rendez-vous' }));
      out.push(h('p', { class: 'muted', text: 'Les réglages ci-dessous et ceux des autres onglets s’appliquent à toutes les pages, sauf si une page les redéfinit.' }));
    } else {
      out.push(
        row(
          'Adresse de la page',
          h(
            'div',
            { class: 'inline' },
            h('span', { class: 'muted', text: `${location.origin}/` }),
            h('input', { class: 'mono', value: state.sel.slug, onchange: (e) => renameTenant(e.target.value.trim(), e.target) }),
          ),
          'Lettres minuscules, chiffres et tirets.',
        ),
      );
      out.push(
        textField('title', 'Titre', {
          placeholder: state.sel.slug,
          after: () => {
            renderNav();
            document.querySelector('.panel-head h2').textContent = target().title || state.sel.slug;
          },
        }),
      );
      out.push(textField('description', 'Description', { textarea: true, rows: 3, placeholder: '' }));
    }
    out.push(
      textField('password', 'Mot de passe d’accès', {
        mono: true,
        placeholder: (() => {
          const inh = get(inherited(), 'password');
          return inh ? `${inhWord()} : ${inh}` : 'vide = page publique';
        })(),
        hint: 'Vide = page publique. Pour ne pas l’écrire ici : ${NOM_VARIABLE} lit la valeur dans .env.',
        after: renderNav,
      }),
    );
    out.push(boolField('listed', 'Afficher sur la page d’accueil', 'La page reste accessible par son adresse dans tous les cas.'));
    out.push(h('h3', { text: 'Apparence' }));
    out.push(colorField('branding.color', 'Couleur principale'));
    out.push(textField('branding.logo_url', 'URL du logo', { placeholder: 'https://…/logo.png', type: 'url' }));
    return out;
  }

  function tabAgendas() {
    const t = target();
    if (typeof t.organizer === 'string') t.organizer = { account: t.organizer };
    return [
      textField('organizer.account', 'Compte Google organisateur', {
        type: 'email',
        placeholder: 'moi@exemple.com',
        hint: 'L’événement est créé dans ce compte (à connecter dans Administration).',
      }),
      textField('organizer.calendar_id', 'Agenda de l’organisateur', { placeholder: 'primary', mono: true, hint: '« primary » = agenda principal du compte.' }),
      h('h3', { text: 'Autres agendas' }),
      calendarsWidget(),
    ];
  }

  function tabSlots() {
    const tz = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    const durHint = 'En minutes, ou 30m, 4h, 2d.';
    return [
      h(
        'div',
        { class: 'grid2' },
        textField('durations', 'Durée(s) du rendez-vous', {
          placeholder: `${inhWord()} : ${fmt(get(inherited(), 'durations'))}`,
          hint: 'En minutes. Plusieurs valeurs séparées par des virgules = le visiteur choisit.',
          parse: (v) => v.split(',').map((x) => x.trim()).filter(Boolean).map(parseDuration),
          format: (v) => (Array.isArray(v) ? v.join(', ') : v ?? ''),
        }),
        textField('slot_interval', 'Intervalle entre deux créneaux', {
          placeholder: get(inherited(), 'slot_interval') ? `${inhWord()} : ${get(inherited(), 'slot_interval')}` : 'égal à la durée',
          hint: durHint,
          parse: parseDuration,
        }),
        textField('buffer_before', 'Temps libre avant', { hint: durHint, parse: parseDuration }),
        textField('buffer_after', 'Temps libre après', { hint: durHint, parse: parseDuration }),
        textField('min_notice', 'Délai de prévenance minimum', { hint: `Pas de réservation moins de … à l’avance. ${durHint}`, parse: parseDuration }),
        textField('max_days_ahead', 'Réservable jusqu’à (jours)', { type: 'number', min: 0, parse: parseInt10 }),
        textField('max_per_day', 'Rendez-vous max par jour', {
          type: 'number',
          min: 1,
          parse: parseInt10,
          placeholder: get(inherited(), 'max_per_day') ? `${inhWord()} : ${get(inherited(), 'max_per_day')}` : 'illimité',
          hint: 'Compte les rendez-vous pris via cette page.',
        }),
        textField('timezone', 'Fuseau horaire des horaires', { list: 'tzlist', hint: 'Les visiteurs voient les créneaux dans leur propre fuseau.' }),
      ),
      h('datalist', { id: 'tzlist' }, tz.map((z) => h('option', { value: z }))),
    ];
  }

  function tabAvailability() {
    return [h('h3', { text: 'Horaires hebdomadaires' }), weeklyWidget(), h('h3', { text: 'Dates particulières' }), overridesWidget()];
  }

  function tabForm() {
    return [
      h('h3', { text: 'Formulaire de réservation' }),
      h('p', { class: 'muted', text: 'Prénom, nom, email et téléphone sont toujours obligatoires.' }),
      h(
        'div',
        { class: 'grid2' },
        selectField('form.message', 'Champ « message »', [
          ['hidden', 'Masqué'],
          ['optional', 'Facultatif'],
          ['required', 'Obligatoire'],
        ]),
        textField('form.message_label', 'Libellé du champ message'),
      ),
      h('h3', { text: 'Événement créé' }),
      h(
        'div',
        { class: 'grid2' },
        selectField('event.conference', 'Visioconférence', [
          ['google_meet', 'Google Meet'],
          ['none', 'Aucune'],
        ]),
        textField('event.location', 'Lieu', { placeholder: (get(inherited(), 'event.location') ?? '') || 'aucun' }),
      ),
      textField('event.summary', 'Titre de l’événement'),
      textField('event.description', 'Description de l’événement', { textarea: true, rows: 6 }),
      h('small', {
        class: 'hint',
        text: 'Variables : {{first_name}} {{last_name}} {{email}} {{phone}} {{message}} {{title}} {{slug}}',
      }),
      h(
        'div',
        { class: 'grid3' },
        boolField('event.guests_can_see_other_guests', 'Invités voient les autres invités'),
        boolField('event.guests_can_modify', 'Invités peuvent modifier'),
        boolField('event.guests_can_invite_others', 'Invités peuvent inviter'),
      ),
      h('h3', { text: 'Après la réservation' }),
      textField('confirmation_message', 'Message de confirmation', { textarea: true, rows: 2 }),
    ];
  }

  const TABS = [
    ['general', 'Général', tabGeneral],
    ['agendas', 'Agendas', tabAgendas, { tenantOnly: true }],
    ['slots', 'Créneaux', tabSlots],
    ['availability', 'Disponibilités', tabAvailability],
    ['form', 'Formulaire & invitation', tabForm],
  ];

  // ------------------------------------------------------------------ gestion des pages
  function uniqueSlug(base) {
    let slug = base;
    let i = 2;
    while (tenants()[slug] !== undefined) slug = `${base}-${i++}`;
    return slug;
  }

  function renameTenant(newSlug, input) {
    const old = state.sel.slug;
    if (newSlug === old) return;
    const err = !SLUG_RE.test(newSlug)
      ? 'Adresse invalide : lettres minuscules, chiffres et tirets uniquement.'
      : RESERVED.includes(newSlug)
        ? `« ${newSlug} » est réservé.`
        : tenants()[newSlug] !== undefined
          ? `La page « ${newSlug} » existe déjà.`
          : null;
    if (err) {
      show(false, err);
      input.value = old;
      return;
    }
    const next = {};
    for (const [k, v] of Object.entries(tenants())) next[k === old ? newSlug : k] = v;
    state.doc.tenants = next;
    state.sel = { kind: 'tenant', slug: newSlug };
    changed();
    // pas de re-rendu du formulaire : le champ suivant, peut-être déjà en cours de saisie, garde le focus
    renderNav();
    document.querySelector('.panel-actions a')?.setAttribute('href', `/${newSlug}`);
  }

  function addTenant() {
    const first = Object.values(tenants())[0];
    const account = (typeof first?.organizer === 'string' ? first.organizer : first?.organizer?.account) || '';
    const slug = uniqueSlug('nouvelle-page');
    tenants()[slug] = { title: 'Nouvelle page', organizer: { account } };
    select({ kind: 'tenant', slug }, 'general');
    changed();
  }

  function duplicateTenant() {
    const slug = uniqueSlug(`${state.sel.slug}-copie`);
    const copy = clone(target());
    copy.title = `${copy.title || state.sel.slug} (copie)`;
    tenants()[slug] = copy;
    select({ kind: 'tenant', slug }, state.tab);
    changed();
  }

  function deleteTenant() {
    const slug = state.sel.slug;
    if (Object.keys(tenants()).length <= 1) return show(false, 'Il faut au moins une page.');
    if (!confirm(`Supprimer la page « ${slug} » ? (effectif après Enregistrer)`)) return;
    delete tenants()[slug];
    select({ kind: 'defaults' }, 'general');
    changed();
  }

  // ------------------------------------------------------------------ rendu
  function select(sel, tab) {
    state.sel = sel;
    if (tab) state.tab = tab;
    if (isDefaults() && state.tab === 'agendas') state.tab = 'general';
    render();
  }

  function renderNav() {
    const nav = $('nav');
    nav.innerHTML = '';
    nav.append(
      h('button', { type: 'button', class: `nav-item${isDefaults() ? ' active' : ''}`, onclick: () => select({ kind: 'defaults' }) }, h('strong', { text: 'Paramètres communs' }), h('small', { text: 'appliqués à toutes les pages' })),
      h('div', { class: 'nav-title', text: 'Pages' }),
    );
    for (const [slug, t] of Object.entries(tenants())) {
      const active = !isDefaults() && state.sel.slug === slug;
      nav.append(
        h(
          'button',
          { type: 'button', class: `nav-item${active ? ' active' : ''}`, onclick: () => select({ kind: 'tenant', slug }) },
          h('strong', { text: `${t?.title || slug}${t?.password ? ' 🔒' : ''}` }),
          h('small', { text: `/${slug}` }),
        ),
      );
    }
    nav.append(h('button', { type: 'button', class: 'btn add', text: '+ Nouvelle page', onclick: addTenant }));
  }

  function renderPanel() {
    const panel = $('panel');
    const scroll = window.scrollY;
    panel.innerHTML = '';
    const head = h('div', { class: 'panel-head' });
    if (isDefaults()) {
      head.append(h('h2', { text: 'Paramètres communs' }));
    } else {
      head.append(
        h('h2', { text: target().title || state.sel.slug }),
        h(
          'div',
          { class: 'panel-actions' },
          h('a', { class: 'btn', href: `/${state.sel.slug}`, target: '_blank', text: 'Voir la page ↗' }),
          h('button', { type: 'button', class: 'btn', text: 'Dupliquer', onclick: duplicateTenant }),
          h('button', { type: 'button', class: 'btn danger', text: 'Supprimer', onclick: deleteTenant }),
        ),
      );
    }
    panel.append(head);
    const tabs = TABS.filter(([, , , o]) => !(o?.tenantOnly && isDefaults()));
    panel.append(
      h(
        'div',
        { class: 'tabs', role: 'tablist' },
        tabs.map(([key, label]) =>
          h('button', { type: 'button', role: 'tab', class: `tab${state.tab === key ? ' active' : ''}`, 'aria-selected': state.tab === key ? 'true' : 'false', text: label, onclick: () => { state.tab = key; renderPanel(); } }),
        ),
      ),
    );
    const [, , fn] = tabs.find(([key]) => key === state.tab) || tabs[0];
    panel.append(h('div', { class: 'tab-body' }, fn()));
    window.scrollTo({ top: scroll });
  }

  function render() {
    renderNav();
    renderPanel();
  }

  // ------------------------------------------------------------------ serveur
  // noms techniques des erreurs serveur -> libellés du formulaire
  const LABELS = {
    durations: 'Durée(s) du rendez-vous',
    slot_interval: 'Intervalle entre deux créneaux',
    buffer_before: 'Temps libre avant',
    buffer_after: 'Temps libre après',
    min_notice: 'Délai de prévenance',
    max_days_ahead: 'Réservable jusqu’à',
    max_per_day: 'Rendez-vous max par jour',
    timezone: 'Fuseau horaire',
    weekly_hours: 'Horaires hebdomadaires',
    date_overrides: 'Dates particulières',
    'form.message': 'Champ « message »',
    'event.conference': 'Visioconférence',
    'organizer.account': 'Compte Google organisateur',
  };
  const humanize = (msg) =>
    msg
      .replace(/tenant "([^"]+)"\.?([a-z_.]+)?/g, (_, slug, key) => {
        const base = key?.split('.').slice(0, 2).join('.');
        const label = LABELS[key] || LABELS[base] || LABELS[key?.split('.')[0]];
        return `Page « ${slug} »${label ? ` › ${label}` : key ? ` › ${key}` : ''}`;
      })
      .replace(/"organizer\.account" \(email du compte Google\) est requis/, 'compte Google organisateur manquant');

  function show(ok, message, list) {
    const r = $('result');
    const m = !ok && /tenant "([^"]+)"/.exec(message);
    message = humanize(message);
    r.className = `result ${ok ? 'ok' : 'ko'}`;
    r.textContent = message;
    if (list) r.append(h('ul', {}, list.map((t) => h('li', { text: `/${t.slug} — ${t.title}${t.protected ? ' 🔒' : ''}` }))));
    // amène sur la page concernée par l'erreur
    if (m && tenants()[m[1]] !== undefined && state.sel.slug !== m[1]) select({ kind: 'tenant', slug: m[1] });
  }

  async function post(body) {
    const res = await fetch(api('/admin/api/config'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.json().catch(() => ({ ok: false, error: `Erreur ${res.status}` }));
  }

  function clientCheck() {
    for (const [slug, t] of Object.entries(tenants())) {
      const account = typeof t?.organizer === 'string' ? t.organizer : t?.organizer?.account;
      if (!account) return `La page « ${slug} » n’a pas de compte Google organisateur (onglet Agendas).`;
      if ((t.calendars || []).some((c) => !(typeof c === 'string' ? c : c?.id))) return `La page « ${slug} » a un agenda sans adresse (onglet Agendas).`;
    }
    return null;
  }

  $('validate').onclick = async () => {
    const err = clientCheck();
    if (err) return show(false, `✗ ${err}`);
    const data = await post({ doc: state.doc, dryRun: true });
    if (data.ok) show(true, `✓ Configuration valide — ${data.tenants.length} page(s) :`, data.tenants);
    else show(false, `✗ ${data.error}`);
  };

  async function save() {
    const btn = $('save');
    if (btn.disabled) return;
    const err = clientCheck();
    if (err) return show(false, `✗ ${err}`);
    btn.disabled = true;
    try {
      const data = await post({ doc: state.doc, version: state.version });
      if (data.ok) {
        state.version = data.version;
        state.saved = JSON.stringify(state.doc);
        changed();
        show(true, `✓ Enregistré et appliqué — ${data.tenants.length} page(s) :`, data.tenants);
      } else if (data.conflict) {
        show(false, `✗ Non enregistré : ${data.error}. Rechargez la page (vos modifications en cours seront perdues).`);
      } else {
        show(false, `✗ Non enregistré, la configuration en service est inchangée. ${data.error}`);
      }
    } catch (e) {
      show(false, `✗ ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  }
  $('save').onclick = save;

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.doc && JSON.stringify(state.doc) !== state.saved) e.preventDefault();
  });

  async function load() {
    const res = await fetch(api('/admin/api/config'));
    const data = await res.json();
    if (data.error || !data.doc) {
      $('panel').innerHTML = '';
      $('panel').append(
        h('p', { class: 'error', text: `Le fichier actuel n’est pas lisible : ${data.error || 'vide'}` }),
        h('p', {}, h('a', { href: '/admin/config/yaml', text: 'Le corriger dans l’éditeur YAML' })),
      );
      return;
    }
    state.doc = data.doc;
    state.builtin = data.builtin;
    state.version = data.version;
    // normalisation sans effet sur le sens : organizer "x@y" -> { account: "x@y" }
    for (const t of Object.values(tenants())) if (t && typeof t.organizer === 'string') t.organizer = { account: t.organizer };
    state.saved = JSON.stringify(state.doc);
    const first = Object.keys(tenants())[0];
    const wanted = new URLSearchParams(location.search).get('page');
    select(wanted && tenants()[wanted] !== undefined ? { kind: 'tenant', slug: wanted } : first ? { kind: 'tenant', slug: first } : { kind: 'defaults' });
  }

  load().catch((e) => show(false, `✗ Chargement impossible : ${e.message}`));
})();
