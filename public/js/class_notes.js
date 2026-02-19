import { get, post } from './api.js';
import { initProtected, normalizeLinks, showToast } from './main.js';

const state = {
  date: localDateText(),
  sessions: [],
  activeSession: null,
  activeNote: null,
  enforce: false,
  realtimeTimer: null,
};

const els = {
  dateInput: document.getElementById('notes-date'),
  sessionList: document.getElementById('notes-session-list'),
  pageSub: document.getElementById('notes-page-sub'),
  form: document.getElementById('class-note-form'),
  noteId: document.getElementById('note-id'),
  scheduleId: document.getElementById('note-schedule-id'),
  classDate: document.getElementById('note-class-date'),
  keyPoints: document.getElementById('note-key-points'),
  actionItems: document.getElementById('note-action-items'),
  questions: document.getElementById('note-questions'),
  freeText: document.getElementById('note-free-text'),
  moodFocus: document.getElementById('note-mood-focus'),
  confidence: document.getElementById('note-confidence'),
  minimumChip: document.getElementById('notes-minimum-chip'),
  aiSummary: document.getElementById('notes-ai-summary'),
  aiNext: document.getElementById('notes-ai-next'),
  aiRisk: document.getElementById('notes-ai-risk'),
  history: document.getElementById('notes-history-list'),
  chatCta: document.getElementById('notes-chat-cta'),
  gate: document.getElementById('notes-hardgate'),
  gateSub: document.getElementById('notes-hardgate-sub'),
  gateFocus: document.getElementById('notes-hardgate-focus'),
  exportMd: document.getElementById('notes-export-md'),
  exportPdf: document.getElementById('notes-export-pdf'),
};

const NOTES_REALTIME_POLL_MS = 30000;
const NOTES_AUTO_OPEN_PREFIX = 'class_notes_auto_open_v2:';

