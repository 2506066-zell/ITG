import { get, post } from './api.js';
import { initProtected, normalizeLinks, showToast } from './main.js';

const state = {
  items: [],
  activeNoteId: null,
  activeNote: null,
  revisions: [],
  status: 'archived',
  search: '',
  sortMode: 'smart',
  ownerMode: 'me',
  withPartner: false,
  semesterMode: 'current',
  semesterKey: '',
  semesters: [],
  startMonth: 8,
  me: (localStorage.getItem('user') || 'Zaldy').trim() || 'Zaldy',
};

const els = {
  search: document.getElementById('vault-search'),
  searchBtn: document.getElementById('vault-search-btn'),
  statusChips: document.getElementById('vault-status-chips'),
  ownerMe: document.getElementById('vault-owner-me'),
  ownerPartner: document.getElementById('vault-owner-partner'),
  togglePartner: document.getElementById('vault-toggle-partner'),
  semesterChips: document.getElementById('vault-semester-chips'),
  sortChips: document.getElementById('vault-sort-chips'),
  scopeInfo: document.getElementById('vault-scope-info'),
  list: document.getElementById('vault-list'),
  detailTitle: document.getElementById('vault-detail-title'),
  detailMeta: document.getElementById('vault-detail-meta'),
  detailSummary: document.getElementById('vault-detail-summary'),
  detailNext: document.getElementById('vault-detail-next'),
  detailRisk: document.getElementById('vault-detail-risk'),
  detailPreview: document.getElementById('vault-detail-preview'),
  actions: document.getElementById('vault-actions'),
  revisions: document.getElementById('vault-revisions-list'),
  insightSummary: document.getElementById('vault-insight-summary'),
  insightNext: document.getElementById('vault-insight-next'),
  insightRisk: document.getElementById('vault-insight-risk'),
};

function partnerFor(user = '') {
  if (/^zaldy$/i.test(user)) return 'Nesya';
  if (/^nesya$/i.test(user)) return 'Zaldy';
  return '';
}

function escapeHtml(value = '') {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getSubjectColor(subject = '') {
  const key = String(subject || 'kelas').trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return { solid: `hsl(${hue}, 72%, 62%)` };
}

function normalizeDateText(raw = '') {
  return String(raw || '').slice(0, 10);
}

function buildSemesterMeta(classDate = '', startMonth = 8) {
  const dt = normalizeDateText(classDate);
  if (!dt) return null;
  const [y, m] = dt.split('-').map((x) => Number(x || 0));
  if (!y || !m) return null;
  const start = Number(startMonth || 8);
  const academicStartYear = m >= start ? y : (y - 1);
  const academicEndYear = academicStartYear + 1;
  const offset = (m - start + 12) % 12;
  const type = offset < 6 ? 'ganjil' : 'genap';
  return {
    semester_key: `${academicStartYear}-${academicEndYear}-${type}`,
    semester_label: `${academicStartYear}/${academicEndYear} ${type === 'ganjil' ? 'Ganjil' : 'Genap'}`,
  };
}

function weekBucket(classDate = '') {
  const dt = normalizeDateText(classDate);
  if (!dt) return { key: 'unknown', label: 'Tanggal tidak valid' };
  const d = new Date(`${dt}T00:00:00`);
  if (Number.isNaN(d.getTime())) return { key: 'unknown', label: 'Tanggal tidak valid' };
  const day = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() - (day - 1));
  const start = normalizeDateText(d.toISOString());
  const endDate = new Date(`${start}T00:00:00`);
  endDate.setDate(endDate.getDate() + 6);
  const end = normalizeDateText(endDate.toISOString());
  return { key: `${start}_${end}`, label: `${start} - ${end}` };
}

