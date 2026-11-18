export function studentLocalTimeContext(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value || '';
  const localDate = `${part('year')}-${part('month')}-${part('day')}`;
  const localDateTime = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(now);
  return `Student time zone: ${timeZone}. Current student-local date: ${localDate}. Current student-local date and time: ${localDateTime}. Interpret “today,” “tomorrow,” weekdays, and relative deadlines only from this context.`;
}
