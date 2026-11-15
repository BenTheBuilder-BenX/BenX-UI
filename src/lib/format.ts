export const GiB = 1024 ** 3;
export function bytes(value: number | undefined, decimals = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.max(0, Math.min(4, Math.floor(Math.log(Math.abs(value)) / Math.log(1024))));
  return `${(value / 1024 ** i).toFixed(i ? decimals : 0)} ${units[i]}`;
}
export function duration(seconds: number | undefined): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
export function percent(current = 0, total = 0) { return total ? Math.min(100, current / total * 100) : 0; }
export function download(name: string, content: string | Blob, type = 'application/json') {
  const url = URL.createObjectURL(typeof content === 'string' ? new Blob([content], { type }) : content);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function pretty(value: unknown) { return JSON.stringify(value, null, 2); }
export function expiry(value: number) { return !value ? 'Never' : value < 0 ? `${Math.abs(value) / 86400000} days after first use` : new Date(value).toLocaleDateString(); }