function buildNoteMarkdown(note = {}) {
  const lines = [];
  const date = normalizeDateText(note.class_date);
  const start = String(note.time_start || '').slice(0, 5);
  const end = String(note.time_end || '').slice(0, 5);
  const owner = String(note.user_id || '').trim();
  const confidence = String(note.confidence || '').trim();
  const mood = note.mood_focus === null || note.mood_focus === undefined || note.mood_focus === '' ? '' : String(note.mood_focus);

  lines.push(`# ${note.subject || 'Catatan Kuliah'}`);
  lines.push('');
  lines.push(`- Tanggal: ${date || '-'}`);
  if (note?.meeting_no) lines.push(`- Pertemuan: ${note.meeting_no}`);
  lines.push(`- Waktu: ${start && end ? `${start}-${end}` : '-'}`);
  lines.push(`- Ruangan: ${note.room || '-'}`);
  lines.push(`- Dosen: ${note.lecturer || '-'}`);
  if (owner) lines.push(`- Owner: ${owner}`);
  if (confidence) lines.push(`- Keyakinan: ${confidence}`);
  if (mood) lines.push(`- Mood Fokus: ${mood}`);
  lines.push('');

  if (note.key_points) {
    lines.push('## Poin Penting');
    lines.push(String(note.key_points).trim());
    lines.push('');
  }
  if (note.action_items) {
    lines.push('## Langkah Lanjutan');
    lines.push(String(note.action_items).trim());
    lines.push('');
  }
  if (note.questions) {
    lines.push('## Pertanyaan');
    lines.push(String(note.questions).trim());
    lines.push('');
  }
  if (note.free_text) {
    lines.push('## Catatan Bebas');
    lines.push(String(note.free_text).trim());
    lines.push('');
  }
  if (note.summary_text || note.next_action_text || note.risk_hint) {
    lines.push('## Insight Z AI');
    if (note.summary_text) lines.push(`- Ringkasan: ${String(note.summary_text).trim()}`);
    if (note.next_action_text) lines.push(`- Aksi: ${String(note.next_action_text).trim()}`);
    if (note.risk_hint) lines.push(`- Risiko: ${String(note.risk_hint).trim()}`);
  }
  return lines.join('\n').trim();
}

