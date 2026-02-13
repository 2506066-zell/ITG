import { initProtected, showToast } from './main.js';
import { get, post, put, del } from './api.js';

let selectedImageBase64 = null;
let currentEditId = null;
let currentEditVersion = null;

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
        
        // Compress to JPEG 0.7 quality
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
  
  // Skeleton
  for (let i = 0; i < 3; i++) {
    const sk = document.createElement('div');
    sk.className = 'list-item';
    sk.innerHTML = `<div style="width:80%"><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line"></div></div>`;
    list.appendChild(sk);
  }
  
  const data = await get('/memories');
  list.innerHTML = '';
  
  if (!data.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-photo-film';
    empty.appendChild(icon);
    const text = document.createTextNode(' Belum ada memory. Tambahkan di form sebelah.');
    empty.appendChild(text);
    list.appendChild(empty);
    return;
  }
  
  // Sort newest first
  data.sort((a, b) => b.id - a.id);
  
  data.forEach(m => {
    const el = document.createElement('div');
    el.className = 'list-item';
    el.style.display = 'block'; // Override flex
    
    // Header (Title & Actions)
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.marginBottom = '8px';
    
    const titleEl = document.createElement('strong');
    titleEl.textContent = m.title || 'Untitled';
    titleEl.style.fontSize = '1.1rem';
    
    const actions = document.createElement('div');
    actions.className = 'actions';
    
    // Edit Button
    const editBtn = document.createElement('button');
    editBtn.className = 'btn secondary small';
    editBtn.dataset.id = String(m.id);
    editBtn.dataset.action = 'edit';
    editBtn.dataset.title = m.title || '';
    editBtn.dataset.note = m.note || '';
    editBtn.dataset.version = String(m.version || 0);
    editBtn.innerHTML = '<i class="fa-solid fa-pen"></i>';
    
    // Delete Button
    const delBtn = document.createElement('button');
    delBtn.className = 'btn danger small';
    delBtn.dataset.id = String(m.id);
    delBtn.dataset.action = 'delete';
    delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    header.appendChild(titleEl);
    header.appendChild(actions);
    
    el.appendChild(header);
    
    // Content (Image)
    if (m.media_data && m.media_type === 'image') {
      const img = document.createElement('img');
      img.src = m.media_data;
      img.style.width = '100%';
      img.style.borderRadius = '12px';
      img.style.marginBottom = '10px';
      img.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
      img.loading = 'lazy';
      el.appendChild(img);
    }
    
    // Note
    if (m.note) {
      const noteEl = document.createElement('div');
      noteEl.className = 'muted';
      noteEl.style.whiteSpace = 'pre-wrap';
      noteEl.textContent = m.note;
      el.appendChild(noteEl);
    }
    
    // Date
    const dateEl = document.createElement('div');
    dateEl.className = 'muted small';
    dateEl.style.marginTop = '8px';
    dateEl.style.fontSize = '0.8rem';
    dateEl.textContent = new Date(m.created_at).toLocaleString();
    el.appendChild(dateEl);

    list.appendChild(el);
  });
}

async function handleCreate(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  
  const f = new FormData(e.target);
  
  try {
    const body = {
      title: f.get('title'),
      media_type: selectedImageBase64 ? 'image' : 'text',
      media_data: selectedImageBase64 || '',
      note: f.get('note')
    };
    
    await post('/memories', body);
    
    // Reset form
    e.target.reset();
    selectedImageBase64 = null;
    document.getElementById('photo-preview-container').style.display = 'none';
    document.getElementById('photo-preview').src = '';
    
    load();
    showToast('Memory uploaded!', 'success');
  } catch (err) {
    showToast('Failed to save memory: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleActions(e) {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  
  if (action === 'delete') {
    if (!confirm('Delete this memory?')) return;
    await del(`/memories?id=${id}`);
    load();
    showToast('Memory deleted', 'success');
  } else if (action === 'edit') {
    openEditModal(id, btn.dataset.title, btn.dataset.note, btn.dataset.version);
  }
}

function openEditModal(id, title, note, version) {
  currentEditId = id;
  currentEditVersion = version ? Number(version) : undefined;
  const modal = document.getElementById('modal-edit');
  const titleInput = modal.querySelector('input[name="title"]');
  const noteInput = modal.querySelector('textarea[name="note"]');
  
  titleInput.value = title;
  noteInput.value = note;
  modal.classList.add('active');
}

function initEditModal() {
  const modal = document.getElementById('modal-edit');
  const closeBtn = document.getElementById('modal-close');
  const saveBtn = document.getElementById('modal-save');
  const titleInput = modal.querySelector('input[name="title"]');
  const noteInput = modal.querySelector('textarea[name="note"]');

  const closeModal = () => {
    modal.classList.remove('active');
    currentEditId = null;
  };
  
  closeBtn.onclick = closeModal;
  
  // Close on outside click
  modal.onclick = (e) => {
    if (e.target === modal) closeModal();
  };
  
  saveBtn.onclick = async () => {
    if (!currentEditId) return;
    
    const title = titleInput.value.trim();
    const note = noteInput.value.trim();
    
    if (!title) {
      showToast('Title cannot be empty', 'error');
      return;
    }
    
    try {
      saveBtn.disabled = true;
      const originalText = saveBtn.innerHTML;
      saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
      
      const res = await put('/memories', {
        id: currentEditId,
        title,
        note,
        version: currentEditVersion
      });
      
      if (res.error) {
        showToast(res.error, 'error');
        if (res.error.includes('Conflict')) {
          load();
          closeModal();
        }
        saveBtn.innerHTML = originalText;
        return;
      }
      
      showToast('Memory updated!', 'success');
      load();
      closeModal();
      saveBtn.innerHTML = originalText;
    } catch (err) {
      showToast('Failed to update: ' + err.message, 'error');
      saveBtn.innerHTML = originalText;
    } finally {
      saveBtn.disabled = false;
    }
  };
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
      showToast('Image too large (max 5MB)', 'error');
      return;
    }
    
    try {
      showToast('Compressing image...', 'info');
      selectedImageBase64 = await compressImage(file);
      preview.src = selectedImageBase64;
      container.style.display = 'block';
    } catch (err) {
      showToast('Error reading image', 'error');
      console.error(err);
    }
  });
  
  removeBtn.addEventListener('click', () => {
    input.value = '';
    selectedImageBase64 = null;
    container.style.display = 'none';
    preview.src = '';
  });
}

function init() {
  document.querySelector('#create-memory').addEventListener('submit', handleCreate);
  document.querySelector('#memories-list').addEventListener('click', handleActions);
  initPhotoUpload();
  initEditModal();
  load();
}

document.addEventListener('DOMContentLoaded', init);
