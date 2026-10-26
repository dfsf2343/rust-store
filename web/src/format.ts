export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Compact countdown such as "2d 14h" or "3h 05m" or "45s". */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

export function hoursLabel(hours: number): string {
  if (hours <= 0) return 'No cooldown';
  if (hours < 1) return `Every ${Math.round(hours * 60)} minutes`;
  if (hours === 1) return 'Every hour';
  if (hours % 24 === 0) return hours === 24 ? 'Once a day' : `Every ${hours / 24} days`;
  return `Every ${hours} hours`;
}

const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const dateTimeFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function formatDate(unixSeconds: number): string {
  return dateFormat.format(new Date(unixSeconds * 1000));
}

export function formatDateTime(unixSeconds: number): string {
  return dateTimeFormat.format(new Date(unixSeconds * 1000));
}

export function formatAmount(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

/** Splits "host:port" into parts; the port doubles as the sign's exit number. */
export function splitAddress(address: string): { host: string; port: string | null } {
  const match = /^(.*):(\d{2,5})$/.exec(address);
  return match ? { host: match[1]!, port: match[2]! } : { host: address, port: null };
}
