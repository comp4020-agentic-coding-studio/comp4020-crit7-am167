// The day, as integers. A booking is a run of half-hour slots on one date,
// so overlap is arithmetic rather than date maths — the single most useful
// simplification in the app, and the reason double-booking is a two-line
// query instead of a timezone argument.

export const SLOT_MINUTES = 30;
/** 08:00 — campus opens */
export const DAY_START_MINUTES = 8 * 60;
/** 20:00 — campus closes; slot 23 is 19:30–20:00 */
export const SLOTS = 24;

/** How far ahead you may book, and the longest single booking. */
export const MAX_DAYS_AHEAD = 14;
export const MAX_SLOTS_PER_BOOKING = 6; // three hours

export const TIMEZONE = "Australia/Canberra";

/** "14:30" for the start of a slot. `SLOTS` itself reads as closing time. */
export function slotTime(slot: number): string {
  const minutes = DAY_START_MINUTES + slot * SLOT_MINUTES;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "14:30–16:00" for a booking's half-open slot range. */
export function slotRangeLabel(startSlot: number, endSlot: number): string {
  return `${slotTime(startSlot)}–${slotTime(endSlot)}`;
}

/** Today on campus, as YYYY-MM-DD — not today wherever the server happens
 *  to be. Fly runs UTC, which is 10–11 hours behind Canberra, so without
 *  this the app would roll over to tomorrow midway through the afternoon. */
export function today(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** The slot currently running on campus, or -1 before opening and SLOTS
 *  once closed. Used to grey out slots that have already been and gone. */
export function currentSlot(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const [h, m] = parts.split(":").map(Number);
  const minutes = h * 60 + m;
  if (minutes < DAY_START_MINUTES) return -1;
  return Math.min(SLOTS, Math.floor((minutes - DAY_START_MINUTES) / SLOT_MINUTES));
}

/** Shift a YYYY-MM-DD by whole days, without tripping over a timezone. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative if `to` is in the past. */
export function daysBetween(from: string, to: string): number {
  const at = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(to) - at(from)) / 86_400_000);
}

/** The dates the app will show, starting today. */
export function bookableDates(from: string = today()): string[] {
  return Array.from({ length: MAX_DAYS_AHEAD + 1 }, (_, i) => addDays(from, i));
}

export function isBookableDate(date: string, from: string = today()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const delta = daysBetween(from, date);
  return delta >= 0 && delta <= MAX_DAYS_AHEAD;
}

/** "Thu 24 Sep" — how a date reads in the UI. */
export function dateLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
