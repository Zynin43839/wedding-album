import { buildZip } from '/zip.js';
import {
  MB, TH_DAYS, TH_MONTHS, VIDEO_EXT_RE,
  shortDate, longDate, hashOf, kindOf, extOf, safeName, human, fmtTime, keyFromUrl,
} from '/util.js';
import {
  put as queuePut,
  remove as queueRemove,
  list as queueList,
  clear as queueClear,
  stats as queueStats,
} from '/queue.js';

const $ = (s) => document.querySelector(s);

const state = {
  code: '',
  guest: '',
  cfg: { title: 'อัลบั้มงานแต่ง', maxPhotoMb: 12, maxVideoMb: 80, date: '', expiresAt: '' },
  items: [],
  byId: new Map(),
  cursor: null,
  page: 1,
  revealed: 0,
  loading: false,
  selected: new Set(),
  stage: [],
  batchIds: new Set(),
  frame: '',      // '' = อัตโนมัติ, otherwise 'v0'..'v6'
  lbFrame: '',    // frame chosen for a single-photo download ('' = none)
  lbItem: null,
  lbPreview: null,
  queue: [],
  active: 0,
  expired: false,
  bundleOff: false,   // set after 2 bundle failures: fall back to one request per photo
  bundleFails: 0,
};

const MAX_PARALLEL = 3;
// photos shown per "page" in the album; the API page is buffered behind it
const PAGE_SIZE = 15;

/* ───────────────────────────── bootstrap ───────────────────────────── */

function q() {
  return state.code ? `?e=${encodeURIComponent(state.code)}` : '';
}

async function boot() {
  const url = new URL(location.href);
  state.code = url.searchParams.get('e') || localStorage.getItem('event_code') || '';
  if (url.searchParams.get('e')) localStorage.setItem('event_code', state.code);

  state.guest = localStorage.getItem('guest_name') || '';
  $('#guestName').value = state.guest;

  bindUi();
  await loadConfig();
  bindPendingBanner();
  await restoreQueue();
  // The album itself is loaded when the guest opens its tab: a guest who only
  // shoots should not pay for a list call and 15 thumbnails they never see.
}

async function loadConfig() {
  try {
    const r = await fetch('/api/config' + q());
    if (r.status === 410) return setExpired();
    if (!r.ok) {
      toast('ลิงก์ไม่ถูกต้อง หรือรหัสห้องไม่ถูก');
      $('#eventSub').textContent = 'ตรวจสอบลิงก์ที่ได้รับจากเจ้าภาพอีกครั้ง';
      return;
    }
    state.cfg = await r.json();
    $('#eventTitle').textContent = state.cfg.title;
    if (state.cfg.names) $('#eventNames').textContent = state.cfg.names;

    if (state.cfg.date) $('#eventSub').textContent = longDate(state.cfg.date);
  } catch {
    toast('เชื่อมต่อไม่ได้ ลองรีเฟรชอีกครั้ง');
  }
}

function setExpired() {
  state.expired = true;
  $('#eventSub').textContent = 'อัลบั้มนี้ปิดรับชมแล้ว';
  toast('อัลบั้มนี้ปิดรับชมแล้ว');
  document.querySelectorAll('.btn input').forEach((i) => (i.disabled = true));
}




/* ───────────────────────────── UI binding ───────────────────────────── */

function bindUi() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('#guestName').addEventListener('input', (e) => {
    state.guest = e.target.value.trim().slice(0, 40);
    localStorage.setItem('guest_name', state.guest);
  });

  $('#capturePhoto').addEventListener('change', (e) => addFiles(e.target.files, 'photo'));
  $('#pickPhoto').addEventListener('change', (e) => addFiles(e.target.files));
  $('#captureVideo').addEventListener('change', (e) => addFiles(e.target.files, 'video'));

  // keep the visible limit in sync with the recorder's hard cap
  const limitEl = $('#recLimit');
  if (limitEl) limitEl.textContent = `อัดได้ครั้งละไม่เกิน ${Math.round(REC_MAX_MS / 1000)} วินาที`;

  $('#retryAll').addEventListener('click', retryFailed);
  $('#reviewSend').addEventListener('click', sendStaged);
  $('#reviewClear').addEventListener('click', clearStaged);
  $('#recBtn').addEventListener('click', openRecorder);
  $('#recCancel').addEventListener('click', () => closeRecorder(true));
  $('#recToggle').addEventListener('click', toggleRecording);
  $('#doneClose').addEventListener('click', () => ($('#doneBanner').hidden = true));
  $('#doneAlbum').addEventListener('click', () => {
    $('#doneBanner').hidden = true;
    switchTab('album');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#moreBtn').addEventListener('click', () => showMore());
  $('#selectAllBtn').addEventListener('click', toggleSelectAll);
  $('#zipBtn').addEventListener('click', startZip);
  $('#lbClose').addEventListener('click', closeLightbox);
  $('#lbDownload').addEventListener('click', downloadFramed);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLightbox();
  });
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  for (const pane of ['shoot', 'album', 'card']) {
    const el = document.getElementById(`tab-${pane}`);
    if (el) el.hidden = name !== pane;
  }
  if (name === 'card') drawCard();
  // first visit to the album: list once, then one bundled request for the page
  if (name === 'album' && state.revealed === 0 && !state.loading) {
    (async () => {
      if (!state.items.length) await loadMore();
      await showMore();
    })();
  }
}

let toastTimer;
function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

/**
 * Turn a failed upload into something a guest can act on.
 *
 * `retry` decides whether the queue tries again: a dropped connection or a
 * server hiccup is worth retrying, a file the server will always refuse is not
 * (retrying it three times just delays the real message).
 */
function explainError(err) {
  const code = String((err && (err.code || err.message)) || 'unknown');
  const status = Number((err && err.status) || 0);
  const table = {
    network: { text: 'สัญญาณไม่ดี — รูปยังอยู่ในเครื่องคุณ', retry: true, tag: 'E-NET' },
    timeout: { text: 'ส่งไม่ทันเวลา — ลองอีกครั้ง', retry: true, tag: 'E-TIME' },
    too_large: { text: 'ไฟล์ใหญ่เกินกว่าที่ระบบรับได้', retry: false, tag: 'E-413' },
    bad_type: { text: 'เครื่องนี้ส่งไฟล์ชนิดนี้ไม่ได้', retry: false, tag: 'E-415' },
    bad_id: { text: 'เกิดข้อผิดพลาดกับชื่อไฟล์ — ลองถ่ายใหม่', retry: false, tag: 'E-400' },
    bad_code: { text: 'ลิงก์ไม่ถูกต้อง — ขอ QR จากเจ้าภาพ', retry: false, tag: 'E-403' },
    expired: { text: 'อัลบั้มปิดรับชมแล้ว', retry: false, tag: 'E-410' },
    length_required: { text: 'ส่งไฟล์ไม่ครบ — ลองอีกครั้ง', retry: true, tag: 'E-411' },
    quota: { text: 'อัลบั้มเต็มสำหรับวันนี้ — กลับมาได้หลัง 07:00 น.', retry: false, tag: 'E-429' },
  };
  if (table[code]) return { code, ...table[code] };
  if (status === 429 || status === 503) return { code, ...table.quota };
  if (status >= 500) return { code, text: 'เซิร์ฟเวอร์ขัดข้อง — ลองอีกครั้ง', retry: true, tag: 'E-5XX' };
  if (code === 'conflict') return { code, text: '', retry: false, tag: 'E-409', duplicate: true };
  return { code, text: 'ส่งไม่สำเร็จ — ลองอีกครั้ง', retry: true, tag: 'E-000' };
}

const FRAMES = [
  { id: '', name: 'อัตโนมัติ' },
  { id: 'v0', name: 'ขอบปรุ' },
  { id: 'v1', name: 'ทองคู่' },
  { id: 'v2', name: 'มุมทอง' },
  { id: 'v3', name: 'สันอัลบั้ม' },
  { id: 'v4', name: 'แอร์เมล' },
  { id: 'v5', name: 'มุมโค้ง' },
];

function renderFrameSwatches() {
  const box = $('#frameSwatches');
  box.innerHTML = '';
  for (const f of FRAMES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(state.frame === f.id));
    btn.setAttribute('aria-label', f.name);
    btn.title = f.name;

    const mini = document.createElement('span');
    mini.className = `tile ${f.id || 'auto'}`;
    mini.setAttribute('aria-hidden', 'true');
    btn.appendChild(mini);

    btn.addEventListener('click', () => {
      state.frame = f.id;
      renderFrameSwatches();
      toast(`กรอบ: ${f.name}`);
    });
    box.appendChild(btn);
  }
}

