import { get, post } from './api.js';
import { initProtected, normalizeLinks, showToast } from './main.js';

const state = {
  items: [],
  grouped: [],
  activeNoteId: null,
  activeNote: null,
  revisions: [],
  status: 'archived',
  search: '',
  ownerMode: 'me',
  withPartner: false,
  me: (localStorage.getItem('user') || 'Zaldy').trim() || 'Zaldy',
};

const els = {
  search: document.getElementById('vault-search'),
  searchBtn: document.getElementById('vault-search-btn'),
  statusChips: document.getElementById('vault-status-chips'),
  ownerMe: document.getElementById('vault-owner-me'),
  ownerPartner: document.getElementById('vault-owner-partner'),
  togglePartner: document.getElementById('vault-toggle-partner'),
  list: document.getElementById('vault-list'),
  detailTitle: document.getElementById('vault-detail-title'),
  detailMeta: document.getElementById('vault-detail-meta'),
  detailSummary: document.getElementById('vault-detail-summary'),
  detailNext: document.getElementById('vault-detail-next'),
  detailRisk: document.getElementById('vault-detail-risk'),
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
  return {
    solid: `hsl(${hue}, 72%, 62%)`,
  };
}

function activeOwner() {
  if (state.ownerMode === 'partner') return partnerFor(state.me);
  return state.me;
}

function buildQuery() {
  const params = new URLSearchParams();
  params.set('archive_status', state.status);
  if (state.search.trim()) {
    params.set('q', state.search.trim());
    params.set('natural', '1');
  }
  const owner = activeOwner();
  if (owner) params.set('owner', owner);
  params.set('with_partner', state.withPartner ? '1' : '0');
  params.set('limit', '60');
  return params.toString();
}

function updateChipState() {
  els.statusChips.querySelectorAll('.vault-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.status === state.status);
  });
  els.ownerMe.classList.toggle('active', state.ownerMode === 'me');
  els.ownerPartner.classList.toggle('active', state.ownerMode === 'partner');
  els.togglePartner.textContent = `Lihat pasangan: ${state.withPartner ? 'On' : 'Off'}`;
}

function renderList() {
  const groups = Array.isArray(state.grouped) ? state.grouped : [];
  if (!groups.length) {
    els.list.innerHTML = '<div class="vault-empty">Belum ada catatan untuk filter ini.</div>';
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
                  ${escapeHtml(String(item.class_date || '').slice(0, 10))} · ${escapeHtml(String(item.time_start || '').slice(0, 5))}-${escapeHtml(String(item.time_end || '').slice(0, 5))}
                  ${item.room ? `· ${escapeHtml(item.room)}` : ''}
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
    els.actions.innerHTML = '';
    els.revisions.innerHTML = '<div class="vault-empty">Belum ada data revisi.</div>';
    return;
  }

  els.detailTitle.textContent = note.subject || 'Catatan';
  els.detailMeta.textContent = `${String(note.class_date || '').slice(0, 10)} · ${String(note.time_start || '').slice(0, 5)}-${String(note.time_end || '').slice(0, 5)} · ${note.user_id || ''}`;
  els.detailSummary.textContent = note.summary_text ? `Ringkasan: ${note.summary_text}` : 'Ringkasan: -';
  els.detailNext.textContent = note.next_action_text ? `Aksi berikutnya: ${note.next_action_text}` : 'Aksi berikutnya: -';
  els.detailRisk.textContent = note.risk_hint ? `Risiko: ${note.risk_hint}` : 'Risiko: -';

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
      <div><strong>v${Number(rev.version_no || 0)}</strong> · ${escapeHtml(String(rev.change_reason || 'save'))}</div>
      <div class="muted small">${escapeHtml(String(rev.created_at || '').replace('T', ' ').slice(0, 16))}</div>
      ${isOwner ? `<button class="btn small secondary" data-revision-id="${Number(rev.id)}">Restore</button>` : ''}
    </article>
  `).join('');
}

async function loadInsights() {
  try {
    const qs = new URLSearchParams();
    qs.set('scope', 'week');
    qs.set('with_partner', state.withPartner ? '1' : '0');
    const owner = activeOwner();
    if (owner) qs.set('owner', owner);
    const data = await get(`/class_notes/vault/insight?${qs.toString()}`);
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
  const payload = await get(`/class_notes/vault?${buildQuery()}`);
  state.items = Array.isArray(payload?.items) ? payload.items : [];
  state.grouped = Array.isArray(payload?.grouped) ? payload.grouped : [];
  if (!state.activeNoteId || !state.items.find((x) => Number(x.id) === Number(state.activeNoteId))) {
    state.activeNoteId = state.items[0]?.id || null;
  }
  state.activeNote = state.items.find((x) => Number(x.id) === Number(state.activeNoteId)) || null;
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
