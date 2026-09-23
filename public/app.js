(() => {
  const T = window.__TENANT__;
  const $ = (id) => document.getElementById(id);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const locale = 'fr-FR';

  const state = {
    duration: T.durations[0],
    month: startOfMonth(new Date()),
    cache: new Map(), // "duration|YYYY-MM" -> Map(dayKey -> slots[])
    day: null,
    slot: null,
    autoAdvanced: false,
  };

  function startOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }
  function addMonths(d, n) {
    return new Date(d.getFullYear(), d.getMonth() + n, 1);
  }
  function pad(n) {
    return String(n).padStart(2, '0');
  }
  function dayKey(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function monthKey(d) {
    return `${state.duration}|${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }
  function fmtDuration(min) {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} h ${pad(m)}` : `${h} h`;
  }
  const fmtTime = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtFull = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtMonth = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' });
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function slotLabel(slot) {
    const s = new Date(slot.start);
    const e = new Date(slot.end);
    return `${cap(fmtFull.format(s))}, ${fmtTime.format(s)} – ${fmtTime.format(e)}`;
  }

  // ---------------------------------------------------------------- en-tête
  $('tzLabel').textContent = `Heures affichées : ${tz.replace(/_/g, ' ')}`;
  function renderDuration() {
    $('durationLabel').textContent = fmtDuration(state.duration);
    const picker = $('durationPicker');
    if (T.durations.length < 2) return;
    picker.hidden = false;
    picker.innerHTML = '';
    for (const d of T.durations) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = fmtDuration(d);
      b.className = d === state.duration ? 'active' : '';
      b.onclick = () => {
        state.duration = d;
        state.day = null;
        renderDuration();
        loadMonth();
      };
      picker.appendChild(b);
    }
  }

  // ---------------------------------------------------------------- calendrier
  const lastBookable = new Date();
  lastBookable.setDate(lastBookable.getDate() + T.max_days_ahead + 1);

  async function loadMonth() {
    const key = monthKey(state.month);
    renderCalendar();
    if (!state.cache.has(key)) {
      $('pickStatus').textContent = 'Chargement des disponibilités…';
      $('pickStatus').className = 'status';
      try {
        const from = state.month;
        const to = addMonths(state.month, 1);
        const res = await fetch(
          `/api/t/${encodeURIComponent(T.slug)}/slots?duration=${state.duration}&from=${from.toISOString()}&to=${to.toISOString()}`,
        );
        if (res.status === 401) return location.reload();
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erreur');
        const byDay = new Map();
        for (const s of data.slots) {
          const k = dayKey(new Date(s.start));
          if (!byDay.has(k)) byDay.set(k, []);
          byDay.get(k).push(s);
        }
        state.cache.set(key, byDay);
        $('pickStatus').textContent = '';
      } catch (e) {
        $('pickStatus').textContent = e.message;
        $('pickStatus').className = 'status error';
        return;
      }
    }
    if (monthKey(state.month) !== key) return; // l'utilisateur a changé de mois entre-temps

    const byDay = state.cache.get(key);
    // au premier affichage, saute au mois suivant si le mois courant est vide
    if (!byDay.size && !state.autoAdvanced && addMonths(state.month, 1) < lastBookable) {
      state.autoAdvanced = true;
      state.month = addMonths(state.month, 1);
      return loadMonth();
    }
    state.autoAdvanced = true;
    if (!state.day || !byDay.has(state.day)) state.day = [...byDay.keys()].sort()[0] || null;
    if (!byDay.size) {
      $('pickStatus').textContent = 'Aucun créneau disponible ce mois-ci.';
    }
    renderCalendar();
    renderSlots();
  }

  function renderCalendar() {
    const byDay = state.cache.get(monthKey(state.month));
    $('monthLabel').textContent = cap(fmtMonth.format(state.month));
    $('prevMonth').disabled = state.month <= startOfMonth(new Date());
    $('nextMonth').disabled = addMonths(state.month, 1) >= lastBookable;

    const grid = $('calGrid');
    grid.innerHTML = '';
    for (const w of ['L', 'M', 'M', 'J', 'V', 'S', 'D']) {
      const el = document.createElement('div');
      el.className = 'wd';
      el.textContent = w;
      grid.appendChild(el);
    }
    const offset = (state.month.getDay() + 6) % 7;
    for (let i = 0; i < offset; i++) grid.appendChild(document.createElement('div'));

    const todayKey = dayKey(new Date());
    const d = new Date(state.month);
    while (d.getMonth() === state.month.getMonth()) {
      const k = dayKey(d);
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = d.getDate();
      b.className = 'day';
      const has = byDay && byDay.has(k);
      b.disabled = !has;
      if (has) b.classList.add('available');
      if (k === state.day) b.classList.add('selected');
      if (k === todayKey) b.classList.add('today');
      b.onclick = () => {
        state.day = k;
        renderCalendar();
        renderSlots();
      };
      grid.appendChild(b);
      d.setDate(d.getDate() + 1);
    }
  }

  function renderSlots() {
    const byDay = state.cache.get(monthKey(state.month));
    const list = $('slotList');
    list.innerHTML = '';
    const slots = (byDay && state.day && byDay.get(state.day)) || [];
    if (!slots.length) {
      $('dayLabel').textContent = 'Sélectionnez une date';
      return;
    }
    $('dayLabel').textContent = cap(fmtDay.format(new Date(slots[0].start)));
    for (const s of slots) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'slot';
      b.textContent = fmtTime.format(new Date(s.start));
      b.onclick = () => chooseSlot(s);
      list.appendChild(b);
    }
  }

  $('prevMonth').onclick = () => {
    state.month = addMonths(state.month, -1);
    state.day = null;
    loadMonth();
  };
  $('nextMonth').onclick = () => {
    state.month = addMonths(state.month, 1);
    state.day = null;
    loadMonth();
  };

  // ---------------------------------------------------------------- formulaire
  function show(step) {
    for (const id of ['stepPick', 'stepForm', 'stepDone']) $(id).hidden = id !== step;
  }

  function chooseSlot(s) {
    state.slot = s;
    $('chosenLabel').textContent = slotLabel(s);
    $('formError').textContent = '';
    show('stepForm');
    document.querySelector('#bookingForm input[name=first_name]').focus();
  }

  $('backToPick').onclick = () => show('stepPick');

  const form = $('bookingForm');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    for (const el of form.querySelectorAll('.invalid')) el.classList.remove('invalid');
    if (!form.checkValidity()) {
      for (const el of form.querySelectorAll(':invalid')) el.classList.add('invalid');
      $('formError').textContent = 'Merci de remplir correctement les champs obligatoires.';
      form.querySelector(':invalid').focus();
      return;
    }
    const body = Object.fromEntries(new FormData(form));
    body.start = state.slot.start;
    body.duration = state.duration;

    const btn = $('submitBtn');
    btn.disabled = true;
    btn.textContent = 'Réservation en cours…';
    $('formError').textContent = '';
    try {
      const res = await fetch(`/api/t/${encodeURIComponent(T.slug)}/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        location.reload();
        return;
      }
      if (res.status === 409) {
        state.cache.clear();
        show('stepPick');
        await loadMonth();
        $('pickStatus').textContent = data.error;
        $('pickStatus').className = 'status error';
        return;
      }
      if (!res.ok) {
        for (const name of Object.keys(data.fields || {})) form.elements[name]?.classList.add('invalid');
        throw new Error(data.fields ? Object.values(data.fields).join(' · ') : data.error || 'Erreur');
      }
      $('doneLabel').textContent = slotLabel(data);
      $('doneMeet').innerHTML = '';
      if (data.meet_url) {
        const a = document.createElement('a');
        a.href = data.meet_url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = data.meet_url.replace(/^https?:\/\//, '');
        $('doneMeet').append('Lien de visio : ', a);
      }
      $('doneMsg').textContent = T.confirmation_message || '';
      show('stepDone');
    } catch (e) {
      $('formError').textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Confirmer le rendez-vous';
    }
  });

  renderDuration();
  loadMonth();
})();