/* ── "sent" confirmation after a whole batch finishes ─────────────── */
function showDone(ok, failed) {
  const banner = $('#doneBanner');
  banner.classList.toggle('warn', failed > 0);
  $('#doneTitle').textContent = failed
    ? `ส่งสำเร็จ ${ok} ไฟล์ · ไม่สำเร็จ ${failed} ไฟล์`
    : ok > 1
      ? `ส่งภาพสำเร็จ ${ok} ไฟล์`
      : 'ส่งภาพสำเร็จ';
  $('#doneSub').textContent = failed
    ? 'กด “ลองใหม่ทั้งหมด” ในคิวเพื่อส่งซ้ำ'
    : ok > 1
      ? 'ทุกคนในงานเห็นภาพแล้ว'
      : 'ทุกคนในงานเห็นภาพแล้ว';
  banner.hidden = false;
  banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ─────────────────────── review before upload ─────────────────────── */
/**
 * Nothing is uploaded the moment a file is picked. Each file goes into
 * `state.stage` and is shown as a thumbnail the guest can open, delete, or
 * confirm. Only "อัปโหลด" moves the batch into the real queue.
 */
/**
 * Decide photo vs video from the FILE ITSELF, never from which button was tapped.
 * Some Android/OEM camera apps hand back a still image even when the input asked
 * for video (the picker opened in photo mode), and tagging it as a video made the
 * tile render without a poster — it looked like "the video button takes photos".
 */


function addFiles(fileList, hint) {
  if (state.expired) return;
  const files = [...(fileList || [])];
  if (!files.length) return;

  let added = 0;
  for (const file of files) {
    const kind = kindOf(file, hint);
    const limit = kind === 'video' ? state.cfg.maxVideoMb : state.cfg.maxPhotoMb;

    if (hint === 'video' && kind === 'photo') {
      toast('ไฟล์นี้เป็นรูปภาพ — ส่งเป็นรูปให้แล้ว');
    }

    if (file.size > limit * MB) {
      toast(`${file.name || 'ไฟล์'} ใหญ่เกิน ${limit} MB`);
      continue;
    }

    const item = {
      id: makeId(),
      file,
      kind,
      guest: state.guest || 'Guest',
      tries: 0,
      status: 'stage',
      el: null,
      preview: URL.createObjectURL(file),
    };
    state.stage.push(item);
    renderStagedItem(item);
    added++;
  }

  if (!added) return;
  $('#doneBanner').hidden = true;
  if (!$('#frameSwatches').childElementCount) renderFrameSwatches();
  updateReviewBar();
  $('#reviewWrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}


function renderStagedItem(item) {
  const li = document.createElement('li');
  li.className = 'rItem';
  li.dataset.id = item.id;

  if (item.kind === 'video') {
    const v = document.createElement('video');
    v.className = 'rThumb';
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.preload = 'metadata';
    v.src = `${item.preview}#t=0.1`;
    li.appendChild(v);
  } else {
    const img = document.createElement('img');
    img.className = 'rThumb';
    img.alt = '';
    img.src = item.preview;
    img.addEventListener('error', () => {
      img.remove();
      const ph = document.createElement('span');
      ph.className = 'rPh';
      ph.innerHTML = ICON.photo;
      li.appendChild(ph);
    });
    li.appendChild(img);
  }

  if (item.kind === 'video') {
    const k = document.createElement('span');
    k.className = 'rKind';
    k.innerHTML = ICON.play;
    li.appendChild(k);
  }

  const size = document.createElement('span');
  size.className = 'rSize';
  size.textContent = human(item.file.size);
  li.appendChild(size);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'rDel';
  del.setAttribute('aria-label', 'ลบไฟล์นี้');
  del.title = 'ลบ';
  del.textContent = '×';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    dropStaged(item.id);
  });
  li.appendChild(del);

  // tap the tile = full-size look at the local file (nothing is uploaded)
  li.addEventListener('click', () =>
    openLightbox({ url: item.preview, type: item.kind, guest: 'ตัวอย่างก่อนส่ง', id: item.id })
  );

  item.el = li;
  $('#reviewList').appendChild(li);
}

function dropStaged(id) {
  const i = state.stage.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [item] = state.stage.splice(i, 1);
  item.el?.remove();
  if (item.preview) URL.revokeObjectURL(item.preview);
  updateReviewBar();
}

function clearStaged() {
  const n = state.stage.length;
  if (!n) return;
  if (n > 1 && !confirm(`ลบทั้ง ${n} ไฟล์ที่รอส่ง?`)) return;
  for (const item of state.stage) {
    item.el?.remove();
    if (item.preview) URL.revokeObjectURL(item.preview);
  }
  state.stage = [];
  $('#reviewList').innerHTML = '';
  updateReviewBar();
  toast('ลบออกแล้ว');
}

function updateReviewBar() {
  const n = state.stage.length;
  const bytes = state.stage.reduce((s, i) => s + i.file.size, 0);
  $('#reviewCount').textContent = n ? `${n} ไฟล์ · ${human(bytes)}` : '—';
  $('#reviewSend').textContent = `อัปโหลด (${n})`;
  $('#reviewSend').disabled = n === 0;
  $('#reviewClear').hidden = n === 0;
  $('#reviewWrap').hidden = n === 0;
}

function sendStaged() {
  const batch = state.stage.splice(0);
  if (!batch.length) return;

  state.batchIds = new Set(batch.map((i) => i.id));
  $('#doneBanner').hidden = true;

  closeLightbox();
  $('#reviewList').innerHTML = '';
  updateReviewBar();
  $('#queueWrap').hidden = false;

  for (const item of batch) {
    item.status = 'wait';
    item.frame = state.frame;   // the frame the guest picked for this batch
    state.queue.push(item);
    renderQueueItem(item);
    if (item.preview) {
      URL.revokeObjectURL(item.preview);
      item.preview = null;
    }
  }

  toast(`กำลังส่ง ${batch.length} ไฟล์`);
  pump();
}

/* ─────────────────────── in-page video recorder ─────────────────────── */

/**
 * `<input type="file" accept="video/*" capture>` is unreliable: on many Android
 * camera apps and inside iOS/WebView browsers it opens the STILL camera, so the
 * guest records nothing and the app receives a photo. Recording here with
 * getUserMedia + MediaRecorder gives the same behaviour on every device, and we
 * control the container (MP4/H.264 first, WebM only when nothing else exists)
 * so the clip plays back on the other phones in the album.
 */
const REC_MAX_MS = 60_000;
const REC_TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=h264',
  'video/webm;codecs=vp8',
  'video/webm',
];

const rec = { stream: null, mr: null, chunks: [], startedAt: 0, timer: null, mime: '', ext: 'mp4' };

function bestRecMime() {
  if (!window.MediaRecorder) return '';
  for (const t of REC_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {}
  }
  return '';
}

function recSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

async function openRecorder() {
  if (state.expired) return;

  if (!recSupported()) {
    toast('เครื่องนี้บันทึกวิดีโอในหน้าเว็บไม่ได้ — เลือกวิดีโอจากคลังได้เลย');
    $('#pickPhoto').click();
    return;
  }

  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    });
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    toast(denied ? 'ยังไม่ได้อนุญาตให้ใช้กล้อง — ใช้ “วิดีโอจากคลัง” แทนได้' : 'เปิดกล้องไม่ได้ — ใช้ “วิดีโอจากคลัง” แทน');
    return;
  }

  const preview = $('#recPreview');
  preview.srcObject = rec.stream;
  preview.muted = true;
  preview.play().catch(() => {});
  $('#recTime').textContent = '00:00';
  $('#recHint').textContent = 'อัดได้สูงสุด 60 วินาที · พอกดหยุด วิดีโอจะเข้าคิว “ตรวจก่อนส่ง”';
  $('#recToggle').textContent = 'เริ่มอัด';
  $('#recToggle').classList.add('primary');
  $('#recWrap').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeRecorder(stopStream = true) {
  clearInterval(rec.timer);
  rec.timer = null;

  if (rec.mr && rec.mr.state === 'recording') {
    try {
      rec.mr.stop();
    } catch {}
  }
  rec.mr = null;
  rec.chunks = [];

  if (stopStream && rec.stream) {
    rec.stream.getTracks().forEach((t) => t.stop());
    rec.stream = null;
  }
  const preview = $('#recPreview');
  if (preview) preview.srcObject = null;
  $('#recWrap').hidden = true;
  document.body.style.overflow = '';
}


