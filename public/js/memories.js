import { initProtected, showToast } from './main.js';
import { get, post, put, del } from './api.js';

let selectedImageBase64 = null;
let currentEditId = null;
let currentEditVersion = null;
let addOverlay, editOverlay;

// Image compression utility
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 800;
        const scaleSize = MAX_WIDTH / img.width;

        canvas.width = MAX_WIDTH;
        canvas.height = img.height * scaleSize;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        resolve(dataUrl);
      };
      img.onerror = reject;
    };
    reader.onerror = reject;
  });
}

async function load() {
  initProtected();
  const list = document.querySelector('#memories-list');
  list.innerHTML = '';

  // Skeletons
  for (let i = 0; i < 6; i++) {
    const sk = document.createElement('div');
    sk.className = 'card skeleton';
    sk.style.height = '250px';
    list.appendChild(sk);
  }

  const data = await get('/memories');
  list.innerHTML = '';

  if (!data.length) {
    list.innerHTML = `
      <div class="card center muted" style="grid-column: 1 / -1; padding: 40px;">
        <i class="fa-solid fa-photo-film" style="font-size: 40px; margin-bottom: 12px; opacity: 0.3;"></i>
        <p>Belum ada memory. Klik tombol + untuk menambahkan.</p>
      </div>
    `;
    return;
  }

  data.sort((a, b) => b.id - a.id);

  data.forEach(m => {
    const el = document.createElement('div');
    el.className = 'card memory-card';

    let mediaHtml = '';
    if (m.media_data && m.media_type === 'image') {
      mediaHtml = `<img src="${m.media_data}" class="memory-img" loading="lazy">`;
    }

    el.innerHTML = `
      ${mediaHtml}
      <div style="padding: 4px 0 12px 0;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px">
          <strong style="font-size:1.05rem; line-height:1.2">${m.title || 'Untitled'}</strong>
          <div class="actions" style="margin-left: 8px;">
            <button class="btn secondary small p-1" data-id="${m.id}" data-action="edit" 
              data-title="${m.title || ''}" data-note="${m.note || ''}" data-version="${m.version || 0}">
              <i class="fa-solid fa-pen" style="font-size:10px"></i>
            </button>
            <button class="btn danger small p-1" data-id="${m.id}" data-action="delete">
              <i class="fa-solid fa-trash" style="font-size:10px"></i>
            </button>
          </div>
        </div>
        ${m.note ? `<div class="muted small" style="white-space:pre-wrap; font-size:12px; line-height:1.4">${m.note}</div>` : ''}
        <div class="memory-date">${new Date(m.created_at).toLocaleString()}</div>
      </div>
    `;

    list.appendChild(el);
  });
}

async function handleCreate(e) {
  e.preventDefault();
  const f = new FormData(e.target);

  try {
    const body = {
      title: f.get('title'),
      media_type: selectedImageBase64 ? 'image' : 'text',
      media_data: selectedImageBase64 || '',
      note: f.get('note')
    };

    await post('/memories', body);
    e.target.reset();
    resetPhotoPreview();
    closeAddModal();
    load();
    showToast('Memory saved!', 'success');
  } catch (err) {
    showToast('Failed to save memory', 'error');
  }
}

function resetPhotoPreview() {
  selectedImageBase64 = null;
  document.getElementById('photo-preview-container').style.display = 'none';
  document.getElementById('photo-preview').src = '';
  document.getElementById('photo-input').value = '';
}

async function handleActions(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;

  if (action === 'delete') {
    if (!confirm('Hapus memory ini?')) return;
    await del(`/memories?id=${id}`);
    load();
    showToast('Memory dihapus', 'success');
  } else if (action === 'edit') {
    openEditModal(id, btn.dataset.title, btn.dataset.note, btn.dataset.version);
  }
}

function openAddModal() {
  addOverlay.classList.add('active');
  addOverlay.querySelector('.bottom-sheet').classList.add('active');
}

function closeAddModal() {
  addOverlay.classList.remove('active');
  addOverlay.querySelector('.bottom-sheet').classList.remove('active');
  resetPhotoPreview();
}

function openEditModal(id, title, note, version) {
  currentEditId = id;
  currentEditVersion = version ? Number(version) : undefined;

  const titleInput = editOverlay.querySelector('input[name="title"]');
  const noteInput = editOverlay.querySelector('textarea[name="note"]');

  titleInput.value = title;
  noteInput.value = note;

  editOverlay.classList.add('active');
  editOverlay.querySelector('.bottom-sheet').classList.add('active');
}

function closeEditModal() {
  editOverlay.classList.remove('active');
  editOverlay.querySelector('.bottom-sheet').classList.remove('active');
  currentEditId = null;
}

async function handleUpdate() {
  if (!currentEditId) return;

  const title = editOverlay.querySelector('input[name="title"]').value.trim();
  const note = editOverlay.querySelector('textarea[name="note"]').value.trim();

  if (!title) { showToast('Title required', 'error'); return; }

  try {
    const res = await put('/memories', {
      id: currentEditId,
      title,
      note,
      version: currentEditVersion
    });

    if (res.error) {
      showToast(res.error, 'error');
      return;
    }

    showToast('Memory updated!', 'success');
    load();
    closeEditModal();
  } catch (err) {
    showToast('Update failed', 'error');
  }
}

function initPhotoUpload() {
  const input = document.getElementById('photo-input');
  const preview = document.getElementById('photo-preview');
  const container = document.getElementById('photo-preview-container');
  const removeBtn = document.getElementById('remove-photo');

  input.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      showToast('File terlalu besar (max 5MB)', 'error');
      return;
    }

    try {
      showToast('Memproses gambar...', 'info');
      selectedImageBase64 = await compressImage(file);
      preview.src = selectedImageBase64;
      container.style.display = 'block';
    } catch (err) {
      showToast('Gagal memproses gambar', 'error');
    }
  });

  removeBtn.addEventListener('click', resetPhotoPreview);
}

function init() {
  addOverlay = document.getElementById('add-overlay');
  editOverlay = document.getElementById('modal-edit');

  document.querySelector('#create-memory').addEventListener('submit', handleCreate);
  document.querySelector('#memories-list').addEventListener('click', handleActions);
  document.getElementById('open-add').addEventListener('click', openAddModal);
  document.getElementById('add-cancel').addEventListener('click', closeAddModal);
  document.getElementById('modal-close').addEventListener('click', closeEditModal);
  document.getElementById('modal-save').addEventListener('click', handleUpdate);

  initPhotoUpload();
  load();
}

document.addEventListener('DOMContentLoaded', init);

