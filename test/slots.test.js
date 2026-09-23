import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { computeSlots, parseTimeRange } from '../src/slots.js';
import { parseConfig, parseMinutes } from '../src/config.js';

const TZ = 'Europe/Paris';
const at = (iso) => DateTime.fromISO(iso, { zone: TZ }).toMillis();
const hhmm = (ms) => DateTime.fromMillis(ms, { zone: TZ }).toFormat('yyyy-MM-dd HH:mm');

const baseRules = {
  timezone: TZ,
  slot_interval: null,
  buffer_before: 0,
  buffer_after: 0,
  min_notice: 0,
  max_days_ahead: 30,
  max_per_day: null,
  weekly_hours: { mon: ['09:00-11:00'], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
  date_overrides: {},
};

// lundi 5 octobre 2026
const monday = '2026-10-05';
const now = at('2026-10-01T08:00');
const run = (rules, extra = {}) =>
  computeSlots({
    rules: { ...baseRules, ...rules },
    duration: 30,
    busy: [],
    from: at(`${monday}T00:00`),
    to: at(`${monday}T23:59`),
    now,
    ...extra,
  }).map((s) => hhmm(s.start).slice(11));

test('créneaux de base', () => {
  assert.deepEqual(run({}), ['09:00', '09:30', '10:00', '10:30']);
});

test('slot_interval', () => {
  assert.deepEqual(run({ slot_interval: 15 }), ['09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '10:30']);
});

test('périodes occupées et tampons', () => {
  const busy = [{ start: at(`${monday}T09:30`), end: at(`${monday}T10:00`) }];
  assert.deepEqual(run({}, { busy }), ['09:00', '10:00', '10:30']);
  assert.deepEqual(run({ buffer_after: 15 }, { busy }), ['10:00', '10:30']);
  assert.deepEqual(run({ buffer_before: 15 }, { busy }), ['09:00', '10:30']);
});

test('délai de prévenance et fenêtre de réservation', () => {
  assert.deepEqual(run({}, { now: at(`${monday}T09:10`) }), ['09:30', '10:00', '10:30']);
  assert.deepEqual(run({ min_notice: 60 }, { now: at(`${monday}T08:45`) }), ['10:00', '10:30']);
  assert.deepEqual(run({ max_days_ahead: 3 }), []);
});

test('dérogations datées et max_per_day', () => {
  assert.deepEqual(run({ date_overrides: { [monday]: [] } }), []);
  assert.deepEqual(run({ date_overrides: { [monday]: ['14:00-15:00'] } }), ['14:00', '14:30']);
  assert.deepEqual(run({ max_per_day: 2 }, { bookingsPerDay: { [monday]: 2 } }), []);
  assert.deepEqual(run({ max_per_day: 2 }, { bookingsPerDay: { [monday]: 1 } }).length, 4);
});

test("changement d'heure : les plages restent en heure locale", () => {
  // dimanche 25 octobre 2026 = passage à l'heure d'hiver
  const slots = computeSlots({
    rules: { ...baseRules, weekly_hours: { ...baseRules.weekly_hours, sun: ['09:00-10:00'] } },
    duration: 60,
    busy: [],
    from: at('2026-10-25T00:00'),
    to: at('2026-10-26T00:00'),
    now,
  });
  assert.deepEqual(slots.map((s) => hhmm(s.start)), ['2026-10-25 09:00']);
});

test('parseTimeRange / parseMinutes', () => {
  assert.throws(() => parseTimeRange('12:00-09:00'));
  assert.throws(() => parseTimeRange('9h-12h'));
  assert.deepEqual(parseTimeRange('22:00-24:00').end, { h: 24, m: 0 });
  assert.equal(parseMinutes('4h'), 240);
  assert.equal(parseMinutes('2d'), 2880);
  assert.equal(parseMinutes(45), 45);
});

test('config : fusion des défauts, calendriers et variables', () => {
  process.env.TEST_ACCOUNT = 'moi@ex.com';
  const cfg = parseConfig(`
defaults:
  min_notice: 2h
  weekly_hours:
    mon: "08:00-12:00, 13:00-17:00"
tenants:
  a:
    organizer: { account: "\${TEST_ACCOUNT}" }
    calendars:
      - alice@ex.com
      - { id: salle@group.calendar.google.com }
      - { id: bob@ex.com, check: false }
  b:
    organizer: x@ex.com
    min_notice: 0
    event: { conference: none }
`);
  const a = cfg.tenants.get('a');
  assert.equal(a.organizer.account, 'moi@ex.com');
  assert.equal(a.rules.min_notice, 120);
  assert.deepEqual(a.rules.weekly_hours.mon, ['08:00-12:00', '13:00-17:00']);
  assert.deepEqual(a.rules.weekly_hours.tue, []); // weekly_hours remplace, ne fusionne pas
  assert.deepEqual(
    a.calendars.map((c) => [c.id, c.check, c.invite]),
    [
      ['alice@ex.com', true, true],
      ['salle@group.calendar.google.com', true, false],
      ['bob@ex.com', false, true],
    ],
  );
  assert.equal(a.event.conference, 'google_meet');
  const b = cfg.tenants.get('b');
  assert.equal(b.rules.min_notice, 0);
  assert.equal(b.event.conference, 'none');
  assert.ok(b.event.summary.includes('{{first_name}}'));
});

test('config : erreurs explicites', () => {
  assert.throws(() => parseConfig('tenants: { admin: { organizer: x@y.z } }'), /réservé/);
  assert.throws(() => parseConfig('tenants: { a: {} }'), /organizer/);
  assert.throws(() => parseConfig('tenants: { a: { organizer: x@y.z, timezone: Mars/Base } }'), /timezone/);
  assert.throws(() => parseConfig('tenants: { a: { organizer: x@y.z, weekly_hours: { lundi: [] } } }'), /jours inconnus/);
});
