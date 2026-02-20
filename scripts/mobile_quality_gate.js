import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function read(filePath) {
  const abs = path.join(ROOT, filePath);
  return fs.readFileSync(abs, 'utf8');
}

function exists(filePath) {
  const abs = path.join(ROOT, filePath);
  return fs.existsSync(abs);
}

function normalize(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function asPattern(value) {
  return value instanceof RegExp ? value : new RegExp(escapeRegex(String(value || '')));
}

function escapeRegex(raw) {
  return String(raw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function contains(text, pattern) {
  const regex = asPattern(pattern);
  return regex.test(text);
}

const checks = [];

function addCheck(name, fn) {
  checks.push({ name, fn });
}

function requiredFiles() {
  return [
    'chat.html',
    'class-notes-editor.html',
    'college-assignments.html',
    'css/chat.css',
    'js/chat.js',
    'js/class_notes_editor.js',
    'js/assignments.js',
    'public/chat.html',
    'public/class-notes-editor.html',
    'public/college-assignments.html',
    'public/js/chat.js',
    'public/js/class_notes_editor.js',
    'public/js/assignments.js',
  ];
}

addCheck('File wajib mobile gate tersedia', () => {
  const missing = requiredFiles().filter((item) => !exists(item));
  if (missing.length) {
    return { ok: false, detail: `Missing: ${missing.join(', ')}` };
  }
  return { ok: true, detail: 'Semua file utama tersedia.' };
});

addCheck('Chat CSS punya breakpoint 768/412/360', () => {
  const css = read('css/chat.css');
  const ok =
    contains(css, '@media (max-width: 768px)') &&
    contains(css, '@media (max-width: 412px)') &&
    contains(css, '@media (max-width: 360px)');
  return {
    ok,
    detail: ok
      ? 'Breakpoint mobile lengkap.'
      : 'Breakpoint 768/412/360 belum lengkap di css/chat.css',
  };
});

addCheck('Chat keyboard-open hardening aktif', () => {
  const css = read('css/chat.css');
  const js = read('js/chat.js');
  const ok =
    contains(css, '.chat-page.chat-keyboard-open .assistant-command-bar') &&
    contains(css, '.chat-page.chat-keyboard-open .container.chat-container') &&
    contains(css, 'env(safe-area-inset-bottom') &&
    contains(js, 'function initMobileKeyboardMode') &&
    contains(js, 'visualViewport') &&
    contains(js, 'setChatKeyboardOpen');
  return {
    ok,
    detail: ok
      ? 'Chat keyboard-safe tersedia.'
      : 'Rule keyboard-safe chat belum lengkap (css/js).',
  };
});

addCheck('Class notes punya mode Compact/Review + keyboard-safe', () => {
  const html = read('class-notes-editor.html');
  const js = read('js/class_notes_editor.js');
  const ok =
    contains(html, 'id="notes-view-compact"') &&
    contains(html, 'id="notes-view-review"') &&
    contains(html, '.class-notes-page.notes-keyboard-open .bottom-nav') &&
    contains(js, 'NOTES_HISTORY_VIEW_MODE_KEY') &&
    contains(js, 'function initNotesMobileKeyboardMode') &&
    contains(js, "notes-keyboard-open");
  return {
    ok,
    detail: ok
      ? 'Catatan support mode view + keyboard-safe.'
      : 'Mode view / keyboard-safe catatan belum lengkap.',
  };
});

addCheck('Assignments punya keyboard-safe hardening', () => {
  const html = read('college-assignments.html');
  const js = read('js/assignments.js');
  const ok =
    contains(html, 'assignments-keyboard-open') &&
    contains(html, 'env(safe-area-inset-bottom') &&
    contains(js, 'function initAssignmentsMobileKeyboardMode') &&
    contains(js, 'setAssignmentsKeyboardOpen');
  return {
    ok,
    detail: ok
      ? 'Tugas kuliah keyboard-safe tersedia.'
      : 'Keyboard-safe assignments belum lengkap.',
  };
});

function mirrorPairs() {
  return [
    ['chat.html', 'public/chat.html'],
    ['class-notes-editor.html', 'public/class-notes-editor.html'],
    ['college-assignments.html', 'public/college-assignments.html'],
    ['js/chat.js', 'public/js/chat.js'],
    ['js/class_notes_editor.js', 'public/js/class_notes_editor.js'],
    ['js/assignments.js', 'public/js/assignments.js'],
  ];
}

addCheck('Mirror root/public sinkron', () => {
  const outOfSync = [];
  for (const [source, mirror] of mirrorPairs()) {
    if (!exists(source) || !exists(mirror)) {
      outOfSync.push(`${source} -> ${mirror} (missing)`);
      continue;
    }
    const srcText = normalize(read(source));
    const mirrorText = normalize(read(mirror));
    if (srcText !== mirrorText) {
      outOfSync.push(`${source} -> ${mirror} (different)`);
    }
  }
  if (outOfSync.length) {
    return {
      ok: false,
      detail: `Tidak sinkron: ${outOfSync.join('; ')}`,
    };
  }
  return { ok: true, detail: 'Semua mirror sinkron.' };
});

addCheck('Skenario viewport 390 (base mobile) siap', () => {
  const css = read('css/chat.css');
  const ok =
    contains(css, '@media (max-width: 768px)') &&
    contains(css, 'height: calc(100dvh - 58px - env(safe-area-inset-bottom, 0px));');
  return {
    ok,
    detail: ok
      ? 'Base mobile layout tersedia untuk 390px.'
      : 'Rule base mobile 390px belum valid.',
  };
});

addCheck('Skenario viewport 412 siap', () => {
  const css = read('css/chat.css');
  const ok =
    contains(css, '@media (max-width: 412px)') &&
    contains(css, '.chat-page .container.chat-container') &&
    contains(css, 'height: calc(100dvh - 54px - env(safe-area-inset-bottom, 0px));');
  return {
    ok,
    detail: ok
      ? 'Rule khusus 412px tersedia.'
      : 'Rule khusus 412px belum lengkap.',
  };
});

addCheck('Skenario viewport 360 siap', () => {
  const css = read('css/chat.css');
  const ok =
    contains(css, '@media (max-width: 360px)') &&
    contains(css, 'height: calc(100dvh - 52px - env(safe-area-inset-bottom, 0px));');
  return {
    ok,
    detail: ok
      ? 'Rule khusus 360px tersedia.'
      : 'Rule khusus 360px belum lengkap.',
  };
});

function run() {
  let failed = 0;
  console.log('\nMobile UX Quality Gate\n');
  for (const check of checks) {
    let result;
    try {
      result = check.fn();
    } catch (err) {
      result = { ok: false, detail: `Error: ${err?.message || String(err)}` };
    }
    if (result.ok) {
      console.log(`PASS  ${check.name}`);
    } else {
      failed += 1;
      console.log(`FAIL  ${check.name}`);
    }
    if (result.detail) {
      console.log(`      ${result.detail}`);
    }
  }
  console.log(`\nResult: ${failed ? 'FAILED' : 'PASSED'} (${checks.length - failed}/${checks.length})`);
  if (failed) process.exit(1);
}

run();