function toggleRecording() {
  if (rec.mr && rec.mr.state === 'recording') {
    rec.mr.stop();
    return;
  }
  if (!rec.stream) return;

  rec.mime = bestRecMime();
  rec.ext = /mp4/i.test(rec.mime) ? 'mp4' : 'webm';
  rec.chunks = [];

  const opts = { videoBitsPerSecond: 2_500_000 };
  if (rec.mime) opts.mimeType = rec.mime;

  try {
    rec.mr = new MediaRecorder(rec.stream, opts);
  } catch {
    try {
      rec.mr = new MediaRecorder(rec.stream);
      rec.mime = rec.mr.mimeType || '';
      rec.ext = /mp4/i.test(rec.mime) ? 'mp4' : 'webm';
    } catch {
      toast('เครื่องนี้บันทึกวิดีโอไม่ได้ — ใช้ “วิดีโอจากคลัง” แทน');
      closeRecorder(true);
      return;
    }
  }

  rec.mr.ondataavailable = (e) => {
    if (e.data && e.data.size) rec.chunks.push(e.data);
  };

  rec.mr.onstop = () => {
    clearInterval(rec.timer);
    rec.timer = null;
    // MediaRecorder reports e.g. "video/mp4;codecs=avc1…"; keep only the media type
    // so the stored object is served as plain video/mp4 (parameters confuse players).
    const type = (rec.mime || 'video/webm').split(';')[0];
    const blob = new Blob(rec.chunks, { type });
    rec.chunks = [];
    closeRecorder(true);

    if (blob.size < 20_000) {
      toast('คลิปสั้นเกินไป ลองอัดใหม่');
      return;
    }
    const file = new File([blob], `clip-${makeId()}.${rec.ext}`, { type });
    const limitMb = state.cfg.maxVideoMb || 80;
    if (file.size > limitMb * MB) {
      toast(`คลิปใหญ่เกิน ${limitMb} MB — อัดให้สั้นลง`);
      return;
    }
    addFiles([file], 'video');
    toast('อัดเสร็จแล้ว — ตรวจก่อนกดอัปโหลด');
  };

  rec.mr.start(1000);
  rec.startedAt = Date.now();
  $('#recToggle').textContent = 'หยุดอัด';
  $('#recToggle').classList.remove('primary');
  $('#recHint').textContent = 'กำลังอัด… กด “หยุดอัด” เมื่อพอแล้ว';

  rec.timer = setInterval(() => {
    const ms = Date.now() - rec.startedAt;
    $('#recTime').textContent = fmtTime(ms);
    if (ms >= REC_MAX_MS && rec.mr && rec.mr.state === 'recording') {
      toast('ครบ 60 วินาทีแล้ว');
      rec.mr.stop();
    }
  }, 250);
}

/* ───────────────────────────── upload queue ───────────────────────────── */

/**
 * Object ids sort by key in R2, and R2 lists ascending — so a plain epoch put
 * the OLDEST photo on page 1. Inverting the timestamp makes the newest upload
 * the smallest key, i.e. the first thing a guest sees.
 */
const ID_MAX = 9_999_999_999_999;

function makeId() {
  const rand = Math.random().toString(16).slice(2, 8);
  return `${ID_MAX - Date.now()}-${rand}`;
}

