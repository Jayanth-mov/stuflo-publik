export function toLocal(iso: string | null | undefined, timeZone: string, weekday: 'short' | 'long' = 'short'): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  try {
    return date.toLocaleString('en-US', {
      timeZone,
      weekday,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return iso;
  }
}
