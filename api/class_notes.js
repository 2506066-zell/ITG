import { pool, readBody, verifyToken, withErrorHandling, sendJson, logActivity } from './_lib.js';
import {
  buildSemesterMeta,
  ensureAcademicSemesterPreferenceSchema,
  getAcademicSemesterPreference,
  parseSemesterKey,
} from './_academic_semester.js';

const DEFAULT_TRASH_RETENTION_DAYS = 30;

function localDateText(baseDate = new Date()) {
  const d = new Date(baseDate);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(dateText, days = 0) {
  const d = new Date(`${String(dateText || '').slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return localDateText();
  d.setDate(d.getDate() + Number(days || 0));
  return localDateText(d);
}

function weekRange(dateText = localDateText()) {
  const base = new Date(`${String(dateText || '').slice(0, 10)}T00:00:00`);
  if (Number.isNaN(base.getTime())) {
    const today = localDateText();
    return { from: today, to: today };
  }
  const day = base.getDay() === 0 ? 7 : base.getDay();
  base.setDate(base.getDate() - (day - 1));
  const end = new Date(base);
  end.setDate(base.getDate() + 6);
  return {
    from: localDateText(base),
    to: localDateText(end),
  };
}

function toDayId(dateText) {
  const d = new Date(`${dateText}T00:00:00`);
  const dow = d.getDay(); // 0=Sun
  return dow === 0 ? 7 : dow; // 1=Mon ... 7=Sun
}

function parsePathMode(req) {
  const url = new URL(req.url, 'http://x');
  const rawPath = String(url.searchParams.get('path') || '').trim().replace(/^\/+|\/+$/g, '');
  const subPath = rawPath.startsWith('class_notes/') ? rawPath.slice('class_notes/'.length) : '';
  const pathname = String(url.pathname || '');
  const m = pathname.match(/\/api\/class_notes\/?(.*)$/i);
  const pathTail = (m?.[1] || '').replace(/^\/+|\/+$/g, '');
  const mode = String(subPath || pathTail || '').toLowerCase();
  return { url, mode };
}

function parseBool(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function toInt(value, fallback = 0, min = null, max = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  let out = Math.trunc(n);
  if (Number.isFinite(min)) out = Math.max(Number(min), out);
  if (Number.isFinite(max)) out = Math.min(Number(max), out);
  return out;
}

function normalizeText(value, max = 3000) {
  return String(value || '').trim().slice(0, max);
}

function normalizeConfidence(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  return null;
}

function normalizeMoodFocus(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > 5) return null;
  return Math.round(n);
}

function normalizeArchiveStatus(value, allowAll = false) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'active' || v === 'archived' || v === 'trashed') return v;
  if (allowAll && v === 'all') return 'all';
  return '';
}

function normalizeVaultAction(value) {
  const v = String(value || '').trim().toLowerCase();
  if (['archive', 'unarchive', 'pin', 'unpin', 'trash', 'restore', 'purge'].includes(v)) return v;
  return '';
}

function isMinimumCompleted(payload = {}) {
  const keyPoints = normalizeText(payload.key_points, 3000);
  const nextAction = normalizeText(payload.action_items, 3000);
  const freeText = normalizeText(payload.free_text, 5000);
  return Boolean(keyPoints || nextAction || freeText);
}

function firstMeaningfulLine(text = '', fallback = '') {
  const lines = String(text || '')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  return (lines[0] || fallback || '').slice(0, 180);
}

function toDisplayName(userId = '') {
  const raw = String(userId || '').trim();
  if (!raw) return 'Kamu';
  return raw
    .split(/\s+/)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ')
    .slice(0, 40);
}

function normalizeUserId(value = '') {
  const t = String(value || '').trim();
  if (!t) return '';
  if (/^zaldy$/i.test(t)) return 'Zaldy';
  if (/^nesya$/i.test(t)) return 'Nesya';
  return t.slice(0, 60);
}

function partnerFor(user = '') {
  if (user === 'Zaldy') return 'Nesya';
  if (user === 'Nesya') return 'Zaldy';
  return null;
}

function subjectStyle(subject = '') {
  const t = String(subject || '').toLowerCase();
  if (/(kalkulus|matematika|statistika|aljabar|diskrit|logika)/.test(t)) return 'logic';
  if (/(algoritma|pemrograman|basis data|daspro|sistem operasi|jaringan)/.test(t)) return 'build';
  if (/(agama|pancasila|bahasa|komunikasi|sejarah|kewarganegaraan)/.test(t)) return 'reading';
  return 'general';
}

function tidySentence(value = '', max = 180) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.slice(0, max).replace(/[.,;:!?-]+$/g, '').trim();
}

function computeQualityScore(note = {}) {
  const keyPointsLen = normalizeText(note.key_points, 6000).length;
  const actionLen = normalizeText(note.action_items, 6000).length;
  const questionsLen = normalizeText(note.questions, 6000).length;
  const freeTextLen = normalizeText(note.free_text, 9000).length;
  const hasSummary = Boolean(normalizeText(note.summary_text, 500));
  const hasNext = Boolean(normalizeText(note.next_action_text, 500));

  let score = 0;
  if (keyPointsLen > 0) score += Math.min(30, 10 + Math.round(keyPointsLen / 60));
  if (actionLen > 0) score += Math.min(24, 8 + Math.round(actionLen / 70));
  if (questionsLen > 0) score += Math.min(16, 6 + Math.round(questionsLen / 90));
  if (freeTextLen > 0) score += Math.min(18, 6 + Math.round(freeTextLen / 120));
  if (hasSummary) score += 6;
  if (hasNext) score += 6;
  const confidence = normalizeConfidence(note.confidence);
  if (confidence === 'high') score += 6;
  if (confidence === 'medium') score += 4;
  if (confidence === 'low') score += 2;
  if (normalizeMoodFocus(note.mood_focus)) score += 4;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function parseNaturalQuery(raw = '', now = new Date()) {
  const text = normalizeText(raw, 220).toLowerCase();
  const out = {
    keyword: normalizeText(raw, 220),
    subject: '',
    from: '',
    to: '',
    requireQuestions: false,
  };
  if (!text) return out;

  const today = localDateText(now);
  if (text.includes('hari ini')) {
    out.from = today;
    out.to = today;
  }
  if (text.includes('kemarin')) {
    const yesterday = addDays(today, -1);
    out.from = yesterday;
    out.to = yesterday;
  }
  if (text.includes('minggu ini')) {
    const range = weekRange(today);
    out.from = range.from;
    out.to = range.to;
  }
  if (text.includes('minggu lalu')) {
    const range = weekRange(addDays(today, -7));
    out.from = range.from;
    out.to = range.to;
  }

  const subjectMatch = text.match(/catatan\s+([a-z0-9&\-\s]{2,80})/i);
  if (subjectMatch?.[1]) out.subject = normalizeText(subjectMatch[1], 100);
  if (/\b(yang belum paham|belum paham|tidak paham)\b/.test(text)) out.requireQuestions = true;

  let keyword = text;
  keyword = keyword
    .replace(/\bminggu ini\b/g, ' ')
    .replace(/\bminggu lalu\b/g, ' ')
    .replace(/\bhari ini\b/g, ' ')
    .replace(/\bkemarin\b/g, ' ')
    .replace(/\bcatatan\s+[a-z0-9&\-\s]{2,80}/g, ' ')
    .replace(/\b(yang belum paham|belum paham|tidak paham)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  out.keyword = normalizeText(keyword, 200);
  return out;
}

async function buildSmartLayer(client, userId, source = {}) {
  const userName = toDisplayName(userId);
  const subject = normalizeText(source.subject, 140) || 'kelas ini';
  const keyPoints = normalizeText(source.key_points, 3000);
  const actionItems = normalizeText(source.action_items, 3000);
  const questions = normalizeText(source.questions, 3000);
  const freeText = normalizeText(source.free_text, 5000);
  const style = subjectStyle(subject);

  const summarySeed = tidySentence(firstMeaningfulLine(keyPoints || freeText, ''), 170);
  let summaryText = '';
  if (summarySeed) {
    summaryText = `${userName}, catatan ${subject} sudah rapi. Intinya: ${summarySeed}.`;
  } else if (style === 'logic') {
    summaryText = `${userName}, poin ${subject} sudah aman. Fokus ke rumus inti dan contoh hitungnya.`;
  } else if (style === 'build') {
    summaryText = `${userName}, catatan ${subject} sudah tersimpan. Fokus ke alur konsep lalu praktik kecil.`;
  } else if (style === 'reading') {
    summaryText = `${userName}, catatan ${subject} sudah beres. Fokus ke ide utama dan 1 contoh aplikasinya.`;
  } else {
    summaryText = `${userName}, catatan ${subject} sudah tersimpan. Lanjutkan review singkat supaya makin nempel.`;
  }

  let nextActionText = tidySentence(firstMeaningfulLine(actionItems, ''), 170);
  if (!nextActionText && questions) {
    nextActionText = `Lanjut 20 menit: jawab 1 pertanyaan utama ${subject} lalu cek 1 referensi pendukung.`;
  }
  if (!nextActionText) {
    if (style === 'logic') {
      nextActionText = `Mulai 20 menit sekarang: kerjakan 2 soal ${subject} dari yang paling dasar.`;
    } else if (style === 'build') {
      nextActionText = `Mulai 25 menit: lanjut praktik ${subject} 1 langkah kecil sampai bisa running.`;
    } else if (style === 'reading') {
      nextActionText = `Mulai 15 menit: rangkum 3 poin ${subject} dengan bahasamu sendiri.`;
    } else {
      nextActionText = `Mulai 15-25 menit: review ${subject} lalu tulis 3 poin yang paling kamu ingat.`;
    }
  } else {
    nextActionText = `Lanjut sekarang: ${nextActionText}.`;
  }

  const subjectLike = `%${subject}%`;
  const [taskRisk, assignmentRisk, taskMatch, assignmentMatch] = await Promise.all([
    client.query(
      `SELECT COUNT(*)::int AS due24
         FROM tasks
        WHERE is_deleted = FALSE
          AND completed = FALSE
          AND deadline IS NOT NULL
          AND deadline <= NOW() + INTERVAL '24 hours'
          AND (assigned_to = $1 OR created_by = $1)`,
      [userId]
    ),
    client.query(
      `SELECT COUNT(*)::int AS due24
         FROM assignments
        WHERE completed = FALSE
          AND deadline IS NOT NULL
          AND deadline <= NOW() + INTERVAL '24 hours'
          AND (assigned_to = $1 OR assigned_to IS NULL)`,
      [userId]
    ),
    client.query(
      `SELECT COUNT(*)::int AS cnt
         FROM tasks
        WHERE is_deleted = FALSE
          AND completed = FALSE
          AND (assigned_to = $1 OR created_by = $1)
          AND title ILIKE $2`,
      [userId, subjectLike]
    ),
    client.query(
      `SELECT COUNT(*)::int AS cnt
         FROM assignments
        WHERE completed = FALSE
          AND (assigned_to = $1 OR assigned_to IS NULL)
          AND (title ILIKE $2 OR COALESCE(description, '') ILIKE $2)`,
      [userId, subjectLike]
    ),
  ]);

  const due24 = Number(taskRisk.rows?.[0]?.due24 || 0) + Number(assignmentRisk.rows?.[0]?.due24 || 0);
  const related = Number(taskMatch.rows?.[0]?.cnt || 0) + Number(assignmentMatch.rows?.[0]?.cnt || 0);

  let riskHint = `${userName}, status aman. Pertahankan ritme catat lalu eksekusi langkah kecil setelah kelas.`;
  if (due24 > 0 && related > 0) {
    riskHint = `${userName}, ada ${due24} deadline <24 jam dan ${related} item terkait ${subject}. Kerjakan 1 item paling mepet sekarang.`;
  } else if (due24 > 0) {
    riskHint = `${userName}, ada ${due24} deadline <24 jam. Turunkan catatan ini jadi aksi 15-25 menit biar tidak numpuk.`;
  } else if (related > 0) {
    riskHint = `${userName}, ada ${related} item terkait ${subject}. Catatan ini bisa langsung dipakai buat percepat eksekusi.`;
  }

  return {
    summary_text: summaryText.slice(0, 500),
    next_action_text: nextActionText.slice(0, 500),
    risk_hint: riskHint.slice(0, 500),
  };
}

export async function ensureClassNotesSchema(client = null) {
  if (global._classNotesSchemaReady) return;
  await ensureAcademicSemesterPreferenceSchema(client);
  const run = (sql, params = []) => (client ? client.query(sql, params) : pool.query(sql, params));

  await run(`
    CREATE TABLE IF NOT EXISTS class_notes (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(60) NOT NULL,
      schedule_id INTEGER NOT NULL REFERENCES schedule(id) ON DELETE CASCADE,
      class_date DATE NOT NULL,
      day_id INTEGER,
      subject VARCHAR(140) NOT NULL,
      room VARCHAR(80),
      lecturer VARCHAR(140),
      time_start TIME,
      time_end TIME,
      key_points TEXT DEFAULT '',
      action_items TEXT DEFAULT '',
      questions TEXT DEFAULT '',
      free_text TEXT DEFAULT '',
      mood_focus INTEGER,
      confidence VARCHAR(10),
      summary_text TEXT DEFAULT '',
      next_action_text TEXT DEFAULT '',
      risk_hint TEXT DEFAULT '',
      is_minimum_completed BOOLEAN DEFAULT FALSE,
      archive_status VARCHAR(20) NOT NULL DEFAULT 'active',
      archived_at TIMESTAMPTZ,
      pinned BOOLEAN NOT NULL DEFAULT FALSE,
      quality_score SMALLINT DEFAULT 0,
      deleted_at TIMESTAMPTZ,
      deleted_by VARCHAR(60),
      purge_after TIMESTAMPTZ,
      updated_by VARCHAR(60),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, schedule_id, class_date)
    )
  `);

  await run(`ALTER TABLE class_notes ADD COLUMN IF NOT EXISTS archive_status VARCHAR(20) NOT NULL DEFAULT 'active'`);
  await run(`ALTER TABLE class_notes ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
  await run(`ALTER TABLE class_notes ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE`);
  await run(`ALTER TABLE class_notes ADD COLUMN IF NOT EXISTS quality_score SMALLINT DEFAULT 0`);
  await run(`ALTER TABLE class_notes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await run(`ALTER TABLE class_notes ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(60)`);
  await run(`ALTER TABLE class_notes ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ`);
  await run(`ALTER TABLE class_notes ADD COLUMN IF NOT EXISTS updated_by VARCHAR(60)`);

  await run(`
    CREATE TABLE IF NOT EXISTS class_note_revisions (
      id BIGSERIAL PRIMARY KEY,
      note_id BIGINT NOT NULL REFERENCES class_notes(id) ON DELETE CASCADE,
      version_no INTEGER NOT NULL,
      user_id VARCHAR(60) NOT NULL,
      key_points TEXT DEFAULT '',
      action_items TEXT DEFAULT '',
      questions TEXT DEFAULT '',
      free_text TEXT DEFAULT '',
      mood_focus INTEGER,
      confidence VARCHAR(10),
      summary_text TEXT DEFAULT '',
      next_action_text TEXT DEFAULT '',
      risk_hint TEXT DEFAULT '',
      change_reason VARCHAR(40) DEFAULT 'save',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (note_id, version_no)
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_class_notes_user_date ON class_notes(user_id, class_date DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_class_notes_schedule_date ON class_notes(schedule_id, class_date DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_class_notes_subject_date ON class_notes(subject, class_date DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_class_notes_status_date ON class_notes(user_id, archive_status, class_date DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_class_notes_partner_read ON class_notes(archive_status, class_date DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_class_notes_subject_status ON class_notes(subject, archive_status, class_date DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_class_note_revisions_note_time ON class_note_revisions(note_id, created_at DESC)`);

  await run(`UPDATE class_notes SET archive_status = 'active' WHERE archive_status IS NULL`);
  await run(`UPDATE class_notes SET quality_score = 0 WHERE quality_score IS NULL`);
  global._classNotesSchemaReady = true;
}

async function createRevisionSnapshot(client, noteId, userId, reason = 'save') {
  await client.query(
    `INSERT INTO class_note_revisions (
      note_id,
      version_no,
      user_id,
      key_points,
      action_items,
      questions,
      free_text,
      mood_focus,
      confidence,
      summary_text,
      next_action_text,
      risk_hint,
      change_reason
    )
    SELECT
      n.id,
      COALESCE((SELECT MAX(r.version_no) + 1 FROM class_note_revisions r WHERE r.note_id = n.id), 1),
      $2,
      n.key_points,
      n.action_items,
      n.questions,
      n.free_text,
      n.mood_focus,
      n.confidence,
      n.summary_text,
      n.next_action_text,
      n.risk_hint,
      $3
    FROM class_notes n
    WHERE n.id = $1`,
    [noteId, userId, String(reason || 'save').slice(0, 40)]
  );
}

async function readSingleNote(client, noteId) {
  const r = await client.query('SELECT * FROM class_notes WHERE id = $1', [noteId]);
  return r.rows?.[0] || null;
}

async function autoArchiveForOwners(client, owners = []) {
  if (!Array.isArray(owners) || !owners.length) return { archived: 0 };
  const res = await client.query(
    `UPDATE class_notes
        SET archive_status = 'archived',
            archived_at = COALESCE(archived_at, NOW()),
            updated_at = NOW()
      WHERE user_id = ANY($1::text[])
        AND archive_status = 'active'
        AND is_minimum_completed = TRUE
        AND (
          class_date < CURRENT_DATE
          OR (class_date = CURRENT_DATE AND time_end IS NOT NULL AND time_end <= CURRENT_TIME)
        )
      RETURNING id`,
    [owners]
  );
  return { archived: Number(res.rowCount || 0) };
}

async function purgeTrash(client, owners = []) {
  let sql = `
    DELETE FROM class_notes
     WHERE archive_status = 'trashed'
       AND purge_after IS NOT NULL
       AND purge_after < NOW()`;
  const params = [];
  if (Array.isArray(owners) && owners.length) {
    sql += ' AND user_id = ANY($1::text[])';
    params.push(owners);
  }
  sql += ' RETURNING id';
  const res = await client.query(sql, params);
  return { purged: Number(res.rowCount || 0) };
}

async function listClassNoteUsers(client) {
  const res = await client.query('SELECT DISTINCT user_id FROM class_notes WHERE user_id IS NOT NULL');
  return res.rows.map((x) => normalizeUserId(x.user_id)).filter(Boolean);
}

export async function runNotesVaultMaintenance(client, options = {}) {
  await ensureClassNotesSchema(client);
  const users = Array.isArray(options.users) && options.users.length
    ? options.users.map((u) => normalizeUserId(u)).filter(Boolean)
    : await listClassNoteUsers(client);
  const archiveStat = users.length
    ? await autoArchiveForOwners(client, users)
    : await autoArchiveForOwners(client, ['Zaldy', 'Nesya']);
  const purgeStat = users.length
    ? await purgeTrash(client, users)
    : await purgeTrash(client);
  return {
    users: users.length,
    archived: archiveStat.archived,
    purged: purgeStat.purged,
  };
}

function buildOwnerScope(requestUser, ownerParam = '', withPartner = false) {
  const me = normalizeUserId(requestUser);
  const partner = partnerFor(me);
  const owner = normalizeUserId(ownerParam);
  if (owner) {
    if (owner === me) return { owners: [me], partner };
    if (withPartner && partner && owner === partner) return { owners: [partner], partner };
    return { owners: [], partner };
  }
  if (withPartner && partner) return { owners: [me, partner], partner };
  return { owners: [me], partner };
}

async function resolveVisibilityClause({ requestUser, ownerParam = '', withPartner = false, alias = 'n' }) {
  const scope = buildOwnerScope(requestUser, ownerParam, withPartner);
  const owners = scope.owners;
  const partner = scope.partner;
  if (!owners.length) return { blocked: true, text: 'FALSE', params: [] };
  const params = [owners];
  let text = `${alias}.user_id = ANY($1::text[])`;
  if (withPartner && partner && owners.includes(partner)) {
    params.push(partner);
    text += ` AND (${alias}.user_id <> $2 OR ${alias}.archive_status <> 'trashed')`;
  }
  return { blocked: false, text, params, owners, partner };
}

function applyNaturalToFilters(filters, natural) {
  if (!natural) return filters;
  const out = { ...filters };
  if (!out.subject && natural.subject) out.subject = natural.subject;
  if (!out.from && natural.from) out.from = natural.from;
  if (!out.to && natural.to) out.to = natural.to;
  if (!out.q && natural.keyword) out.q = natural.keyword;
  if (natural.requireQuestions) out.requireQuestions = true;
  return out;
}

function buildNoteWhereClause(baseVisibility, filters = {}, alias = 'n') {
  const where = [baseVisibility.text];
  const params = [...baseVisibility.params];
  let i = params.length + 1;

  const archiveStatus = normalizeArchiveStatus(filters.archive_status, true);
  if (archiveStatus && archiveStatus !== 'all') {
    where.push(`${alias}.archive_status = $${i++}`);
    params.push(archiveStatus);
  } else if (!archiveStatus) {
    where.push(`${alias}.archive_status <> 'trashed'`);
  }
  if (filters.date) {
    where.push(`${alias}.class_date = $${i++}::date`);
    params.push(filters.date);
  }
  if (Number(filters.schedule_id) > 0) {
    where.push(`${alias}.schedule_id = $${i++}`);
    params.push(Number(filters.schedule_id));
  }
  if (filters.subject) {
    where.push(`${alias}.subject ILIKE $${i++}`);
    params.push(`%${filters.subject}%`);
  }
  if (filters.from) {
    where.push(`${alias}.class_date >= $${i++}::date`);
    params.push(filters.from);
  }
  if (filters.to) {
    where.push(`${alias}.class_date <= $${i++}::date`);
    params.push(filters.to);
  }
  if (filters.semester_from) {
    where.push(`${alias}.class_date >= $${i++}::date`);
    params.push(filters.semester_from);
  }
  if (filters.semester_to) {
    where.push(`${alias}.class_date <= $${i++}::date`);
    params.push(filters.semester_to);
  }
  if (filters.requireQuestions) {
    where.push(`LENGTH(TRIM(COALESCE(${alias}.questions, ''))) > 0`);
  }
  if (filters.q) {
    where.push(`(
      ${alias}.subject ILIKE $${i}
      OR COALESCE(${alias}.key_points, '') ILIKE $${i}
      OR COALESCE(${alias}.action_items, '') ILIKE $${i}
      OR COALESCE(${alias}.questions, '') ILIKE $${i}
      OR COALESCE(${alias}.free_text, '') ILIKE $${i}
      OR COALESCE(${alias}.summary_text, '') ILIKE $${i}
      OR COALESCE(${alias}.next_action_text, '') ILIKE $${i}
      OR COALESCE(${alias}.risk_hint, '') ILIKE $${i}
    )`);
    params.push(`%${filters.q}%`);
  }

  return { where, params };
}

async function getScheduleSession(client, scheduleId) {
  const res = await client.query(
    `SELECT id, day_id, subject, room, lecturer, time_start, time_end
       FROM schedule
      WHERE id = $1`,
    [scheduleId]
  );
  return res.rows?.[0] || null;
}

function weekBucket(classDate = '') {
  const dt = String(classDate || '').slice(0, 10);
  const range = weekRange(dt || localDateText());
  return {
    key: range.from,
    label: `${range.from} s/d ${range.to}`,
    from: range.from,
    to: range.to,
  };
}

function buildGroupedVault(items = []) {
  const subjectMap = new Map();
  for (const item of items) {
    const subject = String(item.subject || 'Tanpa Mapel').trim() || 'Tanpa Mapel';
    const week = weekBucket(item.class_date);
    if (!subjectMap.has(subject)) {
      subjectMap.set(subject, { subject, total: 0, weeks: new Map() });
    }
    const subjectEntry = subjectMap.get(subject);
    subjectEntry.total += 1;
    if (!subjectEntry.weeks.has(week.key)) {
      subjectEntry.weeks.set(week.key, {
        week_key: week.key,
        week_label: week.label,
        from: week.from,
        to: week.to,
        total: 0,
        items: [],
      });
    }
    const weekEntry = subjectEntry.weeks.get(week.key);
    weekEntry.total += 1;
    weekEntry.items.push(item);
  }

  return [...subjectMap.values()]
    .map((subject) => ({
      subject: subject.subject,
      total: subject.total,
      weeks: [...subject.weeks.values()].sort((a, b) => String(b.week_key).localeCompare(String(a.week_key))),
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

function buildVaultInsightFromRows(rows = [], scope = 'week') {
  const total = rows.length;
  const counts = {
    total,
    active: rows.filter((x) => x.archive_status === 'active').length,
    archived: rows.filter((x) => x.archive_status === 'archived').length,
    trashed: rows.filter((x) => x.archive_status === 'trashed').length,
    pinned: rows.filter((x) => Boolean(x.pinned)).length,
    question_open: rows.filter((x) => normalizeText(x.questions || '')).length,
  };
  if (!total) {
    return {
      summary_text: 'Belum ada catatan di vault untuk filter ini.',
      next_action_text: 'Mulai dari satu sesi kuliah terdekat, isi poin penting, lalu simpan.',
      risk_hint: 'Tidak ada sinyal risiko dari arsip saat ini.',
      counts,
    };
  }

  const bySubject = new Map();
  rows.forEach((row) => {
    const subject = String(row.subject || 'Tanpa Mapel').trim() || 'Tanpa Mapel';
    bySubject.set(subject, (bySubject.get(subject) || 0) + 1);
  });
  const topSubject = [...bySubject.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'Mapel utama';
  const avgQuality = Math.round(rows.reduce((a, b) => a + Number(b.quality_score || 0), 0) / total);
  const topAction = rows.map((r) => normalizeText(r.next_action_text || '', 220)).find(Boolean);
  const topRisk = rows.map((r) => normalizeText(r.risk_hint || '', 220)).find(Boolean);
  const summary = scope === 'subject'
    ? `Vault mapel ini berisi ${total} catatan. Kualitas rata-rata ${avgQuality}/100, fokus terbesar di ${topSubject}.`
    : `Vault minggu ini berisi ${total} catatan. ${counts.archived} sudah diarsipkan, kualitas rata-rata ${avgQuality}/100.`;

  let riskHint = topRisk || 'Risiko rendah, lanjut jaga konsistensi catatan dan eksekusi kecil setelah kelas.';
  if (counts.question_open >= Math.max(2, Math.ceil(total * 0.35))) {
    riskHint = `Ada ${counts.question_open} catatan dengan pertanyaan terbuka. Prioritaskan sesi review 20 menit.`;
  }
  return {
    summary_text: summary,
    next_action_text: topAction || `Ambil 1 catatan ${topSubject} lalu eksekusi aksi belajar 15-25 menit sekarang.`,
    risk_hint: riskHint,
    counts,
  };
}

async function canReadNote(client, requestUser, noteId) {
  const note = await readSingleNote(client, noteId);
  if (!note) return { ok: false, status: 404, note: null };
  const me = normalizeUserId(requestUser);
  const partner = partnerFor(me);
  if (note.user_id === me) return { ok: true, status: 200, note, isOwner: true };
  if (partner && note.user_id === partner && note.archive_status !== 'trashed') {
    return { ok: true, status: 200, note, isOwner: false };
  }
  return { ok: false, status: 403, note: null };
}

async function handleVaultGet(req, res, user, url) {
  const withPartner = parseBool(url.searchParams.get('with_partner'));
  const owner = normalizeUserId(url.searchParams.get('owner') || '');
  const naturalEnabled = parseBool(url.searchParams.get('natural'));
  const page = toInt(url.searchParams.get('page'), 1, 1, 5000);
  const limit = toInt(url.searchParams.get('limit'), 24, 1, 100);
  const offset = (page - 1) * limit;

  const visibility = await resolveVisibilityClause({
    requestUser: user,
    ownerParam: owner,
    withPartner,
    alias: 'n',
  });

  if (visibility.blocked) {
    sendJson(res, 200, {
      items: [],
      grouped: [],
      pagination: { page, limit, total: 0, total_pages: 0 },
      filters: { owner, with_partner: withPartner, archive_status: 'archived' },
    });
    return;
  }

  const rawFilters = {
    archive_status: normalizeArchiveStatus(url.searchParams.get('archive_status'), true) || 'archived',
    q: normalizeText(url.searchParams.get('q') || '', 220),
    subject: normalizeText(url.searchParams.get('subject') || '', 120),
    from: String(url.searchParams.get('week_start') || '').trim().slice(0, 10),
    to: String(url.searchParams.get('week_end') || '').trim().slice(0, 10),
  };
  const naturalParsed = naturalEnabled ? parseNaturalQuery(rawFilters.q, new Date()) : null;
  const filters = applyNaturalToFilters(rawFilters, naturalParsed);
  if (naturalParsed?.requireQuestions) filters.requireQuestions = true;

  const client = await pool.connect();
  try {
    await ensureClassNotesSchema(client);
    await autoArchiveForOwners(client, visibility.owners);

    const built = buildNoteWhereClause(visibility, filters);
    const countRes = await client.query(
      `SELECT COUNT(*)::int AS total
         FROM class_notes n
        WHERE ${built.where.join(' AND ')}`,
      built.params
    );
    const total = Number(countRes.rows?.[0]?.total || 0);

    const rows = await client.query(
      `SELECT n.*,
              (n.user_id = $${built.params.length + 1}) AS is_owner,
              $${built.params.length + 2}::text AS viewer_user,
              CASE WHEN n.user_id = $${built.params.length + 2} THEN 'owner' ELSE 'partner' END AS ownership_view
         FROM class_notes n
        WHERE ${built.where.join(' AND ')}
        ORDER BY n.pinned DESC, n.class_date DESC, n.time_start ASC, n.updated_at DESC
        LIMIT $${built.params.length + 3}
       OFFSET $${built.params.length + 4}`,
      [...built.params, user, user, limit, offset]
    );

    const items = rows.rows.map((row) => ({
      ...row,
      week_key: weekBucket(row.class_date).key,
      week_label: weekBucket(row.class_date).label,
    }));

    sendJson(res, 200, {
      items,
      grouped: buildGroupedVault(items),
      pagination: {
        page,
        limit,
        total,
        total_pages: total > 0 ? Math.ceil(total / limit) : 0,
      },
      filters: {
        owner,
        with_partner: withPartner,
        archive_status: filters.archive_status || 'archived',
        q: filters.q || '',
        subject: filters.subject || '',
        week_start: filters.from || '',
        week_end: filters.to || '',
        natural: naturalEnabled,
      },
    }, 8);
  } finally {
    client.release();
  }
}

async function handleVaultInsightGet(req, res, user, url) {
  const withPartner = parseBool(url.searchParams.get('with_partner'));
  const owner = normalizeUserId(url.searchParams.get('owner') || '');
  const scope = String(url.searchParams.get('scope') || 'week').trim().toLowerCase() === 'subject' ? 'subject' : 'week';
  const subject = normalizeText(url.searchParams.get('subject') || '', 120);

  const visibility = await resolveVisibilityClause({
    requestUser: user,
    ownerParam: owner,
    withPartner,
    alias: 'n',
  });

  if (visibility.blocked) {
    sendJson(res, 200, buildVaultInsightFromRows([], scope), 8);
    return;
  }

  const nowDate = localDateText();
  let from = String(url.searchParams.get('week_start') || '').trim().slice(0, 10);
  let to = String(url.searchParams.get('week_end') || '').trim().slice(0, 10);
  if (!from || !to) {
    const wr = weekRange(nowDate);
    from = wr.from;
    to = wr.to;
  }

  const filters = {
    archive_status: 'all',
    subject,
    from: scope === 'week' ? from : '',
    to: scope === 'week' ? to : '',
  };

  const client = await pool.connect();
  try {
    await ensureClassNotesSchema(client);
    await autoArchiveForOwners(client, visibility.owners);
    const built = buildNoteWhereClause(visibility, filters);
    const result = await client.query(
      `SELECT n.*
         FROM class_notes n
        WHERE ${built.where.join(' AND ')}
        ORDER BY n.class_date DESC, n.updated_at DESC
        LIMIT 200`,
      built.params
    );

    sendJson(res, 200, buildVaultInsightFromRows(result.rows, scope), 8);
  } finally {
    client.release();
  }
}

async function handleSemesterGet(req, res, user, url) {
  const withPartner = parseBool(url.searchParams.get('with_partner'));
  const owner = normalizeUserId(url.searchParams.get('owner') || '');
  const subject = normalizeText(url.searchParams.get('subject') || '', 120);

  const visibility = await resolveVisibilityClause({
    requestUser: user,
    ownerParam: owner,
    withPartner,
    alias: 'n',
  });

  if (visibility.blocked) {
    sendJson(res, 200, {
      items: [],
      current_semester_key: '',
      current_semester_label: '',
      academic_year_start_month: 8,
    });
    return;
  }

  const client = await pool.connect();
  try {
    await ensureClassNotesSchema(client);
    await autoArchiveForOwners(client, visibility.owners);
    const pref = await getAcademicSemesterPreference(client, user);
    const startMonth = Number(pref.academic_year_start_month || 8);
    const currentMeta = buildSemesterMeta(localDateText(), startMonth);

    const built = buildNoteWhereClause(visibility, {
      archive_status: 'all',
      subject: subject || '',
    });
    const result = await client.query(
      `SELECT n.class_date
         FROM class_notes n
        WHERE ${built.where.join(' AND ')}`,
      built.params
    );

    const buckets = new Map();
    for (const row of result.rows || []) {
      const meta = buildSemesterMeta(row.class_date, startMonth);
      if (!meta?.semester_key) continue;
      if (!buckets.has(meta.semester_key)) {
        buckets.set(meta.semester_key, {
          semester_key: meta.semester_key,
          semester_label: meta.semester_label,
          from: meta.from,
          to: meta.to,
          total: 0,
        });
      }
      buckets.get(meta.semester_key).total += 1;
    }

    const items = [...buckets.values()].sort((a, b) => {
      const af = String(a.from || '');
      const bf = String(b.from || '');
      return bf.localeCompare(af);
    });

    sendJson(res, 200, {
      items,
      current_semester_key: currentMeta?.semester_key || pref.current_semester_key || '',
      current_semester_label: currentMeta?.semester_label || pref.current_semester_label || '',
      academic_year_start_month: startMonth,
      subject,
      owner,
      with_partner: withPartner,
    }, 20);
  } finally {
    client.release();
  }
}

async function handleVaultActionPost(req, res, user) {
  const body = req.body || await readBody(req);
  const noteId = toInt(body.note_id, 0, 1);
  const action = normalizeVaultAction(body.action);
  if (!noteId || !action) {
    res.status(400).json({ error: 'note_id dan action wajib diisi' });
    return;
  }

  const client = await pool.connect();
  try {
    await ensureClassNotesSchema(client);
    await client.query('BEGIN');

    const note = await readSingleNote(client, noteId);
    if (!note) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Catatan tidak ditemukan' });
      return;
    }
    if (normalizeUserId(note.user_id) !== user) {
      await client.query('ROLLBACK');
      res.status(403).json({ error: 'Hanya owner yang bisa memutasi catatan vault' });
      return;
    }

    if (action === 'purge') {
      if (note.archive_status !== 'trashed') {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'Purge hanya bisa untuk item di trash' });
        return;
      }
      await client.query('DELETE FROM class_notes WHERE id = $1', [noteId]);
      await logActivity(client, 'class_note', noteId, 'PURGE', user, { action: 'purge' });
      await client.query('COMMIT');
      sendJson(res, 200, { ok: true, action: 'purge', note_id: noteId, purged: true });
      return;
    }

    const updates = [];
    const params = [];
    let idx = 1;
    const pushValue = (value) => {
      params.push(value);
      return `$${idx++}`;
    };
    const setLit = (key, val) => updates.push(`${key} = ${val}`);
    const setVal = (key, val) => updates.push(`${key} = ${pushValue(val)}`);

    if (action === 'archive') {
      setVal('archive_status', 'archived');
      setLit('archived_at', 'COALESCE(archived_at, NOW())');
      setLit('deleted_at', 'NULL');
      setLit('deleted_by', 'NULL');
      setLit('purge_after', 'NULL');
    } else if (action === 'unarchive' || action === 'restore') {
      setVal('archive_status', 'active');
      setLit('archived_at', 'NULL');
      setLit('deleted_at', 'NULL');
      setLit('deleted_by', 'NULL');
      setLit('purge_after', 'NULL');
    } else if (action === 'trash') {
      setVal('archive_status', 'trashed');
      setLit('deleted_at', 'NOW()');
      setVal('deleted_by', user);
      setLit('purge_after', `NOW() + INTERVAL '${DEFAULT_TRASH_RETENTION_DAYS} days'`);
      setLit('archived_at', 'COALESCE(archived_at, NOW())');
    } else if (action === 'pin') {
      setLit('pinned', 'TRUE');
    } else if (action === 'unpin') {
      setLit('pinned', 'FALSE');
    }

    setVal('updated_by', user);
    setLit('updated_at', 'NOW()');

    const updateSql = `
      UPDATE class_notes
         SET ${updates.join(', ')}
       WHERE id = ${pushValue(noteId)}
       RETURNING *`;
    const updated = await client.query(updateSql, params);
    const row = updated.rows?.[0] || null;

    if (row) {
      await createRevisionSnapshot(client, Number(row.id), user, action);
      await logActivity(client, 'class_note', Number(row.id), action.toUpperCase(), user, {
        action,
        archive_status: row.archive_status,
        pinned: row.pinned,
      });
    }

    await client.query('COMMIT');
    sendJson(res, 200, { ok: true, action, note: row });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function handleRevisionsGet(req, res, user, url) {
  const noteId = toInt(url.searchParams.get('note_id'), 0, 1);
  if (!noteId) {
    res.status(400).json({ error: 'note_id wajib diisi' });
    return;
  }

  const client = await pool.connect();
  try {
    await ensureClassNotesSchema(client);
    await autoArchiveForOwners(client, [user]);
    const access = await canReadNote(client, user, noteId);
    if (!access.ok) {
      res.status(access.status).json({ error: access.status === 404 ? 'Catatan tidak ditemukan' : 'Forbidden' });
      return;
    }

    const rows = await client.query(
      `SELECT id, note_id, version_no, user_id, key_points, action_items, questions, free_text,
              mood_focus, confidence, summary_text, next_action_text, risk_hint, change_reason, created_at
         FROM class_note_revisions
        WHERE note_id = $1
        ORDER BY created_at DESC
        LIMIT 120`,
      [noteId]
    );
    sendJson(res, 200, { note_id: noteId, is_owner: Boolean(access.isOwner), items: rows.rows }, 8);
  } finally {
    client.release();
  }
}

async function handleRevisionsRestorePost(req, res, user) {
  const body = req.body || await readBody(req);
  const noteId = toInt(body.note_id, 0, 1);
  const revisionId = toInt(body.revision_id, 0, 1);
  if (!noteId || !revisionId) {
    res.status(400).json({ error: 'note_id dan revision_id wajib diisi' });
    return;
  }

  const client = await pool.connect();
  try {
    await ensureClassNotesSchema(client);
    await client.query('BEGIN');

    const note = await readSingleNote(client, noteId);
    if (!note) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Catatan tidak ditemukan' });
      return;
    }
    if (normalizeUserId(note.user_id) !== user) {
      await client.query('ROLLBACK');
      res.status(403).json({ error: 'Hanya owner yang bisa restore revisi' });
      return;
    }

    const revRes = await client.query(
      'SELECT * FROM class_note_revisions WHERE id = $1 AND note_id = $2',
      [revisionId, noteId]
    );
    const rev = revRes.rows?.[0];
    if (!rev) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Revisi tidak ditemukan' });
      return;
    }

    const restoredPayload = {
      key_points: normalizeText(rev.key_points, 6000),
      action_items: normalizeText(rev.action_items, 6000),
      questions: normalizeText(rev.questions, 6000),
      free_text: normalizeText(rev.free_text, 9000),
      mood_focus: normalizeMoodFocus(rev.mood_focus),
      confidence: normalizeConfidence(rev.confidence),
      summary_text: normalizeText(rev.summary_text, 500),
      next_action_text: normalizeText(rev.next_action_text, 500),
      risk_hint: normalizeText(rev.risk_hint, 500),
    };
    const minimumDone = isMinimumCompleted(restoredPayload);
    const quality = computeQualityScore(restoredPayload);

    const up = await client.query(
      `UPDATE class_notes
          SET key_points = $2,
              action_items = $3,
              questions = $4,
              free_text = $5,
              mood_focus = $6,
              confidence = $7,
              summary_text = $8,
              next_action_text = $9,
              risk_hint = $10,
              is_minimum_completed = $11,
              quality_score = $12,
              archive_status = 'active',
              archived_at = NULL,
              deleted_at = NULL,
              deleted_by = NULL,
              purge_after = NULL,
              updated_by = $13,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [
        noteId,
        restoredPayload.key_points,
        restoredPayload.action_items,
        restoredPayload.questions,
        restoredPayload.free_text,
        restoredPayload.mood_focus,
        restoredPayload.confidence,
        restoredPayload.summary_text,
        restoredPayload.next_action_text,
        restoredPayload.risk_hint,
        minimumDone,
        quality,
        user,
      ]
    );

    const row = up.rows?.[0] || null;
    if (row) {
      await createRevisionSnapshot(client, Number(row.id), user, 'restore');
      await logActivity(client, 'class_note', Number(row.id), 'REVISION_RESTORE', user, { revision_id: revisionId });
    }

    await client.query('COMMIT');
    sendJson(res, 200, { ok: true, note: row, restored_from: revisionId });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;
  const user = normalizeUserId(v.user || '');
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  await ensureClassNotesSchema();
  const { url, mode } = parsePathMode(req);

  if (req.method === 'GET' && mode === 'session') {
    const date = String(url.searchParams.get('date') || localDateText()).trim().slice(0, 10);
    const dayId = toDayId(date);
    const client = await pool.connect();
    try {
      await autoArchiveForOwners(client, [user]);
      const rows = await client.query(
        `SELECT
          s.id AS schedule_id,
          s.day_id,
          s.subject,
          s.room,
          s.lecturer,
          s.time_start,
          s.time_end,
          n.id AS note_id,
          COALESCE(n.is_minimum_completed, FALSE) AS is_minimum_completed,
          COALESCE(n.archive_status, 'active') AS archive_status,
          COALESCE(n.pinned, FALSE) AS pinned,
          COALESCE(n.quality_score, 0) AS quality_score,
          n.updated_at,
          n.summary_text,
          n.next_action_text
         FROM schedule s
         LEFT JOIN class_notes n
           ON n.user_id = $1
          AND n.schedule_id = s.id
          AND n.class_date = $2::date
          AND n.archive_status <> 'trashed'
        WHERE s.day_id = $3
        ORDER BY s.time_start ASC`,
        [user, date, dayId]
      );
      sendJson(res, 200, { date, day_id: dayId, sessions: rows.rows }, 10);
      return;
    } finally {
      client.release();
    }
  }

  if (req.method === 'GET' && mode === 'semester') {
    await handleSemesterGet(req, res, user, url);
    return;
  }

  if (req.method === 'GET' && mode === 'vault') {
    await handleVaultGet(req, res, user, url);
    return;
  }

  if (req.method === 'GET' && mode === 'vault/insight') {
    await handleVaultInsightGet(req, res, user, url);
    return;
  }

  if (req.method === 'POST' && mode === 'vault/action') {
    await handleVaultActionPost(req, res, user);
    return;
  }

  if (req.method === 'GET' && mode === 'revisions') {
    await handleRevisionsGet(req, res, user, url);
    return;
  }

  if (req.method === 'POST' && mode === 'revisions/restore') {
    await handleRevisionsRestorePost(req, res, user);
    return;
  }

  if (req.method === 'GET' && !mode) {
    const withPartner = parseBool(url.searchParams.get('with_partner'));
    const owner = normalizeUserId(url.searchParams.get('owner') || '');
    const includeSemester = parseBool(url.searchParams.get('include_semester'));
    const semesterKey = normalizeText(url.searchParams.get('semester_key') || '', 40);
    const naturalEnabled = parseBool(url.searchParams.get('natural'));
    const visibility = await resolveVisibilityClause({
      requestUser: user,
      ownerParam: owner,
      withPartner,
      alias: 'n',
    });
    if (visibility.blocked) {
      sendJson(res, 200, []);
      return;
    }

    const rawFilters = {
      archive_status: normalizeArchiveStatus(url.searchParams.get('archive_status'), true),
      q: normalizeText(url.searchParams.get('q') || '', 220),
      date: String(url.searchParams.get('date') || '').trim().slice(0, 10),
      schedule_id: toInt(url.searchParams.get('schedule_id'), 0, 0),
      subject: normalizeText(url.searchParams.get('subject') || '', 120),
      from: String(url.searchParams.get('from') || '').trim().slice(0, 10),
      to: String(url.searchParams.get('to') || '').trim().slice(0, 10),
      semester_key: semesterKey,
    };
    const naturalParsed = naturalEnabled ? parseNaturalQuery(rawFilters.q, new Date()) : null;
    const filters = applyNaturalToFilters(rawFilters, naturalParsed);
    if (naturalParsed?.requireQuestions) filters.requireQuestions = true;

    const client = await pool.connect();
    try {
      const pref = await getAcademicSemesterPreference(client, user);
      const semester = filters.semester_key
        ? parseSemesterKey(filters.semester_key, Number(pref.academic_year_start_month || 8))
        : null;
      if (filters.semester_key && !semester) {
        res.status(400).json({ error: 'semester_key tidak valid' });
        return;
      }
      if (semester) {
        filters.semester_from = semester.from;
        filters.semester_to = semester.to;
      }
      await autoArchiveForOwners(client, visibility.owners);
      const built = buildNoteWhereClause(visibility, filters);
      const result = await client.query(
        `SELECT n.*,
                (n.user_id = $${built.params.length + 1}) AS is_owner,
                $${built.params.length + 2}::text AS viewer_user
           FROM class_notes n
          WHERE ${built.where.join(' AND ')}
          ORDER BY n.class_date DESC, n.time_start ASC, n.updated_at DESC`,
        [...built.params, user, user]
      );
      const rows = result.rows || [];
      const withSemester = includeSemester || Boolean(filters.semester_key);
      const out = withSemester
        ? rows.map((row) => {
            const meta = buildSemesterMeta(row.class_date, Number(pref.academic_year_start_month || 8));
            return {
              ...row,
              semester_key: meta?.semester_key || '',
              semester_label: meta?.semester_label || '',
            };
          })
        : rows;
      sendJson(res, 200, out, 10);
      return;
    } finally {
      client.release();
    }
  }

  if ((req.method === 'POST' || req.method === 'PUT') && !mode) {
    const body = req.body || await readBody(req);
    const id = Number(body.id || 0);
    let scheduleId = Number(body.schedule_id || 0);
    let classDate = String(body.class_date || localDateText()).trim();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (id > 0 && (!scheduleId || !classDate)) {
        const current = await client.query(
          `SELECT schedule_id, class_date
             FROM class_notes
            WHERE id = $1 AND user_id = $2`,
          [id, user]
        );
        if (current.rowCount > 0) {
          scheduleId = scheduleId || Number(current.rows[0].schedule_id || 0);
          classDate = classDate || String(current.rows[0].class_date || '').slice(0, 10);
        }
      }

      if (!scheduleId) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'schedule_id wajib diisi' });
        return;
      }

      const session = await getScheduleSession(client, scheduleId);
      if (!session) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Sesi jadwal tidak ditemukan' });
        return;
      }

      const payload = {
        key_points: normalizeText(body.key_points, 6000),
        action_items: normalizeText(body.action_items, 6000),
        questions: normalizeText(body.questions, 6000),
        free_text: normalizeText(body.free_text, 9000),
        mood_focus: normalizeMoodFocus(body.mood_focus),
        confidence: normalizeConfidence(body.confidence),
        subject: normalizeText(body.subject || session.subject, 140) || String(session.subject || 'Kelas'),
      };
      const minimumDone = isMinimumCompleted(payload);
      const smart = await buildSmartLayer(client, user, payload);
      const qualityScore = computeQualityScore({ ...payload, ...smart });

      const upsert = await client.query(
        `INSERT INTO class_notes (
            user_id, schedule_id, class_date, day_id, subject, room, lecturer, time_start, time_end,
            key_points, action_items, questions, free_text, mood_focus, confidence,
            summary_text, next_action_text, risk_hint, is_minimum_completed, quality_score,
            archive_status, archived_at, deleted_at, deleted_by, purge_after, updated_by, updated_at
         )
         VALUES (
            $1, $2, $3::date, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15,
            $16, $17, $18, $19, $20,
            'active', NULL, NULL, NULL, NULL, $21, NOW()
         )
         ON CONFLICT (user_id, schedule_id, class_date)
         DO UPDATE SET
           day_id = EXCLUDED.day_id,
           subject = EXCLUDED.subject,
           room = EXCLUDED.room,
           lecturer = EXCLUDED.lecturer,
           time_start = EXCLUDED.time_start,
           time_end = EXCLUDED.time_end,
           key_points = EXCLUDED.key_points,
           action_items = EXCLUDED.action_items,
           questions = EXCLUDED.questions,
           free_text = EXCLUDED.free_text,
           mood_focus = EXCLUDED.mood_focus,
           confidence = EXCLUDED.confidence,
           summary_text = EXCLUDED.summary_text,
           next_action_text = EXCLUDED.next_action_text,
           risk_hint = EXCLUDED.risk_hint,
           is_minimum_completed = EXCLUDED.is_minimum_completed,
           quality_score = EXCLUDED.quality_score,
           archive_status = 'active',
           archived_at = NULL,
           deleted_at = NULL,
           deleted_by = NULL,
           purge_after = NULL,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()
         RETURNING *`,
        [
          user,
          scheduleId,
          classDate,
          Number(session.day_id || null),
          payload.subject,
          normalizeText(session.room, 80) || null,
          normalizeText(session.lecturer, 140) || null,
          session.time_start || null,
          session.time_end || null,
          payload.key_points,
          payload.action_items,
          payload.questions,
          payload.free_text,
          payload.mood_focus,
          payload.confidence,
          smart.summary_text,
          smart.next_action_text,
          smart.risk_hint,
          minimumDone,
          qualityScore,
          user,
        ]
      );

      const row = upsert.rows?.[0];
      if (row?.id) {
        await createRevisionSnapshot(client, Number(row.id), user, 'save');
      }
      await logActivity(client, 'class_note', Number(row?.id || 0), req.method === 'POST' ? 'UPSERT' : 'UPDATE', user, {
        schedule_id: scheduleId,
        class_date: classDate,
        is_minimum_completed: minimumDone,
        quality_score: qualityScore,
      });
      await autoArchiveForOwners(client, [user]);
      const latest = row?.id ? await readSingleNote(client, Number(row.id)) : row;
      await client.query('COMMIT');
      sendJson(res, 200, latest || row);
      return;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  if (mode.startsWith('vault') || mode.startsWith('revisions')) {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
});