function renderQueueItem(item) {
  const li = document.createElement('li');
  li.className = 'qItem';

  const thumb = document.createElement('img');
  thumb.className = 'qThumb';
  thumb.alt = '';
  if (/^image\//.test(item.file.type)) thumb.src = URL.createObjectURL(item.file);

  const mid = document.createElement('div');
  mid.className = 'qMid';
  const name = document.createElement('div');
  name.className = 'qName';
  name.textContent = item.file.name || (item.kind === 'video' ? 'วิดีโอ' : 'รูปภาพ');
  const st = document.createElement('div');
  st.className = 'qState';
  st.textContent = 'รอส่ง…';
  const bar = document.createElement('div');
  bar.className = 'progress';
  const fill = document.createElement('div');
  fill.className = 'progressFill';
  bar.appendChild(fill);
  mid.append(name, st, bar);

  const right = document.createElement('div');
  right.className = 'qPct';
  right.textContent = '';

  const kill = document.createElement('button');
  kill.type = 'button';
  kill.className = 'qDel';
  kill.setAttribute('aria-label', 'ลบออกจากคิว');
  kill.title = 'ลบออกจากคิว';
  kill.textContent = '×';
  kill.addEventListener('click', () => dropQueued(item));

  li.append(thumb, mid, right, kill);
  item.el = { li, st, fill, pct: right, thumb, kill };
  $('#queue').prepend(li);
}

/** Remove a queue row that has not started (or is already sent). */
function dropQueued(item) {
  if (item.status === 'busy') {
    toast('กำลังส่งอยู่ — รอให้เสร็จก่อน');
    return;
  }
  item.el?.kill?.setAttribute('disabled', '');
  state.queue = state.queue.filter((x) => x !== item);
  item.el?.li?.remove();
  if (!state.queue.length) $('#queueWrap').hidden = true;
  pump();
}

function pump() {
  while (state.active < MAX_PARALLEL) {
    const next = state.queue.find((i) => i.status === 'wait');
    if (!next) break;
    runUpload(next);
  }
  const failed = state.queue.some((i) => i.status === 'fail' && !i.permanent);
  $('#retryAll').hidden = !failed;
}

/* ─────────────────── durable queue (survives a closed tab) ─────────────────── */

/** Banner + tab title so a guest knows files are still waiting. */
async function updatePendingBanner() {
  const bar = $('#pendingBanner');
  if (!bar) return;
  const unsent = state.queue.filter((i) => i.status === 'wait' || i.status === 'fail').length;
  let stored = { files: 0, bytes: 0 };
  try {
    stored = await queueStats();
  } catch {
    stored = { files: 0, bytes: 0 };
  }
  const files = Math.max(unsent, stored.files);

  if (!files) {
    bar.hidden = true;
    document.title = document.title.replace(/^\(\d+\)\s*/, '');
    return;
  }

  const mb = stored.bytes ? ` (${(stored.bytes / 1048576).toFixed(1)} MB)` : '';
  $('#pendingText').textContent = `มี ${files} ไฟล์รอส่ง${mb}`;
  bar.hidden = false;
  document.title = `(${files}) ภาพความทรงจำ`;
}

/** Re-add whatever was still queued when the tab was closed. */
async function restoreQueue() {
  let rows = [];
  try {
    rows = await queueList();
  } catch {
    return;
  }
  if (!rows.length) return;

  const now = Date.now();
  let restored = 0;
  for (const row of rows) {
    if (now - row.ts > 24 * 60 * 60 * 1000) {
      await queueRemove(row.id);
      continue;
    }
    if (state.queue.some((q) => q.id === row.id)) continue;
    const file = new File([row.blob], row.name || `${row.id}.jpg`, {
      type: row.type || 'image/jpeg',
    });
    const item = {
      id: row.id,
      file,
      guest: row.guest || state.guest || 'Guest',
      kind: row.kind || 'photo',
      frame: row.frame || '',
      status: 'wait',
      tries: 0,
      restored: true,
    };
    state.queue.push(item);
    renderQueueItem(item);
    restored += 1;
  }

  if (restored) {
    $('#queueWrap').hidden = false;
    toast(`กู้คืน ${restored} ไฟล์ที่ยังไม่ได้ส่ง`, 5000);
    pump();
  }
  updatePendingBanner();
}

function bindPendingBanner() {
  $('#pendingRetry')?.addEventListener('click', () => {
    for (const item of state.queue) {
      if (item.status === 'fail') {
        item.status = 'wait';
        item.tries = 0;
        setItemState(item, 'รอส่ง…', 0);
      }
    }
    pump();
    toast('กำลังลองส่งอีกครั้ง');
  });

  $('#pendingClear')?.addEventListener('click', async () => {
    if (!confirm('ลบไฟล์ที่ยังไม่ได้ส่งออกจากเครื่องนี้?')) return;
    await queueClear();
    state.queue = state.queue.filter((i) => i.status === 'done' || i.status === 'busy');
    $('#queue').innerHTML = '';
    for (const item of state.queue) renderQueueItem(item);
    updatePendingBanner();
  });

  // closing the tab with unsent files is the one action that loses them
  window.addEventListener('beforeunload', (e) => {
    const unsent = state.queue.some((i) => i.status === 'wait' || i.status === 'fail');
    if (!unsent) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

async function runUpload(item) {
  state.active++;
  item.status = 'busy';
  if (item.el?.kill) item.el.kill.disabled = true;
  setItemState(item, 'กำลังเตรียม…', 0);

  try {
    const prepared =
      item.kind === 'video' ? await prepVideo(item.file) : await prepPhoto(item.file);

    // Persist BEFORE the network call: if the tab dies mid-upload the file is
    // still here on the next visit. Storing the original file means a restore
    // simply runs the same pipeline again.
    item.persisted = await queuePut({
      id: item.id,
      file: item.file,
      guest: item.guest,
      kind: item.kind,
      frame: item.frame,
    });
    if (!item.persisted) {
      console.warn('[queue] not persisted', {
        id: item.id,
        hasFile: Boolean(item.file),
        size: item.file && item.file.size,
      });
    }
    updatePendingBanner();

    setItemState(item, 'กำลังส่ง…', 0);
    await sendAll(item, prepared);

    item.status = 'done';
    setItemState(item, '✓ ส่งแล้ว', 1, 'ok');
    await queueRemove(item.id);
    updatePendingBanner();
    if (item.el?.thumb?.src) setTimeout(() => URL.revokeObjectURL(item.el.thumb.src), 5000);
  } catch (e) {
    const info = explainError(e);

    // a duplicate id means an earlier attempt already stored this photo
    if (info.duplicate) {
      item.status = 'done';
      setItemState(item, '✓ ส่งแล้ว', 1, 'ok');
      await queueRemove(item.id);
      updatePendingBanner();
      return;
    }

    item.tries = info.retry ? item.tries + 1 : 3;
    item.status = item.tries >= 3 ? 'fail' : 'wait';
    item.permanent = !info.retry;

    if (info.retry) {
      const exhausted = item.status === 'fail';
      setItemState(
        item,
        exhausted ? `✕ ${info.text} — เก็บไว้ในเครื่อง` : `จะลองใหม่… (${item.tries}/3)`,
        0,
        exhausted ? 'bad' : ''
      );
      if (exhausted) toast('ยังส่งไม่ได้ — เก็บไฟล์ไว้ให้ลองใหม่ภายหลัง', 5000);
      // keep it in IndexedDB: the next visit can finish the job
    } else {
      setItemState(item, `✕ ${info.text}`, 0, 'bad');
      toast(`${info.text} (${info.tag})`, 5000);
      await queueRemove(item.id);
    }
    item.lastError = info;
    updatePendingBanner();
  } finally {
    state.active--;
    if (item.el?.kill) item.el.kill.disabled = false;
    pump();
    if (state.active === 0 && state.queue.every((i) => i.status !== 'wait' && i.status !== 'busy')) {
      const batch = state.queue.filter((i) => state.batchIds.has(i.id));
      const ok = batch.filter((i) => i.status === 'done').length;
      const failed = batch.filter((i) => i.status === 'fail').length;
      if (ok || failed) showDone(ok, failed);
      if (ok) {
        toast(`ส่งสำเร็จ ${ok} ไฟล์`);
        // Do not re-fetch the album unconditionally: the guest who just uploaded
        // is still on the shoot tab, and a fresh list + a page of thumbnails is
        // two requests he never looks at. Reload only when the album is on screen.
        resetAlbum();
        if (!$('#tab-album').hidden) loadMore().then(() => showMore());
      }
    }
  }
}

function setItemState(item, text, progress, cls = '') {
  if (!item.el) return;
  item.el.st.textContent = text;
  item.el.st.className = 'qState ' + cls;
  item.el.fill.style.width = `${Math.round(progress * 100)}%`;
  item.el.pct.textContent = progress > 0 && progress < 1 ? `${Math.round(progress * 100)}%` : '';
}

function retryFailed() {
  for (const item of state.queue) {
    if (item.status === 'fail') {
      item.status = 'wait';
      item.tries = 0;
      setItemState(item, 'รอส่ง…', 0);
    }
  }
  pump();
}

/* ───────────────────────────── image / video prep ───────────────────────────── */


async function loadBitmap(file) {
  // NOTE: never pass resizeWidth here — Chrome treats it as a target width and
  // will UPSCALE a small source (a 1x1 became 2600px, which then re-encoded to a
  // 25 KB file instead of the original 160 bytes). Decode at native size; memory
  // for a 12 MP photo peaks around 48 MB, which phones handle fine.
  const tries = [{ imageOrientation: 'from-image' }, {}];
  for (const opt of tries) {
    try {
      return await createImageBitmap(file, opt);
    } catch {
      /* next */
    }
  }
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode_failed'));
    img.src = URL.createObjectURL(file);
  });
}

function drawScaled(src, maxEdge) {
  const w = src.width || src.videoWidth;
  const h = src.height || src.videoHeight;
  if (!w || !h) throw new Error('no_dimensions');
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/**
 * กติกา: <=3MB ปล่อยเดิม / 3-5MB -> 2048px q0.85 / >5MB -> 1600px q0.80
 */
async function prepPhoto(file) {
  const sizeMb = file.size / MB;
  const isHeic = /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name || '');

  let src;
  try {
    src = await loadBitmap(file);
  } catch {
    // decode ไม่ได้ (เช่น HEIC บน Chrome) -> ส่งไฟล์เดิม ไม่มี thumbnail
    return { main: file, mainType: file.type || 'image/jpeg', mainExt: extOf(file), thumb: null };
  }

  const longEdge = Math.max(src.width || 0, src.height || 0);
  const needsWork = sizeMb > 3 || longEdge > 2048 || isHeic;

  let main = file;
  let mainType = file.type || 'image/jpeg';
  let mainExt = extOf(file);

  if (needsWork) {
    const target = sizeMb > 5 ? 1600 : 2048;
    let quality = sizeMb > 5 ? 0.8 : 0.85;
    const canvas = drawScaled(src, target);
    let blob = await toBlob(canvas, quality);
    for (let i = 0; i < 4 && blob && blob.size > 2 * MB && quality > 0.7; i++) {
      quality -= 0.05;
      blob = await toBlob(canvas, quality);
    }
    if (blob && blob.size > 0) {
      // Safety net: never ship a "compressed" file that is bigger than the
      // original (happens with tiny images, already-optimised JPEGs, or when
      // the source is smaller than our resize target).
      if (blob.size < file.size || isHeic) {
        main = blob;
        mainType = 'image/jpeg';
        mainExt = 'jpg';
      }
    }
  }

  let thumb = null;
  try {
    thumb = await toBlob(drawScaled(src, 480), 0.7);
  } catch {
    thumb = null;
  }

  if (typeof src.close === 'function') {
    try {
      src.close();
    } catch {}
  }

  return { main, mainType, mainExt, thumb };
}

async function prepVideo(file) {
  const ext = extOf(file) || 'mp4';
  let poster = null;
  try {
    poster = await grabPoster(file);
  } catch {
    poster = null;
  }
  return { main: file, mainType: file.type || 'video/mp4', mainExt: ext, poster };
}

function grabPoster(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      reject(new Error('poster_failed'));
    };
    const timer = setTimeout(fail, 8000);

    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.src = url;

    video.onloadeddata = async () => {
      try {
        const t = Math.min(1, (video.duration || 2) / 3);
        await new Promise((res) => {
          video.onseeked = res;
          video.currentTime = t;
          setTimeout(res, 2000);
        });
        const blob = await toBlob(drawScaled(video, 480), 0.7);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        resolve(blob);
      } catch {
        fail();
      }
    };
    video.onerror = fail;
  });
}

/* ───────────────────────────── network ───────────────────────────── */

function xhrPut(url, blob, type, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('content-type', type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / Math.max(1, e.total));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.status);
      else {
        let code = 'HTTP ' + xhr.status;
        try {
          code = JSON.parse(xhr.responseText).error || code;
        } catch {}
        const err = new Error(code);
        err.status = xhr.status;
        err.code = code;
        reject(err);
      }
    };
    xhr.onerror = () => {
      const err = new Error('network');
      err.code = 'network';
      reject(err);
    };
    xhr.ontimeout = () => {
      const err = new Error('timeout');
      err.code = 'timeout';
      reject(err);
    };
    xhr.timeout = 240000;
    xhr.send(blob);
  });
}

