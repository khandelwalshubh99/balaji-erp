/**
 * Plain calendar dates, in local time.
 *
 * Everything user-facing here is a date with no time and no zone — a quotation
 * is dated "6 September", not an instant. Going via toISOString() would render
 * the wrong day for anyone east of UTC for the first 5.5 hours of every day,
 * which in Indore is most of the working morning.
 */
export const todayISO = () => toISO(new Date());

export function toISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Day arithmetic that rolls over months and years correctly. */
export function addDaysISO(iso, days) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return toISO(new Date(y, m - 1, d + days));
}

/**
 * The Indian financial year a date falls in, as the tag used in every number
 * we issue: April 2026 to March 2027 is `2627`.
 *
 * One copy, because the boundary is the kind of thing that gets written
 * slightly differently the third time and then two sequences disagree about
 * which year a March order belongs to.
 */
export function fyTag(date = new Date()) {
  const y = date.getMonth() + 1 >= 4 ? date.getFullYear() : date.getFullYear() - 1;
  return `${String(y).slice(2)}${String(y + 1).slice(2)}`;
}
