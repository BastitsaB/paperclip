const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  if (seconds < MINUTE) return "just now";
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return `${m}m ago`;
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return `${h}h ago`;
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return `${d}d ago`;
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return `${w}w ago`;
  }
  const mo = Math.floor(seconds / MONTH);
  return `${mo}mo ago`;
}

/**
 * Clock time for "today" in the reference day, prefixed with a short date
 * once the timestamp is no longer from that day — e.g. `8:16 PM` today, but
 * `Sep 20, 8:16 PM` a day or more back (`Sep 20, 2025, 8:16 PM` once the year
 * also differs). Day/year comparisons are made in the display time zone so
 * "today" matches what the viewer actually sees.
 *
 * `timeAgo()` above answers "how long ago" but caps out at a bucket like
 * `3d ago`/`2w ago` — fine for a feed, but chat bubbles and activity-log rows
 * that showed a bare clock time (`toLocaleTimeString()` with no date) became
 * ambiguous the moment the entry was no longer from today: "8:16 PM" reads
 * the same whether it happened five minutes or five days ago. This is the
 * fix for that — always enough to place the entry on a calendar day, without
 * the "Today, " padding a monitor banner wants but a compact row doesn't.
 */
export function formatDayAwareTime(
  date: Date | string,
  options: { locale?: Intl.LocalesArgument; timeZone?: string } = {},
  now: Date | string = new Date(),
): string {
  const target = new Date(date);
  const reference = new Date(now);

  const ymd = (value: Date) => {
    const parts = new Intl.DateTimeFormat(options.locale, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      timeZone: options.timeZone,
    }).formatToParts(value);
    const pick = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "";
    return { year: pick("year"), month: pick("month"), day: pick("day") };
  };

  const targetYmd = ymd(target);
  const referenceYmd = ymd(reference);

  const time = new Intl.DateTimeFormat(options.locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: options.timeZone,
  }).format(target);

  const isToday =
    targetYmd.year === referenceYmd.year &&
    targetYmd.month === referenceYmd.month &&
    targetYmd.day === referenceYmd.day;
  if (isToday) return time;

  const datePart = new Intl.DateTimeFormat(options.locale, {
    month: "short",
    day: "numeric",
    year: targetYmd.year === referenceYmd.year ? undefined : "numeric",
    timeZone: options.timeZone,
  }).format(target);
  return `${datePart}, ${time}`;
}
