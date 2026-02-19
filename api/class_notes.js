import { pool, readBody, verifyToken, withErrorHandling, sendJson, logActivity } from './_lib.js';

function localDateText() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
  const isSession = pathname.endsWith('/session') || subPath === 'session' || subPath.startsWith('session?');
  return { url, isSession };
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

async function ensureClassNotesSchema() {
  if (global._classNotesSchemaReady) return;
  await pool.query(`
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, schedule_id, class_date)
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_class_notes_user_date ON class_notes(user_id, class_date DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_class_notes_schedule_date ON class_notes(schedule_id, class_date DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_class_notes_subject_date ON class_notes(subject, class_date DESC)');
  global._classNotesSchemaReady = true;
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

export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;
  const user = String(v.user || '').trim();
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  await ensureClassNotesSchema();
  const { url, isSession } = parsePathMode(req);

  if (req.method === 'GET' && isSession) {
    const date = String(url.searchParams.get('date') || localDateText()).trim();
    const dayId = toDayId(date);

    const client = await pool.connect();
    try {
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
          n.updated_at,
          n.summary_text,
          n.next_action_text
         FROM schedule s
         LEFT JOIN class_notes n
           ON n.user_id = $1
          AND n.schedule_id = s.id
          AND n.class_date = $2::date
        WHERE s.day_id = $3
        ORDER BY s.time_start ASC`,
        [user, date, dayId]
      );
      sendJson(res, 200, {
        date,
        day_id: dayId,
        sessions: rows.rows,
      }, 10);
      return;
    } finally {
      client.release();
    }
  }

  if (req.method === 'GET') {
    const date = String(url.searchParams.get('date') || '').trim();
    const scheduleId = Number(url.searchParams.get('schedule_id') || 0);
    const subject = String(url.searchParams.get('subject') || '').trim();
    const from = String(url.searchParams.get('from') || '').trim();
    const to = String(url.searchParams.get('to') || '').trim();

    const where = ['user_id = $1'];
    const params = [user];
    let i = 2;
    if (date) {
      where.push(`class_date = $${i++}::date`);
      params.push(date);
    }
    if (scheduleId > 0) {
      where.push(`schedule_id = $${i++}`);
      params.push(scheduleId);
    }
    if (subject) {
      where.push(`subject ILIKE $${i++}`);
      params.push(`%${subject}%`);
    }
    if (from) {
      where.push(`class_date >= $${i++}::date`);
      params.push(from);
    }
    if (to) {
      where.push(`class_date <= $${i++}::date`);
      params.push(to);
    }

    const result = await pool.query(
      `SELECT *
         FROM class_notes
        WHERE ${where.join(' AND ')}
        ORDER BY class_date DESC, time_start ASC, updated_at DESC`,
      params
    );
    sendJson(res, 200, result.rows, 10);
    return;
  }

  if (req.method === 'POST' || req.method === 'PUT') {
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

      const upsert = await client.query(
        `INSERT INTO class_notes (
            user_id, schedule_id, class_date, day_id, subject, room, lecturer, time_start, time_end,
            key_points, action_items, questions, free_text, mood_focus, confidence,
            summary_text, next_action_text, risk_hint, is_minimum_completed, updated_at
         )
         VALUES (
            $1, $2, $3::date, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15,
            $16, $17, $18, $19, NOW()
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
        ]
      );

      const row = upsert.rows?.[0];
      await logActivity(client, 'class_note', Number(row?.id || 0), req.method === 'POST' ? 'UPSERT' : 'UPDATE', user, {
        schedule_id: scheduleId,
        class_date: classDate,
        is_minimum_completed: minimumDone,
      });
      await client.query('COMMIT');
      sendJson(res, 200, row);
      return;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
});