async function sendAll(item, prepared) {
  const base = (kind, ext) =>
    `/api/upload?${new URLSearchParams({
      e: state.code,
      id: item.id,
      kind,
      ext,
      name: item.guest,
      ...(item.frame ? { frame: item.frame } : {}),
    })}`;

  const steps = [];
  if (item.kind === 'video') {
    steps.push({ kind: 'video', ext: prepared.mainExt, blob: prepared.main, type: prepared.mainType, weight: 0.9 });
    if (prepared.poster) steps.push({ kind: 'poster', ext: 'jpg', blob: prepared.poster, type: 'image/jpeg', weight: 0.1 });
  } else {
    steps.push({ kind: 'photo', ext: prepared.mainExt, blob: prepared.main, type: prepared.mainType, weight: 0.85 });
    if (prepared.thumb) steps.push({ kind: 'thumb', ext: 'jpg', blob: prepared.thumb, type: 'image/jpeg', weight: 0.15 });
  }

  let doneWeight = 0;
  for (const step of steps) {
    await xhrPut(base(step.kind, step.ext), step.blob, step.type, (p) => {
      const overall = doneWeight + p * step.weight;
      setItemState(item, 'กำลังส่ง…', overall);
    });
    doneWeight += step.weight;
  }
}

/* ───────────────────────────── gallery ───────────────────────────── */

/**
 * Bundled thumbnails — one request per page instead of one per photo.
 *
 * The Worker answers `GET /api/page?k=<keys>` with `multipart/mixed`: one JSON
 * index part, then one part per thumbnail carrying its `x-key`. The browser has
 * no native reader for that, so this splits the buffer back into blobs and
 * hands each tile a `blob:` URL.
 *
 * Anything unexpected (old deploy, proxy rewriting the body, a missing part)
 * throws, the caller counts the failure, and after two failures the gallery
 * silently returns to one request per photo — a bundle must never be able to
 * empty the album.
 */
const BUNDLE_MAX = 8; // matches the Worker cap
const CRLF2 = new Uint8Array([13, 10, 13, 10]);

function indexOfBytes(hay, needle, from) {
  const end = hay.length - needle.length;
  outer: for (let i = Math.max(0, from); i <= end; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function splitParts(buf, boundary) {
  const mark = new TextEncoder().encode('--' + boundary);
  const cuts = [];
  let at = indexOfBytes(buf, mark, 0);
  while (at >= 0) {
    cuts.push(at);
    at = indexOfBytes(buf, mark, at + mark.length);
  }

  const parts = [];
  for (let n = 0; n < cuts.length - 1; n++) {
    const start = cuts[n] + mark.length;
    const end = cuts[n + 1];
    if (buf[start] === 45 && buf[start + 1] === 45) break; // closing "--"
    const hEnd = indexOfBytes(buf, CRLF2, start);
    if (hEnd < 0 || hEnd > end) continue;

    const head = new TextDecoder().decode(buf.subarray(start, hEnd));
    const key = /x-key:\s*([^\r\n]+)/i.exec(head);
    if (!key) continue;
    const type = /content-type:\s*([^\r\n]+)/i.exec(head);

    let bodyEnd = end;
    while (bodyEnd > hEnd + 4 && (buf[bodyEnd - 1] === 10 || buf[bodyEnd - 1] === 13)) bodyEnd--;

    parts.push({
      key: key[1].trim(),
      blob: new Blob([buf.subarray(hEnd + 4, bodyEnd)], {
        type: type ? type[1].trim() : 'image/jpeg',
      }),
    });
  }
  return parts;
}

/** Fetch the thumbnails for up to BUNDLE_MAX items in one request. */
async function bundleChunk(items) {
  const keys = [];
  for (const it of items) {
    if (it._src || it.type === 'video') continue;
    const k = keyFromUrl(it.thumb);
    if (k && !keys.includes(k)) keys.push(k);
  }
  if (keys.length < 2) return; // one image is not worth a round trip

  const url = '/api/page' + q() + '&k=' + encodeURIComponent(keys.join(','));
  const r = await fetch(url);
  if (!r.ok) throw new Error('bundle_' + r.status);

  const m = /boundary=([^;]+)/i.exec(r.headers.get('content-type') || '');
  if (!m) throw new Error('bundle_boundary');

  const parts = splitParts(new Uint8Array(await r.arrayBuffer()), m[1].replace(/"/g, '').trim());
  if (!parts.length) throw new Error('bundle_empty');

  const byKey = new Map(parts.map((p) => [p.key, p.blob]));
  for (const it of items) {
    const blob = byKey.get(keyFromUrl(it.thumb));
    if (blob) it._src = URL.createObjectURL(blob);
  }
}

async function bundleThumbs(items) {
  if (state.bundleOff || items.length < 2) return;

  // The Worker answers with as many thumbnails as its CPU byte budget allows,
  // which can be fewer than asked. Rather than drop the rest onto one request
  // each, ask again for whatever is still missing: 8 keys -> 5 back -> 3 keys
  // -> 3 back. Each pass sends less, so it finishes in one or two extra calls.
  let pending = items.filter((it) => !it._src && it.type !== 'video' && keyFromUrl(it.thumb));

  for (let pass = 0; pass < 4 && pending.length >= 2; pass++) {
    const before = pending.length;
    await bundleChunk(pending.slice(0, BUNDLE_MAX));
    pending = pending.filter((it) => !it._src);
    if (pending.length === before) break; // nothing came back: use plain requests
  }
}

/** Pagination: the album shows PAGE_SIZE photos at a time. The API page (≈60-96
 *  items) stays in `state.items` as a buffer, so clicking "ดูรูปถัดไป" costs no
 *  network until the buffer runs out — good for the request quota on event day. */
async function loadMore() {
  if (state.loading || state.expired) return;
  state.loading = true;

  try {
    const url = '/api/list' + q() + (state.cursor ? `&cursor=${encodeURIComponent(state.cursor)}` : '');
    const r = await fetch(url, { cache: 'no-store' });
    if (r.status === 410) return setExpired();
    if (r.status === 429 || r.status === 503) {
      toast('ระบบเต็มโควตาของวันนี้ — ลองใหม่อีกครั้งหลัง 07:00 น.', 6000);
      return;
    }
    if (!r.ok) throw new Error('list_failed');
    const data = await r.json();

    for (const item of data.items || []) {
      if (state.byId.has(item.id)) continue;
      state.byId.set(item.id, item);
      state.items.push(item);
    }

    state.cursor = data.cursor || null;
    if (state.cursor) state.page += 1;
  } catch {
    toast('โหลดอัลบั้มไม่สำเร็จ ลองอีกครั้ง');
  } finally {
    state.loading = false;
  }
}

/** Forget the rendered album so the next visit to the tab reloads it.
 *  Blob URLs are revoked here; without that every upload batch leaks a page of
 *  thumbnails into memory. */
function resetAlbum() {
  for (const it of state.items) if (it._src) URL.revokeObjectURL(it._src);
  state.items = [];
  state.revealed = 0;
  state.byId.clear();
  state.cursor = null;
  state.page = 1;
  $('#grid').innerHTML = '';
  $('#grid').classList.remove('simple');
  updateMoreBtn();
  updateAlbumMeta();
}

/** Render `count` more photos from the buffer, fetching a new API page if needed. */
async function showMore(count = PAGE_SIZE) {
  if (state.expired) return;

  if (state.revealed >= state.items.length && state.cursor) {
    $('#moreBtn').disabled = true;
    $('#moreBtn').textContent = 'กำลังโหลด…';
    await loadMore();
    $('#moreBtn').disabled = false;
  }

  const from = state.revealed;
  const to = Math.min(state.items.length, from + count);

  // one request for the whole batch of thumbnails (was one per photo)
  if (to - from > 1) {
    try {
      await bundleThumbs(state.items.slice(from, to));
    } catch {
      state.bundleFails += 1;
      if (state.bundleFails >= 2) state.bundleOff = true;
    }
  }

  for (let i = from; i < to; i++) renderTile(state.items[i], i);
  state.revealed = to;

  // >120 stamps on screen: drop the perforation mask to keep scrolling smooth
  $('#grid').classList.toggle('simple', state.revealed > 120);
  updateAlbumMeta();
}

function updateMoreBtn() {
  const buffered = state.items.length - state.revealed;
  const left = buffered + (state.cursor ? PAGE_SIZE : 0);
  const more = buffered > 0 || !!state.cursor;
  $('#moreBtn').hidden = !more;
  $('#moreBtn').textContent = more ? `ดูรูปถัดไป (${Math.min(PAGE_SIZE, left)})` : 'โหลดเพิ่ม';
  $('#albumEmpty').hidden = state.items.length > 0 || !!state.cursor;
}

function updateAlbumMeta() {
  const loaded = state.items.length;
  const shown = state.revealed;
  $('#pageTitle').textContent = 'ภาพความทรงจำ';

  if (!loaded) {
    $('#albumCount').textContent = '—';
    updateMoreBtn();
    return;
  }

  const total = loaded + (state.cursor ? '+' : '');
  $('#albumCount').textContent =
    shown < loaded ? `แสดง ${shown} จาก ${total} รูป` : `${shown} รูป${state.cursor ? ' · ยังมีต่อ' : ''}`;
  updateMoreBtn();
}

const TILT = [-1.2, 0.8, -0.6, 1.1, -0.9, 0.5];

const ICON = {
  photo:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m21 15.5-4.5-4.5L7 20.5"/></svg>',
  video:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6.5" width="13" height="11" rx="2.5"/><path d="m15.5 11 5-3v8l-5-3"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  wreath:
    '<svg viewBox="0 0 120 120" aria-hidden="true">' +
    '<defs><path id="wleaf" d="M60 9c4.4 4.6 4.4 11.4 0 16-4.4-5.2-4.4-12 0-16z"/></defs>' +
    '<g fill="none" stroke="#637F4F" stroke-width="2.8" stroke-linejoin="round">' +
    [0, 36, 72, 108, 144, 180, 216, 252, 288, 324]
      .map((a) => `<use href="#wleaf" transform="rotate(${a} 60 60)"/>`)
      .join('') +
    '</g><g fill="#C0A062">' +
    [18, 54, 90, 126, 162, 198, 234, 270, 306, 342]
      .map((a) => `<circle cx="60" cy="17" r="1.7" transform="rotate(${a} 60 60)"/>`)
      .join('') +
    '</g></svg>',
};

/** Stable per-photo pseudo-random: the same id always gets the same frame and size,
 *  so the album never reshuffles when a page is added or the tab is reopened. */

function renderTile(item, idx) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tile';
  btn.style.setProperty('--r', `${TILT[idx % TILT.length]}deg`);

  const h = hashOf(item.id);
  const r = h % 20;

  // frame: the guest's choice wins, otherwise a stable random frame
  btn.classList.add(item.frame || `v${h % 6}`);

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = '';
  // listen BEFORE the src is set: a cached thumbnail can fire `load` in the same
  // tick, and a missed event leaves the tile on the default 3:4 frame.
  // The arrow defers the lookup: `shape` is declared further down.
  img.addEventListener('load', () => shape());
  img.addEventListener('error', () => {
    shaped = true;
    if (!btn.style.getPropertyValue('--ar')) btn.style.setProperty('--ar', '3 / 4');
    img.remove();
    const ph = document.createElement('span');
    ph.className = 'ph';
    ph.innerHTML = item.type === 'video' ? ICON.video : ICON.photo;
    btn.appendChild(ph);
  });
  img.src = item._src || item.thumb || item.url;
  btn.appendChild(img);

  /**
   * The frame takes the photo's real ratio (portrait 3:4, landscape 4:3, 16:9
   * screenshots, square crops — whatever it is), so the image fills the frame
   * with nothing cropped. Extreme panoramas are clamped so one photo cannot
   * turn into a sliver.
   */
  let shaped = false;
  const addPostmark = () => {
    const pm = document.createElement('span');
    pm.className = 'postmark';
    pm.innerHTML =
      ICON.wreath + `<span>${state.cfg.date ? shortDate(state.cfg.date) : '★'}</span>`;
    btn.appendChild(pm);
  };

  const shape = () => {
    if (shaped) return;
    const iw = img.naturalWidth || 0;
    const ih = img.naturalHeight || 0;
    if (!iw || !ih) return;
    shaped = true;

    const ar = iw / ih;
    const clamped = Math.min(2.2, Math.max(0.5, ar));
    btn.style.setProperty('--ar', clamped === ar ? `${iw} / ${ih}` : String(clamped));
    if (r < 3) addPostmark();
  };

  img.addEventListener('load', shape);
  if (img.complete) shape();

  if (item.guest) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = item.guest;
    btn.appendChild(badge);
  }

  if (item.type === 'video') {
    const v = document.createElement('span');
    v.className = 'vbadge';
    v.innerHTML = ICON.play;
    btn.appendChild(v);
  }

  const check = document.createElement('span');
  check.className = 'check';
  check.setAttribute('role', 'checkbox');
  check.setAttribute('aria-label', 'เลือก');
  check.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSelect(item.id, btn);
  });
  btn.appendChild(check);

  btn.addEventListener('click', () => openLightbox(item));

  $('#grid').appendChild(btn);
  item.el = btn;
  if (state.selected.has(item.id)) btn.classList.add('sel');
}

