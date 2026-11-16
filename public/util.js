/**
 * Pure client helpers, kept out of `app.js` so they can be unit-tested in Node
 * (no DOM). `app.js` imports everything here.
 */

export const MB = 1048576;

export const TH_DAYS = [
  'วันอาทิตย์', 'วันจันทร์', 'วันอังคาร', 'วันพุธ', 'วันพฤหัสบดี', 'วันศุกร์', 'วันเสาร์',
];

export const TH_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

export const VIDEO_EXT_RE = /\.(mp4|mov|m4v|webm|3gp|mkv|avi)$/i;
export const IMAGE_EXT_RE = /\.(jpe?g|png|heic|heif|webp|gif|bmp|tiff?)$/i;

/** 2026-11-22 -> 22.11.26 (the way the invitation card prints it) */
export function shortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  return `${m[3]}.${m[2]}.${m[1].slice(2)}`;
}

/** 2026-11-22 -> วันอาทิตย์ที่ 22 พฤศจิกายน พ.ศ. 2569 */
export function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  const day = TH_DAYS[dt.getUTCDay()];
  const month = TH_MONTHS[mo - 1] || '';
  return `${day}ที่ ${d} ${month} พ.ศ. ${y + 543}`;
}

/** Stable per-photo pseudo-random so a photo keeps its frame and size. */
export function hashOf(s) {
  let h = 2166136261;
  for (let i = 0; i < (s || '').length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * Photo or video, decided by the FILE, never by which button was tapped:
 * an OEM camera can hand back a still image for a "record video" input.
 */
export function kindOf(file, hint = '') {
  const type = (file && file.type) || '';
  if (/^video\//i.test(type)) return 'video';
  if (/^image\//i.test(type)) return 'photo';
  const name = (file && file.name) || '';
  if (VIDEO_EXT_RE.test(name)) return 'video';
  if (IMAGE_EXT_RE.test(name)) return 'photo';
  return hint === 'video' ? 'video' : 'photo';
}

export function extOf(file) {
  const m = /\.([a-z0-9]{2,5})$/i.exec((file && file.name) || '');
  if (m) return m[1].toLowerCase();
  const t = ((file && file.type) || '').split('/')[1] || 'jpg';
  return t.replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
}

export function safeName(s) {
  return String(s || 'guest').replace(/[\\/:*?"<>|]+/g, '').slice(0, 30) || 'guest';
}

export function human(bytes) {
  return bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * `/i/m/abc-t.jpg` -> `m/abc-t.jpg`, else ''. Only this Worker's own media route
 * can be bundled (see /api/page); anything else must stay a normal request.
 */
export function keyFromUrl(url) {
  const s = String(url || '');
  if (!s.startsWith('/i/')) return '';
  const key = s.slice(3);
  if (!key.startsWith('m/') || key.includes('..')) return '';
  return key;
}
