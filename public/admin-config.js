(() => {
  const { defaultOrganizer } = window.__CONFIG_EDITOR__;
  let version = window.__CONFIG_EDITOR__.version;
  const $ = (id) => document.getElementById(id);
  const editor = $('editor');
  const result = $('result');
  let saved = editor.value;

  function setDirty() {
    $('dirty').hidden = editor.value === saved;
  }
  editor.addEventListener('input', setDirty);
  window.addEventListener('beforeunload', (e) => {
    if (editor.value !== saved) e.preventDefault();
  });

  function show(ok, message, tenants) {
    result.className = `result ${ok ? 'ok' : 'ko'}`;
    result.textContent = message;
    if (tenants) {
      const ul = document.createElement('ul');
      for (const t of tenants) {
        const li = document.createElement('li');
        li.textContent = `/${t.slug} — ${t.title} · ${t.organizer} · ${t.calendars} agenda(s) en plus${t.protected ? ' · 🔒' : ''}`;
        ul.appendChild(li);
      }
      result.appendChild(ul);
    }
  }

  // URL absolues sans identifiants : fetch() refuse une page ouverte via http://user:pass@hôte/
  const api = (p) => new URL(p, location.origin).href;

  async function post(url, body) {
    const res = await fetch(api(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => ({ ok: false, error: `Erreur ${res.status}` })) };
  }

  $('validate').onclick = async () => {
    const { data } = await post('/admin/config/validate', { text: editor.value });
    if (data.ok) show(true, `✓ Configuration valide — ${data.tenants.length} page(s) :`, data.tenants);
    else show(false, `✗ ${data.error}`);
  };

  async function save() {
    if ($('save').disabled) return;
    $('save').disabled = true;
    try {
      const { data } = await post('/admin/config', { text: editor.value, version });
      if (data.ok) {
        version = data.version;
        saved = editor.value;
        setDirty();
        renderBackups(data.backups || []);
        show(true, `✓ Enregistré et appliqué — ${data.tenants.length} page(s) :`, data.tenants);
      } else if (data.conflict) {
        show(false, `✗ Non enregistré : ${data.error}. Copiez vos modifications, rechargez la page puis réappliquez-les.`);
      } else {
        show(false, `✗ Non enregistré, la configuration en service est inchangée.\n${data.error}`);
      }
    } catch (e) {
      show(false, `✗ ${e.message}`);
    } finally {
      $('save').disabled = false;
    }
  }
  $('save').onclick = save;

  editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      save();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      // YAML n'accepte pas les tabulations : on insère deux espaces
      e.preventDefault();
      document.execCommand('insertText', false, '  ') || editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
      setDirty();
    }
  });

  $('addTenant').onclick = () => {
    const slug = (prompt('Identifiant de la page (utilisé dans l’URL : lettres minuscules, chiffres, tirets)') || '').trim();
    if (!slug) return;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      show(false, '✗ Identifiant invalide : a-z, 0-9 et tirets uniquement.');
      return;
    }
    if (new RegExp(`^  ${slug}:`, 'm').test(editor.value)) {
      show(false, `✗ La page « ${slug} » existe déjà.`);
      return;
    }
    const block = [
      '',
      `  ${slug}:`,
      '    title: Nouvelle page',
      '    description: ""',
      '    password: ""                  # vide = page publique',
      '    organizer:',
      `      account: ${defaultOrganizer}`,
      '    calendars: []                 # ex. [collegue@exemple.com]',
      '    durations: [30]',
      '    # weekly_hours:               # sinon hérité de "defaults"',
      '    #   mon: ["09:00-12:00"]',
      '',
    ].join('\n');
    // la section "tenants:" est en principe la dernière du fichier
    editor.value = editor.value.replace(/\s*$/, '\n') + block;
    editor.focus();
    editor.setSelectionRange(editor.value.length - block.length + 1, editor.value.length - block.length + 1);
    editor.scrollTop = editor.scrollHeight;
    setDirty();
    show(true, `Page « ${slug} » ajoutée en fin de fichier (sous tenants:). Complétez-la puis enregistrez.`);
  };

  function backupLabel(name) {
    return name.replace(/^config-|\.yaml$/g, '').replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}).*/, '$1 $2:$3:$4 UTC');
  }

  function renderBackups(list) {
    const ul = $('backups');
    ul.innerHTML = '';
    for (const b of list) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = backupLabel(b.name);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link';
      btn.dataset.backup = b.name;
      btn.textContent = 'Charger dans l’éditeur';
      li.append(span, ' ', btn);
      ul.appendChild(li);
    }
  }

  $('backups').addEventListener('click', async (e) => {
    const name = e.target.dataset?.backup;
    if (!name) return;
    if (editor.value !== saved && !confirm('Remplacer le contenu de l’éditeur (modifications non enregistrées perdues) ?')) return;
    const res = await fetch(api(`/admin/config/backups/${encodeURIComponent(name)}`));
    if (!res.ok) return show(false, '✗ Sauvegarde introuvable');
    editor.value = await res.text();
    setDirty();
    show(true, `Sauvegarde du ${backupLabel(name)} chargée : cliquez sur Enregistrer pour la restaurer.`);
    editor.scrollTop = 0;
  });
})();
