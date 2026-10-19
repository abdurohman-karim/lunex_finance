const formatters = new Map<string, Intl.DateTimeFormat>();

/** Calendar date (`YYYY-MM-DD`) of an instant in a time zone, e.g. Asia/Tashkent. */
export function localDate(instant: Date, timeZone: string): string {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // en-CA formats dates as YYYY-MM-DD.
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter.format(instant);
}
