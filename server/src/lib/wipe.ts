export interface WipeSlot {
  /** 0 = Sunday ... 6 = Saturday, in the configured time zone. */
  weekday: number;
  /** 24h local time, HH:MM. */
  time: string;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function zonedParts(epochMs: number, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

/** Offset of the zone from UTC at the given instant, in milliseconds. */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const p = zonedParts(epochMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Converts a wall-clock time in a zone to a UTC epoch (ms). */
export function zonedTimeToEpoch(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const first = zoneOffsetMs(guess, timeZone);
  let result = guess - first;
  const second = zoneOffsetMs(result, timeZone);
  if (second !== first) result = guess - second;
  return result;
}

/** Next wipe strictly after `nowMs`, or null when no slots are configured. */
export function nextWipe(nowMs: number, timeZone: string, slots: WipeSlot[]): number | null {
  if (slots.length === 0) return null;
  let best: number | null = null;
  for (let offset = 0; offset <= 8; offset++) {
    // Midday avoids landing on the wrong calendar day around DST changes.
    const probe = zonedParts(nowMs + offset * 86_400_000, timeZone);
    const noon = zonedTimeToEpoch(probe.year, probe.month, probe.day, 12, 0, timeZone);
    const day = zonedParts(noon, timeZone);
    for (const slot of slots) {
      if (slot.weekday !== day.weekday) continue;
      const [hh, mm] = slot.time.split(':').map(Number) as [number, number];
      const at = zonedTimeToEpoch(day.year, day.month, day.day, hh, mm, timeZone);
      if (at > nowMs && (best === null || at < best)) best = at;
    }
  }
  return best;
}
