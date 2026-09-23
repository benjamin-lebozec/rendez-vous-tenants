// Calcul des créneaux disponibles. Module pur (aucun appel réseau) pour être testable.
import { DateTime } from 'luxon';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** "09:00-12:30" -> { start: {h,m}, end: {h,m} } ; accepte "24:00" en fin. */
export function parseTimeRange(str) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(str).trim());
  if (!m) throw new Error(`plage horaire invalide "${str}" (format attendu HH:MM-HH:MM)`);
  const [sh, sm, eh, em] = m.slice(1).map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (sh > 23 || sm > 59 || em > 59 || endMin > 24 * 60 || endMin <= startMin) {
    throw new Error(`plage horaire invalide "${str}"`);
  }
  return { start: { h: sh, m: sm }, end: { h: eh, m: em } };
}

function atTime(day, { h, m }) {
  // set() respecte l'heure murale même les jours de changement d'heure
  return h === 24 ? day.plus({ days: 1 }).startOf('day') : day.set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

function overlapsBusy(busy, start, end) {
  for (const b of busy) {
    if (b.start < end && b.end > start) return true;
  }
  return false;
}

/** Plages horaires d'une journée (dérogation datée prioritaire sur l'horaire hebdo). */
export function windowsForDay(rules, day) {
  const key = day.toISODate();
  if (rules.date_overrides && Object.hasOwn(rules.date_overrides, key)) return rules.date_overrides[key];
  return rules.weekly_hours[WEEKDAYS[day.weekday - 1]] || [];
}

/**
 * @param {object} p
 * @param {object} p.rules    règles normalisées du tenant (timezone, weekly_hours, ...)
 * @param {number} p.duration durée du RDV en minutes
 * @param {Array<{start:number,end:number}>} p.busy  périodes occupées (ms epoch)
 * @param {number} p.from     début de la période demandée (ms epoch)
 * @param {number} p.to       fin (exclue) de la période demandée (ms epoch)
 * @param {number} p.now      instant courant (ms epoch)
 * @param {Record<string,number>} [p.bookingsPerDay] nb de RDV déjà pris par jour (YYYY-MM-DD, fuseau du tenant)
 * @returns {Array<{start:number,end:number}>}
 */
export function computeSlots({ rules, duration, busy, from, to, now, bookingsPerDay = {} }) {
  const tz = rules.timezone;
  const durMs = duration * 60_000;
  const interval = rules.slot_interval || duration;
  const bufBefore = (rules.buffer_before || 0) * 60_000;
  const bufAfter = (rules.buffer_after || 0) * 60_000;
  const earliest = now + (rules.min_notice || 0) * 60_000;

  const today = DateTime.fromMillis(now, { zone: tz }).startOf('day');
  const lastDay = today.plus({ days: rules.max_days_ahead });

  let day = DateTime.fromMillis(Math.max(from, now), { zone: tz }).startOf('day');
  let endDay = DateTime.fromMillis(to - 1, { zone: tz }).startOf('day');
  if (endDay > lastDay) endDay = lastDay;

  const out = new Map();
  while (day <= endDay) {
    const key = day.toISODate();
    const full = rules.max_per_day && (bookingsPerDay[key] || 0) >= rules.max_per_day;
    if (!full) {
      for (const w of windowsForDay(rules, day)) {
        const range = parseTimeRange(w);
        const wEnd = atTime(day, range.end).toMillis();
        let t = atTime(day, range.start).toMillis();
        for (; t + durMs <= wEnd; t += interval * 60_000) {
          const end = t + durMs;
          if (t < earliest || t < from || t >= to) continue;
          if (overlapsBusy(busy, t - bufBefore, end + bufAfter)) continue;
          out.set(t, { start: t, end });
        }
      }
    }
    day = day.plus({ days: 1 });
  }
  return [...out.values()].sort((a, b) => a.start - b.start);
}