function toggleSelect(id, el) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  el.classList.toggle('sel', state.selected.has(id));
}

function toggleSelectAll() {
  const allSelected = state.items.length > 0 && state.items.every((i) => state.selected.has(i.id));
  state.selected.clear();
  for (const item of state.items) {
    if (!allSelected) state.selected.add(item.id);
    item.el?.classList.toggle('sel', !allSelected);
  }
}

/* ───────────────────────────── lightbox ───────────────────────────── */

function openLightbox(item) {
  const body = $('#lbBody');
  body.innerHTML = '';

  if (item.type === 'video') {
    const v = document.createElement('video');
    v.src = item.url;
    v.controls = true;
    v.playsInline = true;
    v.autoplay = true;
    v.setAttribute('playsinline', '');
    body.appendChild(v);
  } else {
    const img = document.createElement('img');
    img.src = item.url;
    img.alt = '';
    body.appendChild(img);
  }

  $('#lbMeta').textContent = item.guest || '';
  state.lbItem = item;
  state.lbFrame = '';
  state.lbPreview = null;
  state.lbImage = null;
  renderLbFrames();
  $('#lbNote').hidden = true;
  $('#lbDownload').textContent = item.type === 'video' ? 'ดาวน์โหลดวิดีโอ' : 'ดาวน์โหลดภาพนี้';
  $('#lbFrames').hidden = item.type === 'video';

  $('#lightbox').hidden = false;
  document.body.style.overflow = 'hidden';
}

/* ── single-image download, with an optional frame baked in ───────────
   The album grid shows frames with CSS only, so the ZIP always contains the
   untouched originals. A guest who wants a framed copy picks a frame here and
   the PNG is drawn on a canvas at full resolution. */

const LB_FRAMES = [
  { id: '', name: 'ไม่ใส่กรอบ' },
  { id: 'v0', name: 'ขอบปรุ' },
  { id: 'v1', name: 'ทองคู่' },
  { id: 'v2', name: 'มุมทอง' },
  { id: 'v3', name: 'สันอัลบั้ม' },
  { id: 'v4', name: 'แอร์เมล' },
  { id: 'v5', name: 'มุมโค้ง' },
];

function renderLbFrames() {
  const box = $('#lbFrames');
  box.innerHTML = '';
  for (const f of LB_FRAMES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(state.lbFrame === f.id));
    btn.setAttribute('aria-label', f.name);
    btn.title = f.name;

    const mini = document.createElement('span');
    mini.className = `tile ${f.id || 'none'}`;
    mini.setAttribute('aria-hidden', 'true');
    btn.appendChild(mini);

    btn.addEventListener('click', () => {
      state.lbFrame = f.id;
      renderLbFrames();
      previewFrame();
    });
    box.appendChild(btn);
  }
}

/** Show the framed result in the lightbox itself, before any download happens. */
async function previewFrame() {
  const item = state.lbItem;
  const img = $('#lbBody img');
  if (!item || !img || item.type === 'video') return;

  if (state.lbPreview) {
    URL.revokeObjectURL(state.lbPreview);
    state.lbPreview = null;
  }

  if (!state.lbFrame) {
    img.src = item.url;
    img.classList.remove('framed');
    $('#lbNote').hidden = true;
    $('#lbDownload').textContent = 'ดาวน์โหลดภาพนี้';
    return;
  }

  $('#lbNote').hidden = false;
  $('#lbNote').textContent = 'กำลังใส่กรอบ…';
  $('#lbDownload').textContent = 'ดาวน์โหลดภาพนี้';

  try {
    const blob = await framedBlob(item.url, state.lbFrame, 1600);
    state.lbPreview = URL.createObjectURL(blob);
    img.src = state.lbPreview;
    // the PNG carries its own paper margin and punched-through perforation:
    // drop the viewer's white padding so nothing hides the holes
    img.classList.add('framed');
    const name = LB_FRAMES.find((f) => f.id === state.lbFrame)?.name || '';
    $('#lbNote').textContent = `ตัวอย่างกรอบ: ${name} · ไฟล์ที่จะได้เป็น PNG`;
  } catch {
    $('#lbNote').textContent = 'แสดงตัวอย่างไม่ได้ — ดาวน์โหลดยังใช้ได้';
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image_load_failed'));
    img.src = url;
  });
}