function markdownToReviewHtml(markdown = '') {
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  const html = [];
  let listOpen = false;
  let paragraph = [];

  const closeParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${escapeHtml(paragraph.join(' '))}</p>`);
    paragraph = [];
  };

  const closeList = () => {
    if (!listOpen) return;
    html.push('</ul>');
    listOpen = false;
  };

  lines.forEach((rawLine) => {
    const line = String(rawLine || '').trim();
    if (!line) {
      closeParagraph();
      closeList();
      return;
    }
    if (line.startsWith('# ')) {
      closeParagraph();
      closeList();
      html.push(`<h1>${escapeHtml(line.slice(2).trim())}</h1>`);
      return;
    }
    if (line.startsWith('## ')) {
      closeParagraph();
      closeList();
      html.push(`<h2>${escapeHtml(line.slice(3).trim())}</h2>`);
      return;
    }
    if (line.startsWith('- ')) {
      closeParagraph();
      if (!listOpen) {
        html.push('<ul>');
        listOpen = true;
      }
      html.push(`<li>${escapeHtml(line.slice(2).trim())}</li>`);
      return;
    }
    closeList();
    paragraph.push(line);
  });

  closeParagraph();
  closeList();
  return html.join('');
}

function renderNotePreview(note = null) {
  if (!els.detailPreview) return;
  if (!note) {
    els.detailPreview.style.display = 'none';
    els.detailPreview.innerHTML = '';
    return;
  }
  const markdown = buildNoteMarkdown(note);
  const review = markdownToReviewHtml(markdown);
  els.detailPreview.style.display = 'block';
  els.detailPreview.innerHTML = `
    <p class="vault-markdown-head"><i class="fa-solid fa-file-lines"></i> Detail Catatan Markdown</p>
    <div class="vault-markdown-review">${review}</div>
  `;
}

function activeOwner() {
  if (state.ownerMode === 'partner') return partnerFor(state.me);
  return state.me;
}

function activeSemesterRange() {
  if (state.semesterMode === 'all') return null;
  const key = String(state.semesterKey || '');
  if (!key) return null;
  const found = (state.semesters || []).find((s) => String(s.semester_key || '') === key);
  if (!found?.from || !found?.to) return null;
  return { from: String(found.from).slice(0, 10), to: String(found.to).slice(0, 10), label: found.semester_label || key };
}

function buildVaultQueryParams({ forInsight = false } = {}) {
  const params = new URLSearchParams();
  if (!forInsight) params.set('archive_status', state.status);
  if (forInsight) params.set('scope', 'week');
  if (state.search.trim()) {
    params.set('q', state.search.trim());
    params.set('natural', '1');
  }
  const owner = activeOwner();
  if (owner) params.set('owner', owner);
  params.set('with_partner', state.withPartner ? '1' : '0');
  if (!forInsight) params.set('limit', '120');
  const sem = activeSemesterRange();
  if (sem) {
    params.set('week_start', sem.from);
    params.set('week_end', sem.to);
  }
  return params;
}

function renderSemesterChips() {
  if (!els.semesterChips) return;
  const chips = [];
  chips.push(`
    <button type="button" class="vault-chip ${state.semesterMode === 'all' ? 'active' : ''}" data-semester-key="all">
      Semua Semester
    </button>
  `);
  (state.semesters || []).forEach((sem) => {
    const key = String(sem.semester_key || '');
    if (!key) return;
    const active = state.semesterMode !== 'all' && key === String(state.semesterKey || '');
    chips.push(`
      <button type="button" class="vault-chip ${active ? 'active' : ''}" data-semester-key="${escapeHtml(key)}">
        ${escapeHtml(String(sem.semester_label || key))} (${Number(sem.total || 0)})
      </button>
    `);
  });
  els.semesterChips.innerHTML = chips.join('');
}

function renderScopeInfo() {
  if (!els.scopeInfo) return;
  const owner = activeOwner() || '-';
  const status = state.status || 'archived';
  const sort = state.sortMode || 'smart';
  const sem = activeSemesterRange();
  const semLabel = state.semesterMode === 'all' ? 'Semua semester' : (sem?.label || 'Semester aktif');
  els.scopeInfo.textContent = `Owner ${owner} | Status ${status} | ${semLabel} | Sort ${sort} | ${Number(state.items.length || 0)} catatan`;
}

function updateChipState() {
  els.statusChips.querySelectorAll('.vault-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.status === state.status);
  });
  els.ownerMe.classList.toggle('active', state.ownerMode === 'me');
  els.ownerPartner.classList.toggle('active', state.ownerMode === 'partner');
  if (els.sortChips) {
    els.sortChips.querySelectorAll('.vault-chip').forEach((chip) => {
      chip.classList.toggle('active', chip.dataset.sort === state.sortMode);
    });
  }
  els.togglePartner.textContent = `Lihat pasangan: ${state.withPartner ? 'On' : 'Off'}`;
  renderSemesterChips();
  renderScopeInfo();
}

function toSortableTime(note = {}) {
  const date = normalizeDateText(note.class_date);
  const time = String(note.time_start || '00:00').slice(0, 5);
  const ms = new Date(`${date}T${time}:00`).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function dbBool(value) {
  if (value === true || value === false) return value;
  const t = String(value || '').trim().toLowerCase();
  return t === 'true' || t === 't' || t === '1' || t === 'yes';
}

function smartScore(note = {}) {
  const now = Date.now();
  const updatedMs = new Date(String(note.updated_at || note.created_at || '')).getTime() || 0;
  const ageDays = updatedMs ? Math.max(0, (now - updatedMs) / 86400000) : 30;
  const recency = Math.max(0, 40 - Math.floor(ageDays));
  const quality = Number(note.quality_score || 0);
  let score = 0;
  if (dbBool(note.pinned)) score += 120;
  if (String(note.archive_status || '') === 'active') score += 45;
  if (!dbBool(note.is_minimum_completed)) score += 35;
  if (String(note.risk_hint || '').trim()) score += 22;
  if (String(note.questions || '').trim()) score += 14;
  score += Math.min(quality, 100) * 0.2;
  score += recency;
  return score;
}

function sortItems(items = []) {
  const rows = [...(Array.isArray(items) ? items : [])];
  const byLatest = (a, b) => toSortableTime(b) - toSortableTime(a);
  if (state.sortMode === 'latest') return rows.sort(byLatest);
  if (state.sortMode === 'oldest') return rows.sort((a, b) => toSortableTime(a) - toSortableTime(b));
  if (state.sortMode === 'subject') {
    return rows.sort((a, b) => {
      const subjectOrder = String(a.subject || '').localeCompare(String(b.subject || ''));
      if (subjectOrder !== 0) return subjectOrder;
      return byLatest(a, b);
    });
  }
  if (state.sortMode === 'quality') {
    return rows.sort((a, b) => {
      const qualityOrder = Number(b.quality_score || 0) - Number(a.quality_score || 0);
      if (qualityOrder !== 0) return qualityOrder;
      return byLatest(a, b);
    });
  }
  return rows.sort((a, b) => {
    const smartOrder = smartScore(b) - smartScore(a);
    if (smartOrder !== 0) return smartOrder;
    return byLatest(a, b);
  });
}

function buildSemesterGroups(items = []) {
  const map = new Map();
  items.forEach((item) => {
    const meta = buildSemesterMeta(item.class_date, state.startMonth);
    const key = meta?.semester_key || 'unknown';
    const label = meta?.semester_label || 'Semester tidak diketahui';
    if (!map.has(key)) map.set(key, { key, label, items: [] });
    map.get(key).items.push(item);
  });
  return [...map.values()].sort((a, b) => String(b.key).localeCompare(String(a.key)));
}

function buildSubjectWeekGroups(items = []) {
  const subjectMap = new Map();
  items.forEach((item) => {
    const subject = String(item.subject || 'Tanpa Mapel').trim() || 'Tanpa Mapel';
    const week = weekBucket(item.class_date);
    if (!subjectMap.has(subject)) {
      subjectMap.set(subject, { subject, total: 0, weeks: new Map() });
    }
    const entry = subjectMap.get(subject);
    entry.total += 1;
    if (!entry.weeks.has(week.key)) {
      entry.weeks.set(week.key, { week_key: week.key, week_label: week.label, items: [] });
    }
    entry.weeks.get(week.key).items.push(item);
  });
  return [...subjectMap.values()]
    .map((entry) => ({
      subject: entry.subject,
      total: entry.total,
      weeks: [...entry.weeks.values()].sort((a, b) => String(b.week_key).localeCompare(String(a.week_key))),
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

function renderList() {
  const sorted = sortItems(state.items);
  const allSemester = state.semesterMode === 'all';
  const groups = allSemester ? buildSemesterGroups(sorted) : buildSubjectWeekGroups(sorted);
  if (!groups.length) {
    els.list.innerHTML = '<div class="vault-empty">Belum ada catatan untuk filter ini.</div>';
    return;
  }

  if (allSemester) {
    els.list.innerHTML = groups.map((group) => `
      <section class="vault-group">
        <h3>${escapeHtml(group.label)} <span class="muted small">(${Number(group.items.length || 0)} item)</span></h3>
        <div class="vault-week">
          ${(group.items || []).map((item) => {
            const color = getSubjectColor(item.subject);
            return `
              <article class="vault-item ${Number(item.id) === Number(state.activeNoteId) ? 'active' : ''}" data-note-id="${Number(item.id)}" style="--subject-accent:${color.solid}">
                <p class="vault-item-title">${escapeHtml(item.subject || 'Catatan')}</p>
                <p class="vault-item-meta">
                  ${escapeHtml(String(item.class_date || '').slice(0, 10))} - ${escapeHtml(String(item.time_start || '').slice(0, 5))}-${escapeHtml(String(item.time_end || '').slice(0, 5))}
                  ${item.room ? ` - ${escapeHtml(item.room)}` : ''}
                </p>
                <div class="vault-badge-row">
                  <span class="vault-badge ${escapeHtml(item.archive_status || 'active')}">${escapeHtml(item.archive_status || 'active')}</span>
                  <span class="vault-badge">${escapeHtml(item.user_id || '')}</span>
                  <span class="vault-badge">Q ${Number(item.quality_score || 0)}</span>
                  ${item.pinned ? '<span class="vault-badge">Pinned</span>' : ''}
                </div>
              </article>
            `;
          }).join('')}
        </div>
      </section>
    `).join('');
    return;
  }

  els.list.innerHTML = groups.map((group) => `
    <section class="vault-group">
      <h3>${escapeHtml(group.subject)} <span class="muted small">(${Number(group.total || 0)} item)</span></h3>
      ${(group.weeks || []).map((week) => `
        <div class="vault-week">
          <div class="vault-week-head">${escapeHtml(week.week_label || week.week_key || '')}</div>
          ${(week.items || []).map((item) => {
            const color = getSubjectColor(item.subject);
            return `
              <article class="vault-item ${Number(item.id) === Number(state.activeNoteId) ? 'active' : ''}" data-note-id="${Number(item.id)}" style="--subject-accent:${color.solid}">
                <p class="vault-item-title">${escapeHtml(item.subject || 'Catatan')}</p>
                <p class="vault-item-meta">
                  ${escapeHtml(String(item.class_date || '').slice(0, 10))} - ${escapeHtml(String(item.time_start || '').slice(0, 5))}-${escapeHtml(String(item.time_end || '').slice(0, 5))}
                  ${item.room ? ` - ${escapeHtml(item.room)}` : ''}
                </p>
                <div class="vault-badge-row">
                  <span class="vault-badge ${escapeHtml(item.archive_status || 'active')}">${escapeHtml(item.archive_status || 'active')}</span>
                  <span class="vault-badge">${escapeHtml(item.user_id || '')}</span>
                  <span class="vault-badge">Q ${Number(item.quality_score || 0)}</span>
                  ${item.pinned ? '<span class="vault-badge">Pinned</span>' : ''}
                </div>
              </article>
            `;
          }).join('')}
        </div>
      `).join('')}
    </section>
  `).join('');
}

function renderDetail() {
  const note = state.activeNote;
  if (!note) {
    els.detailTitle.textContent = 'Pilih Catatan';
    els.detailMeta.textContent = 'Klik salah satu card untuk lihat detail.';
    els.detailSummary.textContent = '';
    els.detailNext.textContent = '';
    els.detailRisk.textContent = '';
    renderNotePreview(null);
    els.actions.innerHTML = '';
    els.revisions.innerHTML = '<div class="vault-empty">Belum ada data revisi.</div>';
    return;
  }

  els.detailTitle.textContent = note.subject || 'Catatan';
  els.detailMeta.textContent = `${String(note.class_date || '').slice(0, 10)} - ${String(note.time_start || '').slice(0, 5)}-${String(note.time_end || '').slice(0, 5)} - ${note.user_id || ''}`;
  els.detailSummary.textContent = note.summary_text ? `Ringkasan: ${note.summary_text}` : 'Ringkasan: -';
  els.detailNext.textContent = note.next_action_text ? `Aksi berikutnya: ${note.next_action_text}` : 'Aksi berikutnya: -';
  els.detailRisk.textContent = note.risk_hint ? `Risiko: ${note.risk_hint}` : 'Risiko: -';
  renderNotePreview(note);

  const isOwner = Boolean(note.is_owner);
  const actions = [];
  if (isOwner) {
    if (note.archive_status === 'active') actions.push({ label: 'Arsipkan', action: 'archive' });
    if (note.archive_status === 'archived') actions.push({ label: 'Aktifkan', action: 'unarchive' });
    if (note.archive_status !== 'trashed') actions.push({ label: 'Trash', action: 'trash' });
    if (note.archive_status === 'trashed') actions.push({ label: 'Restore', action: 'restore' });
    if (note.archive_status === 'trashed') actions.push({ label: 'Purge', action: 'purge' });
    if (note.pinned) actions.push({ label: 'Unpin', action: 'unpin' });
    else actions.push({ label: 'Pin', action: 'pin' });
  }
  els.actions.innerHTML = actions.length
    ? actions.map((a) => `<button class="btn small secondary" data-vault-action="${a.action}">${a.label}</button>`).join('')
    : '<span class="muted small">Mode pasangan: read-only.</span>';
}

function renderRevisions() {
  if (!Array.isArray(state.revisions) || !state.revisions.length) {
    els.revisions.innerHTML = '<div class="vault-empty">Belum ada revisi untuk catatan ini.</div>';
    return;
  }
  const isOwner = Boolean(state.activeNote?.is_owner);
  els.revisions.innerHTML = state.revisions.map((rev) => `
    <article class="vault-rev">
      <div><strong>v${Number(rev.version_no || 0)}</strong> - ${escapeHtml(String(rev.change_reason || 'save'))}</div>
      <div class="muted small">${escapeHtml(String(rev.created_at || '').replace('T', ' ').slice(0, 16))}</div>
      ${isOwner ? `<button class="btn small secondary" data-revision-id="${Number(rev.id)}">Restore</button>` : ''}
    </article>
  `).join('');
}

async function loadSemesters() {
  const qs = new URLSearchParams();
  const owner = activeOwner();
  if (owner) qs.set('owner', owner);
  qs.set('with_partner', state.withPartner ? '1' : '0');
  try {
    const payload = await get(`/class_notes/semester?${qs.toString()}`);
    state.semesters = Array.isArray(payload?.items) ? payload.items : [];
    state.startMonth = Number(payload?.academic_year_start_month || 8);
    const currentKey = String(payload?.current_semester_key || '');
    if (state.semesterMode !== 'all') {
      const hasCurrent = state.semesters.some((x) => String(x.semester_key || '') === currentKey);
      const hasSelected = state.semesters.some((x) => String(x.semester_key || '') === String(state.semesterKey || ''));
      if (hasSelected) {
        // keep selected key
      } else if (hasCurrent) {
        state.semesterKey = currentKey;
      } else {
        state.semesterKey = String(state.semesters[0]?.semester_key || '');
      }
      if (!state.semesterKey && state.semesters.length === 0) {
        state.semesterMode = 'all';
      }
    }
  } catch {
    state.semesters = [];
    state.startMonth = 8;
  }
}

async function loadInsights() {
  try {
    const data = await get(`/class_notes/vault/insight?${buildVaultQueryParams({ forInsight: true }).toString()}`);
    els.insightSummary.textContent = data?.summary_text || 'Belum ada insight.';
    els.insightNext.textContent = data?.next_action_text || 'Belum ada aksi berikutnya.';
    els.insightRisk.textContent = data?.risk_hint || 'Belum ada catatan risiko.';
  } catch {
    els.insightSummary.textContent = 'Gagal memuat insight.';
    els.insightNext.textContent = '';
    els.insightRisk.textContent = '';
  }
}

async function loadVault() {
  await loadSemesters();
  const payload = await get(`/class_notes/vault?${buildVaultQueryParams().toString()}`);
  state.items = Array.isArray(payload?.items) ? payload.items : [];
  if (!state.activeNoteId || !state.items.find((x) => Number(x.id) === Number(state.activeNoteId))) {
    state.activeNoteId = state.items[0]?.id || null;
  }
  state.activeNote = state.items.find((x) => Number(x.id) === Number(state.activeNoteId)) || null;
  updateChipState();
  renderList();
  renderDetail();
  await loadRevisions();
  await loadInsights();
}

async function loadRevisions() {
  if (!state.activeNoteId) {
    state.revisions = [];
    renderRevisions();
    return;
  }
  try {
    const payload = await get(`/class_notes/revisions?note_id=${Number(state.activeNoteId)}`);
    state.revisions = Array.isArray(payload?.items) ? payload.items : [];
  } catch {
    state.revisions = [];
  }
  renderRevisions();
}

async function runVaultAction(action) {
  if (!state.activeNoteId) return;
  await post('/class_notes/vault/action', { note_id: Number(state.activeNoteId), action });
  showToast(`Action ${action} berhasil.`, 'success');
  await loadVault();
}

async function runRevisionRestore(revisionId) {
  if (!state.activeNoteId) return;
  await post('/class_notes/revisions/restore', {
    note_id: Number(state.activeNoteId),
    revision_id: Number(revisionId),
  });
  showToast('Revisi berhasil direstore.', 'success');
  await loadVault();
}

function bindEvents() {
  els.searchBtn.addEventListener('click', async () => {
    state.search = String(els.search.value || '').trim();
    await loadVault();
  });

  els.search.addEventListener('keydown', async (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      state.search = String(els.search.value || '').trim();
      await loadVault();
    }
  });

  els.statusChips.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-status]');
    if (!btn) return;
    state.status = btn.dataset.status || 'archived';
    updateChipState();
    await loadVault();
  });

  els.ownerMe.addEventListener('click', async () => {
    state.ownerMode = 'me';
    updateChipState();
    await loadVault();
  });

  els.ownerPartner.addEventListener('click', async () => {
    const partner = partnerFor(state.me);
    if (!partner) {
      showToast('Partner tidak tersedia untuk akun ini.', 'error');
      return;
    }
    state.ownerMode = 'partner';
    state.withPartner = true;
    updateChipState();
    await loadVault();
  });

  els.togglePartner.addEventListener('click', async () => {
    state.withPartner = !state.withPartner;
    if (!state.withPartner && state.ownerMode === 'partner') {
      state.ownerMode = 'me';
    }
    updateChipState();
    await loadVault();
  });

  if (els.semesterChips) {
    els.semesterChips.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-semester-key]');
      if (!btn) return;
      const key = String(btn.dataset.semesterKey || '').trim();
      if (!key) return;
      if (key === 'all') {
        if (state.semesterMode === 'all') return;
        state.semesterMode = 'all';
      } else {
        if (state.semesterMode !== 'all' && key === String(state.semesterKey || '')) return;
        state.semesterMode = 'current';
        state.semesterKey = key;
      }
      updateChipState();
      await loadVault();
    });
  }

  if (els.sortChips) {
    els.sortChips.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-sort]');
      if (!btn) return;
      const mode = String(btn.dataset.sort || '').trim();
      if (!mode || mode === state.sortMode) return;
      state.sortMode = mode;
      updateChipState();
      renderList();
      renderScopeInfo();
    });
  }

  els.list.addEventListener('click', async (ev) => {
    const card = ev.target.closest('[data-note-id]');
    if (!card) return;
    state.activeNoteId = Number(card.dataset.noteId || 0) || null;
    state.activeNote = state.items.find((x) => Number(x.id) === Number(state.activeNoteId)) || null;
    renderList();
    renderDetail();
    await loadRevisions();
  });

  els.actions.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-vault-action]');
    if (!btn) return;
    const action = String(btn.dataset.vaultAction || '').trim();
    if (!action) return;
    try {
      await runVaultAction(action);
    } catch (err) {
      console.error(err);
      showToast('Action vault gagal.', 'error');
    }
  });

  els.revisions.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-revision-id]');
    if (!btn) return;
    try {
      await runRevisionRestore(btn.dataset.revisionId);
    } catch (err) {
      console.error(err);
      showToast('Restore revisi gagal.', 'error');
    }
  });
}

async function init() {
  initProtected();
  normalizeLinks();
  bindEvents();
  updateChipState();
  await loadVault();
}

init().catch((err) => {
  console.error(err);
  showToast('Gagal memuat Vault Arsip.', 'error');
});
