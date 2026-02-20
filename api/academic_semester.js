import { pool, readBody, verifyToken, withErrorHandling, sendJson } from './_lib.js';
import {
  buildSemesterMeta,
  ensureAcademicSemesterPreferenceSchema,
  getAcademicSemesterPreference,
  normalizeAcademicStartMonth,
} from './_academic_semester.js';

function normalizeUserId(value = '') {
  const t = String(value || '').trim();
  if (!t) return '';
  if (/^zaldy$/i.test(t)) return 'Zaldy';
  if (/^nesya$/i.test(t)) return 'Nesya';
  return t.slice(0, 60);
}

function monthLabel(monthNum = 8) {
  const names = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const idx = Math.max(1, Math.min(12, Number(monthNum || 8))) - 1;
  return names[idx] || names[7];
}

export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;
  const user = normalizeUserId(v.user || '');
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (req.method === 'GET') {
    const client = await pool.connect();
    try {
      await ensureAcademicSemesterPreferenceSchema(client);
      const pref = await getAcademicSemesterPreference(client, user);
      sendJson(res, 200, {
        ...pref,
        start_month_label: monthLabel(pref.academic_year_start_month),
      }, 30);
      return;
    } finally {
      client.release();
    }
  }

  if (req.method === 'PUT') {
    const body = req.body || await readBody(req);
    const rawMonth = Number(body.academic_year_start_month);
    if (!Number.isFinite(rawMonth) || rawMonth < 1 || rawMonth > 12) {
      res.status(400).json({ error: 'academic_year_start_month harus 1-12' });
      return;
    }
    const month = normalizeAcademicStartMonth(rawMonth);

    const client = await pool.connect();
    try {
      await ensureAcademicSemesterPreferenceSchema(client);
      await client.query(
        `INSERT INTO academic_semester_preferences (user_id, academic_year_start_month, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id)
         DO UPDATE SET
           academic_year_start_month = EXCLUDED.academic_year_start_month,
           updated_at = NOW()`,
        [user, month]
      );
      const pref = await getAcademicSemesterPreference(client, user);
      const current = buildSemesterMeta(new Date().toISOString().slice(0, 10), pref.academic_year_start_month);
      sendJson(res, 200, {
        ...pref,
        current_semester_key: current?.semester_key || pref.current_semester_key || '',
        current_semester_label: current?.semester_label || pref.current_semester_label || '',
        start_month_label: monthLabel(pref.academic_year_start_month),
      });
      return;
    } finally {
      client.release();
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
});