function drawFrame(ctx, paper, pad, frame) {
  const { x, y, w, h } = paper;
  const gold = '#c0a062';
  const blush = '#efc7c8';
  const blushDeep = '#e6acaa';
  const coral = '#c0554c';

  if (frame === 'v1') {
    // both rules sit inside the paper edge: no white band outside the frame
    const lw = Math.max(2, pad * 0.09);
    ctx.strokeStyle = gold;
    ctx.lineWidth = lw;
    ctx.strokeRect(x + lw / 2, y + lw / 2, w - lw, h - lw);

    const i2 = pad * 0.55;
    ctx.strokeStyle = '#e8ded1';
    ctx.lineWidth = Math.max(1, pad * 0.04);
    ctx.strokeRect(x + i2, y + i2, w - i2 * 2, h - i2 * 2);
  }

  if (frame === 'v2') {
    const len = pad * 1.2;
    const lw = Math.max(2, pad * 0.08);
    const inset = lw / 2 + 1;
    ctx.strokeStyle = gold;
    ctx.lineWidth = lw;
    ctx.lineCap = 'square';
    const L = [
      [x + inset, y + inset, 1, 1],
      [x + w - inset, y + inset, -1, 1],
      [x + inset, y + h - inset, 1, -1],
      [x + w - inset, y + h - inset, -1, -1],
    ];
    for (const [px, py, dx, dy] of L) {
      ctx.beginPath();
      ctx.moveTo(px + dx * len, py);
      ctx.lineTo(px, py);
      ctx.lineTo(px, py + dy * len);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  if (frame === 'v3') {
    ctx.fillStyle = blush;
    ctx.fillRect(x, y, pad * 0.75, h);
    ctx.fillStyle = blushDeep;
    ctx.fillRect(x, y + h - pad * 0.45, w, pad * 0.45);
  }

  if (frame === 'v4') {
    const stripe = pad * 0.45;
    ctx.save();
    ctx.lineWidth = Math.max(2, pad * 0.16);
    ctx.strokeStyle = coral;
    // both bands: the top strip AND the bottom strip (they were drawn as one path
    // before, so the bottom edge came out empty)
    for (const bandY of [y, y + h - stripe]) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, bandY, w, stripe);
      ctx.clip();
      for (let sx = x - h; sx < x + w + h; sx += ctx.lineWidth * 2) {
        ctx.beginPath();
        ctx.moveTo(sx, bandY);
        ctx.lineTo(sx + stripe, bandY + stripe);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  if (frame === 'v5') {
    const lw = Math.max(2, pad * 0.08);
    const r = Math.min(w, h) * 0.05;
    ctx.strokeStyle = gold;
    ctx.lineWidth = lw;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x + lw / 2, y + lw / 2, w - lw, h - lw, r);
    } else {
      ctx.rect(x + lw / 2, y + lw / 2, w - lw, h - lw);
    }
    ctx.stroke();
  }
}

async function framedBlob(url, frame, maxSide = 0) {
  const img = await loadImage(url);
  const scale = maxSide && Math.max(img.naturalWidth, img.naturalHeight) > maxSide
    ? maxSide / Math.max(img.naturalWidth, img.naturalHeight)
    : 1;
  const srcW = Math.round(img.naturalWidth * scale);
  const srcH = Math.round(img.naturalHeight * scale);
  // Margin from the geometric mean, not the short side: a 9:19.5 phone screenshot
  // would otherwise get a hairline border (2% of its height) and look like the
  // photo spills over the frame.
  const pad = Math.max(16, Math.round(Math.sqrt(srcW * srcH) * 0.065));

  // The perforation holes sit ON the paper edge, so the canvas needs an extra
  // margin as wide as a hole; otherwise every hole is sliced in half by the
  // canvas border and the frame looks chopped off.
  const holeR = frame === 'v0' ? Math.max(3, Math.round(pad * 0.45)) : 0;
  const margin = holeR;

  const paper = { x: margin, y: margin, w: srcW + pad * 2, h: srcH + pad * 2 };
  const w = paper.w + margin * 2;
  const h = paper.h + margin * 2;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(paper.x, paper.y, paper.w, paper.h);
  ctx.drawImage(img, paper.x + pad, paper.y + pad, srcW, srcH);

  drawFrame(ctx, paper, pad, frame);

  if (frame === 'v0') {
    const step = holeR * 2.6;
    ctx.globalCompositeOperation = 'destination-out';
    for (let cx = paper.x + step / 2; cx < paper.x + paper.w; cx += step) {
      for (const cy of [paper.y, paper.y + paper.h]) {
        ctx.beginPath();
        ctx.arc(cx, cy, holeR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (let cy = paper.y + step / 2; cy < paper.y + paper.h; cy += step) {
      for (const cx of [paper.x, paper.x + paper.w]) {
        ctx.beginPath();
        ctx.arc(cx, cy, holeR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function downloadFramed() {
  const item = state.lbItem;
  if (!item) return;

  const base = `${safeName(item.guest)}-${item.id}`;

  if (item.type === 'video') {
    const a = document.createElement('a');
    a.href = item.url;
    a.download = `${base}.mp4`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }

  if (!state.lbFrame) {
    saveBlob(await (await fetch(item.url)).blob(), `${base}.jpg`);
    toast('ดาวน์โหลดภาพต้นฉบับแล้ว');
    return;
  }

  toast('กำลังใส่กรอบ…');
  try {
    const blob = await framedBlob(item.url, state.lbFrame);
    saveBlob(blob, `${base}-${state.lbFrame}.png`);
    toast('ดาวน์โหลดภาพพร้อมกรอบแล้ว');
  } catch {
    toast('ใส่กรอบไม่สำเร็จ — ดาวน์โหลดต้นฉบับแทน');
    saveBlob(await (await fetch(item.url)).blob(), `${base}.jpg`);
  }
}

function closeLightbox() {
  const body = $('#lbBody');
  const vid = body.querySelector('video');
  if (vid) vid.pause();
  body.innerHTML = '';
  if (state.lbPreview) {
    URL.revokeObjectURL(state.lbPreview);
    state.lbPreview = null;
  }
  state.lbItem = null;
  $('#lightbox').hidden = true;
  document.body.style.overflow = '';
}

/* ───────────────────────────── ZIP export ───────────────────────────── */

/**
 * Walk every album page, so "ดาวน์โหลดทั้งหมด" means the whole album and not
 * only the pages the guest happened to scroll to (the old behaviour silently
 * produced an incomplete archive).
 */
async function allAlbumItems(onProgress) {
  const out = [];
  const seen = new Set();
  let cursor = null;

  for (let page = 0; page < 400; page++) {
    const url = '/api/list' + q() + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const r = await fetch(url, { cache: 'no-store' });
    if (r.status === 410) {
      setExpired();
      break;
    }
    if (!r.ok) break;
    const data = await r.json();
    for (const it of data.items || []) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      out.push(it);
    }
    if (onProgress) onProgress(out.length);
    cursor = data.cursor;
    if (!cursor) break;
  }
  return out;
}

async function startZip() {
  let picked = state.items.filter((i) => state.selected.has(i.id));

  const panel = $('#zipPanel');
  const bar = $('#zipBar');
  const pct = $('#zipPct');
  const msg = $('#zipMsg');

  // nothing selected = the whole album, fetched page by page
  if (!picked.length) {
    panel.hidden = false;
    $('#zipTitle').textContent = 'กำลังรวบรวมรายการ';
    bar.style.width = '0%';
    pct.textContent = '';
    msg.textContent = 'อ่านรายการทั้งหมด…';
    picked = await allAlbumItems((n) => {
      msg.textContent = `พบ ${n} รายการ…`;
    });
    if (!picked.length) {
      panel.hidden = true;
      toast('ยังไม่มีรายการให้ดาวน์โหลด');
      return;
    }
  }

  const list = picked;

  const est = list.reduce((s, i) => s + (i.size || 0), 0);
  if (est > 3.5 * 1024 ** 3) {
    toast('ชุดที่เลือกใหญ่เกิน 3.5 GB — เลือกให้น้อยลงแล้วแบ่งดาวน์โหลด');
    return;
  }

  panel.hidden = false;
  msg.textContent = `${list.length} ไฟล์`;
  $('#zipTitle').textContent = 'กำลังสร้าง ZIP';

  const stamp = new Date().toISOString().slice(0, 10);
  const result = await buildZip(
    list.map((i, idx) => ({
      name: `${String(idx + 1).padStart(4, '0')}-${safeName(i.guest)}.${i.type === 'video' ? 'mp4' : 'jpg'}`,
      url: i.url,
      ts: i.ts,
    })),
    {
      filename: `wedding-album-${stamp}.zip`,
      estBytes: est,
      onProgress: (done, total) => {
        const p = total ? done / total : 0;
        bar.style.width = `${Math.round(p * 100)}%`;
        pct.textContent = `${Math.round(p * 100)}%`;
        msg.textContent = `${done} / ${total} ไฟล์`;
      },
    }
  );

  $('#zipTitle').textContent = 'เสร็จสิ้น';

  if (result.cancelled) msg.textContent = 'ยกเลิกแล้ว';
  else if (result.error === 'too_big') msg.textContent = 'ใหญ่เกิน 4 GB — แบ่งดาวน์โหลด';
  else if (result.error) msg.textContent = 'เกิดข้อผิดพลาด: ' + result.error;
  else msg.textContent = `เสร็จ — ${result.files} ไฟล์${result.failed ? ` (พลาด ${result.failed})` : ''}`;

  setTimeout(() => {
    panel.hidden = true;
    bar.style.width = '0%';
    pct.textContent = '0%';
  }, 4000);
}


/* ─────────────────────── thank-you card (client only) ─────────────────────── */

const CARD_W = 1240;
const CARD_H = 1748;
const CARD_FRAMES = [
  { id: 'gold', name: 'ทองคู่' },
  { id: 'stamp', name: 'ดวงตรา' },
  { id: 'plain', name: 'เรียบหรู' },
];
const card = { img: null, frame: 'gold' };

function cardImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // the Worker sends allow-origin: *
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function drawCover(ctx, img, x, y, w, h) {
  const iw = img.naturalWidth || img.width || w;
  const ih = img.naturalHeight || img.height || h;
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
  ctx.restore();
}

/** Perforated stamp edge: punch small paper-coloured holes along a rectangle. */
function punchEdge(ctx, x, y, w, h) {
  ctx.save();
  ctx.fillStyle = '#fbf8f3';
  const r = 9;
  const step = 34;
  for (let i = x + step / 2; i < x + w; i += step) {
    for (const yy of [y, y + h]) {
      ctx.beginPath();
      ctx.arc(i, yy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  for (let j = y + step / 2; j < y + h; j += step) {
    for (const xx of [x, x + w]) {
      ctx.beginPath();
      ctx.arc(xx, j, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function wrapText(ctx, text, cx, y, maxWidth, lineHeight) {
  const words = String(text).split(/\s+/);
  let line = '';
  const lines = [];
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  const startY = y - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((l, i) => ctx.fillText(l, cx, startY + i * lineHeight));
}

function paintCard(ctx) {
  const W = CARD_W;
  const H = CARD_H;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#fbf8f3';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = '#c0a062';
  ctx.lineWidth = 6;
  ctx.strokeRect(46, 46, W - 92, H - 92);
  ctx.lineWidth = 2;
  ctx.strokeRect(66, 66, W - 132, H - 132);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#3f5233';
  ctx.font = '600 56px "Cormorant Garamond", Georgia, serif';
  ctx.fillText(state.cfg.names || 'Thank you', W / 2, 196);

  ctx.fillStyle = '#6b7a5e';
  ctx.font = '400 28px "Sarabun", "Noto Sans Thai", sans-serif';
  ctx.fillText(state.cfg.date ? longDate(state.cfg.date) : '', W / 2, 250);

  const px = 150;
  const py = 320;
  const pw = W - 300;
  const ph = 880;

  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(63,82,51,0.14)';
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 10;
  ctx.fillRect(px - 18, py - 18, pw + 36, ph + 36);
  ctx.restore();

  if (card.img) {
    drawCover(ctx, card.img, px, py, pw, ph);
  } else {
    ctx.fillStyle = '#f3e2d2';
    ctx.fillRect(px, py, pw, ph);
    ctx.fillStyle = '#6b7a5e';
    ctx.font = '400 32px "Sarabun", "Noto Sans Thai", sans-serif';
    ctx.fillText('เลือกรูปเพื่อเริ่ม', W / 2, py + ph / 2);
  }

  if (card.frame === 'gold') {
    ctx.strokeStyle = '#c0a062';
    ctx.lineWidth = 4;
    ctx.strokeRect(px - 34, py - 34, pw + 68, ph + 68);
  } else if (card.frame === 'stamp') {
    punchEdge(ctx, px - 30, py - 30, pw + 60, ph + 60);
    ctx.strokeStyle = 'rgba(192,160,98,0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px - 30, py - 30, pw + 60, ph + 60);
  } else {
    ctx.strokeStyle = '#3f5233';
    ctx.lineWidth = 2;
    ctx.strokeRect(px - 12, py - 12, pw + 24, ph + 24);
  }

  const msg = ($('#cardMsg')?.value || '').trim() || 'ขอบคุณที่ร่วมเป็นส่วนหนึ่งในวันสำคัญของเรา';
  ctx.fillStyle = '#3f5233';
  ctx.font = '400 40px "Sarabun", "Noto Sans Thai", sans-serif';
  wrapText(ctx, msg, W / 2, 1330, W - 340, 58);

  const who = ($('#cardName')?.value || '').trim();
  if (who) {
    ctx.fillStyle = '#6b7a5e';
    ctx.font = '600 34px "Sarabun", "Noto Sans Thai", sans-serif';
    ctx.fillText(`— ${who}`, W / 2, 1470);
  }

  ctx.fillStyle = '#c0a062';
  ctx.font = '400 22px "Cormorant Garamond", Georgia, serif';
  ctx.fillText('T H E   W E D D I N G   C O L L E C T I O N', W / 2, H - 110);
}

function drawCard() {
  const cv = $('#cardCanvas');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  if (ctx) paintCard(ctx);
}

function renderCardFrames() {
  const box = $('#cardFrames');
  if (!box) return;
  box.innerHTML = '';
  for (const f of CARD_FRAMES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(card.frame === f.id));
    btn.title = f.name;
    const mini = document.createElement('span');
    mini.className = 'tile';
    mini.setAttribute('aria-hidden', 'true');
    mini.style.background =
      f.id === 'gold' ? '#c9a86a' : f.id === 'stamp' ? '#d9cbb0' : '#8a9a7b';
    btn.appendChild(mini);
    btn.addEventListener('click', () => {
      card.frame = f.id;
      renderCardFrames();
      drawCard();
      toast(`การ์ด: ${f.name}`);
    });
    box.appendChild(btn);
  }
}

async function pickCardFromAlbum() {
  if (!state.items.length) await loadMore();
  const photos = state.items.filter((i) => i.type === 'photo').slice(0, 6);
  if (!photos.length) return toast('ยังไม่มีรูปในอัลบั้ม');

  let row = $('#cardPicker');
  if (!row) {
    row = document.createElement('div');
    row.id = 'cardPicker';
    row.className = 'cardPicker';
    $('.cardPick')?.after(row);
  }
  row.innerHTML = '';
  for (const it of photos) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cardPickItem';
    const img = document.createElement('img');
    img.src = it._src || it.thumb || it.url;
    img.alt = '';
    btn.appendChild(img);
    btn.addEventListener('click', async () => {
      try {
        card.img = await cardImage(it.url);
        drawCard();
        row.remove();
        toast('ใส่รูปในการ์ดแล้ว');
      } catch {
        toast('โหลดรูปไม่สำเร็จ');
      }
    });
    row.appendChild(btn);
  }
}

function downloadCard() {
  const cv = $('#cardCanvas');
  if (!cv) return;
  if (!card.img) return toast('เลือกรูปก่อนดาวน์โหลด');
  cv.toBlob((blob) => {
    if (blob) saveBlob(blob, `thank-you-${Date.now()}.png`);
  }, 'image/png');
}

function bindCard() {
  renderCardFrames();
  drawCard();
  $('#cardPickAlbum')?.addEventListener('click', () => pickCardFromAlbum());
  $('#cardFile')?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      card.img = await cardImage(url);
      drawCard();
      toast('ใส่รูปในการ์ดแล้ว');
    } catch {
      toast('เปิดรูปนี้ไม่ได้');
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      e.target.value = '';
    }
  });
  $('#cardName')?.addEventListener('input', drawCard);
  $('#cardMsg')?.addEventListener('input', drawCard);
  $('#cardDownload')?.addEventListener('click', downloadCard);
}

bindCard();

// Cache Storage survives the browser evicting its HTTP cache, which is what
// makes a second visit free on iOS. Skipped inside LINE's in-app browser: it
// has a partial service-worker implementation, and a broken worker would be
// worse than no worker.
if ('serviceWorker' in navigator && !/\bLine\//i.test(navigator.userAgent)) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

boot();