function localDateText() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseHmToMinutes(hm = '') {
  const m = String(hm || '').match(/^(\d{2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function currentMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function isToday(dateText = '') {
  return String(dateText || '').slice(0, 10) === localDateText();
}

function isSessionStarted(session, dateText) {
  if (!session) return false;
  if (!isToday(dateText)) return true;
  const startMin = parseHmToMinutes(session.time_start);
  if (!Number.isFinite(startMin)) return true;
  return startMin <= currentMinutes();
}

function minimumDoneFromForm() {
  return Boolean(
    String(els.keyPoints.value || '').trim() ||
    String(els.actionItems.value || '').trim() ||
    String(els.freeText.value || '').trim()
  );
}

function qs() {
  return new URLSearchParams(window.location.search);
}

function fileSafe(value = '') {
  return String(value || '')
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'catatan';
}

function weekRange(dateText = localDateText()) {
  const base = new Date(`${String(dateText || '').slice(0, 10)}T00:00:00`);
  if (Number.isNaN(base.getTime())) {
    return { from: localDateText(), to: localDateText() };
  }
  const day = base.getDay() === 0 ? 7 : base.getDay();
  base.setDate(base.getDate() - (day - 1));
  const end = new Date(base);
  end.setDate(base.getDate() + 6);
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const date = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${date}`;
  };
  return { from: fmt(base), to: fmt(end) };
}

function downloadText(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function autoOpenMarker(sessionId) {
  return `${NOTES_AUTO_OPEN_PREFIX}${state.date}:${Number(sessionId || 0)}`;
}

function markAutoOpened(sessionId) {
  try {
    sessionStorage.setItem(autoOpenMarker(sessionId), '1');
  } catch {}
}

function hasAutoOpened(sessionId) {
  try {
    return sessionStorage.getItem(autoOpenMarker(sessionId)) === '1';
  } catch {
    return false;
  }
}

function escapeHtml(value = '') {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setMinimumChip(ok) {
  if (!els.minimumChip) return;
  els.minimumChip.classList.remove('pending', 'done');
  if (ok) {
    els.minimumChip.classList.add('done');
    els.minimumChip.textContent = 'Minimum lengkap';
  } else {
    els.minimumChip.classList.add('pending');
    els.minimumChip.textContent = 'Belum lengkap';
  }
}

function applyAi(note = null) {
  els.aiSummary.textContent = note?.summary_text
    ? `Ringkasan: ${note.summary_text}`
    : 'Z AI akan merangkum setelah catatan sesi disimpan.';
  els.aiNext.textContent = note?.next_action_text
    ? `Aksi berikutnya: ${note.next_action_text}`
    : 'Z AI akan memberi langkah lanjutan setelah catatan disimpan.';
  els.aiRisk.textContent = note?.risk_hint
    ? `Catatan risiko: ${note.risk_hint}`
    : 'Z AI akan menampilkan catatan risiko jika terdeteksi.';
  if (els.chatCta) {
    const prompt = note?.next_action_text
      ? `bantu eksekusi aksi catatan kuliah ini: ${note.next_action_text}`
      : 'bantu saya review catatan kuliah hari ini';
    els.chatCta.href = `/chat?ai=${encodeURIComponent(prompt)}`;
  }
}

function fillForm(note = null, session = null) {
  els.noteId.value = note?.id || '';
  els.scheduleId.value = String(session?.schedule_id || note?.schedule_id || '');
  els.classDate.value = state.date;
  els.keyPoints.value = note?.key_points || '';
  els.actionItems.value = note?.action_items || '';
  els.questions.value = note?.questions || '';
  els.freeText.value = note?.free_text || '';
  els.moodFocus.value = note?.mood_focus || '';
  els.confidence.value = note?.confidence || '';
  setMinimumChip(Boolean(note?.is_minimum_completed) || minimumDoneFromForm());
  applyAi(note);
}

function renderSessions() {
  if (!els.sessionList) return;
  const rows = Array.isArray(state.sessions) ? state.sessions : [];
  if (!rows.length) {
    els.sessionList.innerHTML = '<div class="notes-empty">Hari ini tidak ada jadwal kuliah. Kamu bisa pakai waktu ini untuk review mandiri bareng Z AI.</div>';
    return;
  }

  els.sessionList.innerHTML = rows.map((s) => {
    const active = state.activeSession && Number(state.activeSession.schedule_id) === Number(s.schedule_id);
    const statusClass = s.is_minimum_completed ? 'complete' : 'incomplete';
    const chip = s.is_minimum_completed
      ? '<span class="notes-chip done">Sudah Tercatat</span>'
      : '<span class="notes-chip pending">Wajib Catat</span>';
    return `
      <article class="notes-session ${statusClass} ${active ? 'active' : ''}" data-session-id="${Number(s.schedule_id)}">
        <div class="notes-session-row">
          <p class="notes-session-title">${escapeHtml(s.subject || 'Kelas')}</p>
          ${chip}
        </div>
        <p class="notes-session-meta">
          <i class="fa-regular fa-clock"></i> ${escapeHtml(String(s.time_start || '').slice(0, 5))} - ${escapeHtml(String(s.time_end || '').slice(0, 5))}
          &nbsp;|&nbsp; <i class="fa-solid fa-location-dot"></i> ${escapeHtml(s.room || 'TBA')}
          ${s.lecturer ? `&nbsp;|&nbsp; <i class="fa-solid fa-user-tie"></i> ${escapeHtml(s.lecturer)}` : ''}
        </p>
      </article>
    `;
  }).join('');
}

function getPendingStartedSessions() {
  return state.sessions.filter((s) => !s.is_minimum_completed && isSessionStarted(s, state.date));
}

async function focusSession(session, opts = {}) {
  if (!session) return;
  const silent = Boolean(opts.silent);
  state.activeSession = session;
  await loadActiveNote(session.schedule_id);
  renderSessions();
  renderGate();
  if (els.keyPoints) els.keyPoints.focus();
  if (!silent) {
    showToast(`Sesi ${session.subject || 'kelas'} aktif. Lanjut catat sekarang.`, 'info');
  }
}

async function maybeAutoOpenStartedSession(opts = {}) {
  const force = Boolean(opts.force);
  const pending = getPendingStartedSessions();
  if (!pending.length) return;
  const top = pending[0];
  const topId = Number(top.schedule_id || 0);
  const activeId = Number(state.activeSession?.schedule_id || 0);
  if (!force && (activeId === topId || hasAutoOpened(topId))) return;
  markAutoOpened(topId);
  await focusSession(top, { silent: false });
}

function renderExportMarkdown(notes = [], from = '', to = '') {
  const lines = [
    '# Ringkasan Catatan Kuliah Mingguan',
    '',
    `Periode: ${from} s/d ${to}`,
    '',
  ];
  if (!notes.length) {
    lines.push('Belum ada catatan untuk periode ini.');
    return lines.join('\n');
  }
  notes.forEach((n) => {
    const date = String(n.class_date || '').slice(0, 10);
    const time = `${String(n.time_start || '').slice(0, 5)}-${String(n.time_end || '').slice(0, 5)}`;
    lines.push(`## ${n.subject || 'Kelas'} - ${date} (${time})`);
    lines.push(`- Ruangan: ${n.room || 'TBA'}`);
    lines.push(`- Dosen: ${n.lecturer || 'TBA'}`);
    if (n.summary_text) lines.push(`- Ringkasan Z AI: ${String(n.summary_text).trim()}`);
    if (n.next_action_text) lines.push(`- Aksi Berikutnya: ${String(n.next_action_text).trim()}`);
    if (n.risk_hint) lines.push(`- Catatan Risiko: ${String(n.risk_hint).trim()}`);
    if (n.key_points) lines.push(`- Poin Penting: ${String(n.key_points).trim()}`);
    if (n.action_items) lines.push(`- Langkah Lanjutan: ${String(n.action_items).trim()}`);
    if (n.questions) lines.push(`- Pertanyaan: ${String(n.questions).trim()}`);
    if (n.free_text) lines.push(`- Catatan Bebas: ${String(n.free_text).trim()}`);
    lines.push('');
  });
  return lines.join('\n');
}

function renderExportHtml(notes = [], from = '', to = '') {
  const rows = notes.map((n) => {
    const date = escapeHtml(String(n.class_date || '').slice(0, 10));
    const time = `${escapeHtml(String(n.time_start || '').slice(0, 5))}-${escapeHtml(String(n.time_end || '').slice(0, 5))}`;
    return `
      <article class="note">
        <h3>${escapeHtml(n.subject || 'Kelas')}</h3>
        <p class="meta">${date} | ${time} | ${escapeHtml(n.room || 'TBA')} | ${escapeHtml(n.lecturer || 'TBA')}</p>
        <p><strong>Ringkasan Z AI:</strong> ${escapeHtml(n.summary_text || '-')}</p>
        <p><strong>Aksi Berikutnya:</strong> ${escapeHtml(n.next_action_text || '-')}</p>
        <p><strong>Catatan Risiko:</strong> ${escapeHtml(n.risk_hint || '-')}</p>
      </article>
    `;
  }).join('');
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <title>Export Catatan Kuliah ${from} s/d ${to}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; margin: 20px; color: #1b1f2a; line-height: 1.4; }
    h1 { margin: 0 0 4px; font-size: 22px; }
    .sub { margin: 0 0 18px; color: #4c5a77; font-size: 13px; }
    .note { border: 1px solid #c9d3ea; border-radius: 10px; padding: 12px; margin-bottom: 10px; }
    .note h3 { margin: 0 0 4px; font-size: 16px; }
    .meta { margin: 0 0 8px; color: #5f6c88; font-size: 12px; }
    p { margin: 4px 0; font-size: 13px; }
    @page { margin: 12mm; }
  </style>
</head>
<body>
  <h1>Ringkasan Catatan Kuliah Mingguan</h1>
  <p class="sub">Periode ${escapeHtml(from)} s/d ${escapeHtml(to)}</p>
  ${rows || '<p>Tidak ada catatan pada periode ini.</p>'}
</body>
</html>`;
}

async function exportWeekly(format = 'md') {
  const { from, to } = weekRange(state.date);
  const rows = await get(`/class_notes?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const notes = Array.isArray(rows) ? rows : [];
  if (!notes.length) {
    showToast('Belum ada catatan untuk minggu ini.', 'info');
    return;
  }

  const fileLabel = fileSafe(`catatan-kuliah-${from}-sd-${to}`);
  if (format === 'pdf') {
    const html = renderExportHtml(notes, from, to);
    const win = window.open('', '_blank', 'noopener,noreferrer');
    if (!win) {
      showToast('Popup diblokir browser. Izinkan pop-up untuk export PDF.', 'error');
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    setTimeout(() => {
      win.focus();
      win.print();
    }, 220);
    showToast('Mode print PDF dibuka. Pilih "Save as PDF".', 'success');
    return;
  }

  const md = renderExportMarkdown(notes, from, to);
  downloadText(`${fileLabel}.md`, md, 'text/markdown;charset=utf-8');
  showToast('Export Markdown selesai.', 'success');
}

function renderGate() {
  if (!els.gate) return;
  if (!state.enforce) {
    els.gate.classList.remove('show');
    return;
  }
  const pending = getPendingStartedSessions();
  if (!pending.length) {
    els.gate.classList.remove('show');
    return;
  }
  const first = pending[0];
  els.gateSub.textContent = `Sesi "${first.subject || 'Kelas'}" (${String(first.time_start || '').slice(0, 5)}-${String(first.time_end || '').slice(0, 5)}) belum punya catatan minimum.`;
  els.gate.classList.add('show');
}

async function loadSessions(opts = {}) {
  const preserveActive = opts.preserveActive !== false;
  const payload = await get(`/class_notes/session?date=${encodeURIComponent(state.date)}`);
  state.sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
  renderSessions();

  const q = qs();
  const activeId = preserveActive ? Number(state.activeSession?.schedule_id || 0) : 0;
  const targetScheduleId = activeId || Number(q.get('schedule_id') || 0);
  const preferred = targetScheduleId > 0
    ? state.sessions.find((x) => Number(x.schedule_id) === targetScheduleId)
    : null;
  const fallback = state.sessions.find((x) => !x.is_minimum_completed) || state.sessions[0] || null;
  state.activeSession = preferred || fallback;
  if (state.activeSession) {
    await loadActiveNote(state.activeSession.schedule_id);
  } else {
    fillForm(null, null);
  }
  renderSessions();
  renderGate();
}

async function loadActiveNote(scheduleId) {
  const rows = await get(`/class_notes?date=${encodeURIComponent(state.date)}&schedule_id=${Number(scheduleId)}`);
  const note = Array.isArray(rows) && rows.length ? rows[0] : null;
  state.activeNote = note;
  fillForm(note, state.activeSession);
}

async function loadHistory() {
  const to = state.date;
  const base = new Date(`${to}T00:00:00`);
  base.setDate(base.getDate() - 7);
  const from = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
  const rows = await get(`/class_notes?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  if (!Array.isArray(rows) || !rows.length) {
    els.history.innerHTML = '<div class="notes-empty">Belum ada riwayat catatan 7 hari terakhir.</div>';
    return;
  }
  els.history.innerHTML = rows.slice(0, 12).map((n) => `
    <article class="notes-history-item">
      <h4>${escapeHtml(n.subject || 'Kelas')} | ${escapeHtml(String(n.class_date || '').slice(0, 10))}</h4>
      <p>${escapeHtml(n.summary_text || n.next_action_text || 'Catatan tersimpan.')}</p>
    </article>
  `).join('');
}

async function saveNote(ev) {
  ev.preventDefault();
  const scheduleId = Number(els.scheduleId.value || 0);
  if (!scheduleId) {
    showToast('Pilih sesi kelas dulu.', 'error');
    return;
  }
  const body = {
    id: Number(els.noteId.value || 0) || undefined,
    schedule_id: scheduleId,
    class_date: state.date,
    key_points: els.keyPoints.value,
    action_items: els.actionItems.value,
    questions: els.questions.value,
    free_text: els.freeText.value,
    mood_focus: els.moodFocus.value || null,
    confidence: els.confidence.value || null,
  };
  const saved = await post('/class_notes', body);
  state.activeNote = saved;
  fillForm(saved, state.activeSession);
  showToast('Catatan sesi berhasil disimpan.', 'success');
  await loadSessions({ preserveActive: true });
  await loadHistory();
}

function bindSessionClick() {
  els.sessionList.addEventListener('click', async (ev) => {
    const card = ev.target.closest('.notes-session[data-session-id]');
    if (!card) return;
    const id = Number(card.dataset.sessionId || 0);
    const session = state.sessions.find((s) => Number(s.schedule_id) === id);
    if (!session) return;
    state.activeSession = session;
    await loadActiveNote(id);
    renderSessions();
    renderGate();
  });
}

function bindLiveMinimumCheck() {
  ['input', 'change'].forEach((evtName) => {
    els.form.addEventListener(evtName, () => {
      setMinimumChip(minimumDoneFromForm());
    });
  });
}

function bindEvents() {
  els.form.addEventListener('submit', saveNote);
  els.dateInput.addEventListener('change', async () => {
    state.date = els.dateInput.value || localDateText();
    await loadSessions();
    await loadHistory();
  });
  bindSessionClick();
  bindLiveMinimumCheck();
  if (els.exportMd) {
    els.exportMd.addEventListener('click', () => {
      exportWeekly('md').catch(() => {
        showToast('Gagal export markdown.', 'error');
      });
    });
  }
  if (els.exportPdf) {
    els.exportPdf.addEventListener('click', () => {
      exportWeekly('pdf').catch(() => {
        showToast('Gagal membuka export PDF.', 'error');
      });
    });
  }
  if (els.gateFocus) {
    els.gateFocus.addEventListener('click', () => {
      const pending = getPendingStartedSessions();
      if (pending.length) {
        state.activeSession = pending[0];
        loadActiveNote(state.activeSession.schedule_id).then(() => {
          renderSessions();
          els.keyPoints.focus();
        }).catch(() => {});
      } else {
        els.gate.classList.remove('show');
      }
    });
  }
}

function startRealtimeWatcher() {
  if (state.realtimeTimer) {
    clearInterval(state.realtimeTimer);
    state.realtimeTimer = null;
  }
  state.realtimeTimer = setInterval(async () => {
    try {
      await loadSessions({ preserveActive: true });
      await maybeAutoOpenStartedSession();
    } catch {}
  }, NOTES_REALTIME_POLL_MS);
}

async function init() {
  initProtected();
  normalizeLinks();
  const q = qs();
  state.enforce = q.get('enforce') === '1';
  state.date = String(q.get('date') || localDateText()).slice(0, 10);
  els.dateInput.value = state.date;
  bindEvents();
  await loadSessions({ preserveActive: true });
  await maybeAutoOpenStartedSession({ force: true });
  await loadHistory();
  startRealtimeWatcher();
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    await loadSessions({ preserveActive: true });
    await maybeAutoOpenStartedSession();
  });
  window.addEventListener('beforeunload', () => {
    if (state.realtimeTimer) clearInterval(state.realtimeTimer);
  });
  if (els.pageSub) {
    els.pageSub.textContent = state.enforce
      ? 'Mode wajib aktif: lengkapi catatan minimum untuk sesi kelas yang sudah berjalan agar Z AI bisa bantu eksekusi.'
      : 'Catat per sesi kuliah hari ini, lalu biarkan Z AI bantu merangkum.';
  }
}

init().catch((err) => {
  console.error(err);
  showToast('Gagal memuat halaman pencatatan.', 'error');
});

