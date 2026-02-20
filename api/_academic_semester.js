import { pool } from './_lib.js';

const DEFAULT_ACADEMIC_START_MONTH = 8;

function localDateText(baseDate = new Date()) {
  const d = new Date(baseDate);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toInt(value, fallback = 0, min = null, max = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  let out = Math.trunc(n);
  if (Number.isFinite(min)) out = Math.max(Number(min), out);
  if (Number.isFinite(max)) out = Math.min(Number(max), out);
  return out;
}

function normalizeUserId(value = '') {
  const t = String(value || '').trim();
  if (!t) return '';
  if (/^zaldy$/i.test(t)) return 'Zaldy';
  if (/^nesya$/i.test(t)) return 'Nesya';
  return t.slice(0, 60);
}

export function normalizeAcademicStartMonth(value) {
  return toInt(value, DEFAULT_ACADEMIC_START_MONTH, 1, 12);
}

function dateParts(dateText = '') {
  const dt = String(dateText || '').slice(0, 10);
  const m = dt.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function pad2(value) {
  return String(Math.trunc(Number(value) || 0)).padStart(2, '0');
}

function monthSpan(startYear, startMonth, offset) {
  const base = new Date(Date.UTC(startYear, startMonth - 1, 1));
  base.setUTCMonth(base.getUTCMonth() + Number(offset || 0));
  return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1 };
}

export function buildSemesterMeta(classDate = '', startMonth = DEFAULT_ACADEMIC_START_MONTH) {
  const parts = dateParts(classDate);
  if (!parts) return null;
  const normalizedStart = normalizeAcademicStartMonth(startMonth);
  const academicStartYear = parts.month >= normalizedStart ? parts.year : (parts.year - 1);
  const academicEndYear = academicStartYear + 1;

  const semStartA = monthSpan(academicStartYear, normalizedStart, 0);
  const semStartB = monthSpan(academicStartYear, normalizedStart, 6);
  const semEndA = monthSpan(academicStartYear, normalizedStart, 5);
  const semEndB = monthSpan(academicStartYear, normalizedStart, 11);

  const inFirstHalf = (() => {
    const dKey = `${parts.year}${pad2(parts.month)}`;
    const aStartKey = `${semStartA.year}${pad2(semStartA.month)}`;
    const aEndKey = `${semEndA.year}${pad2(semEndA.month)}`;
    return dKey >= aStartKey && dKey <= aEndKey;
  })();

  const term = inFirstHalf ? 'ganjil' : 'genap';
  const termLabel = inFirstHalf ? 'Ganjil' : 'Genap';
  const from = inFirstHalf
    ? `${semStartA.year}-${pad2(semStartA.month)}-01`
    : `${semStartB.year}-${pad2(semStartB.month)}-01`;
  const toMonth = inFirstHalf ? semEndA : semEndB;
  const toLastDate = new Date(Date.UTC(toMonth.year, toMonth.month, 0));
  const to = `${toMonth.year}-${pad2(toMonth.month)}-${pad2(toLastDate.getUTCDate())}`;

  return {
    academic_year_start_month: normalizedStart,
    academic_start_year: academicStartYear,
    academic_end_year: academicEndYear,
    term,
    semester_key: `${academicStartYear}-${academicEndYear}-${term}`,
    semester_label: `${academicStartYear}/${academicEndYear} ${termLabel}`,
    from,
    to,
  };
}

export function parseSemesterKey(semesterKey = '', startMonth = DEFAULT_ACADEMIC_START_MONTH) {
  const key = String(semesterKey || '').trim().toLowerCase();
  const m = key.match(/^(\d{4})-(\d{4})-(ganjil|genap)$/);
  if (!m) return null;
  const startYear = Number(m[1]);
  const endYear = Number(m[2]);
  const term = String(m[3] || '');
  if (startYear < 2000 || endYear !== startYear + 1) return null;
  const normalizedStart = normalizeAcademicStartMonth(startMonth);

  const startA = monthSpan(startYear, normalizedStart, 0);
  const endA = monthSpan(startYear, normalizedStart, 5);
  const startB = monthSpan(startYear, normalizedStart, 6);
  const endB = monthSpan(startYear, normalizedStart, 11);

  const fromMonth = term === 'ganjil' ? startA : startB;
  const toMonth = term === 'ganjil' ? endA : endB;
  const toLastDate = new Date(Date.UTC(toMonth.year, toMonth.month, 0));

  return {
    semester_key: `${startYear}-${endYear}-${term}`,
    semester_label: `${startYear}/${endYear} ${term === 'ganjil' ? 'Ganjil' : 'Genap'}`,
    from: `${fromMonth.year}-${pad2(fromMonth.month)}-01`,
    to: `${toMonth.year}-${pad2(toMonth.month)}-${pad2(toLastDate.getUTCDate())}`,
    academic_year_start_month: normalizedStart,
  };
}

export async function ensureAcademicSemesterPreferenceSchema(client = null) {
  if (global._academicSemesterPreferenceSchemaReady) return;
  const run = (sql, params = []) => (client ? client.query(sql, params) : pool.query(sql, params));
  await run(`
    CREATE TABLE IF NOT EXISTS academic_semester_preferences (
      user_id VARCHAR(60) PRIMARY KEY,
      academic_year_start_month SMALLINT NOT NULL DEFAULT 8,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await run(`
    CREATE INDEX IF NOT EXISTS idx_academic_semester_preferences_updated_at
      ON academic_semester_preferences(updated_at DESC)
  `);
  global._academicSemesterPreferenceSchemaReady = true;
}

export async function getAcademicSemesterPreference(client, userId = '') {
  const user = normalizeUserId(userId);
  if (!user) {
    return {
      user_id: '',
      academic_year_start_month: DEFAULT_ACADEMIC_START_MONTH,
      defaulted: true,
      current_semester_key: '',
      current_semester_label: '',
    };
  }
  await ensureAcademicSemesterPreferenceSchema(client);
  const res = await client.query(
    `SELECT user_id, academic_year_start_month, updated_at
       FROM academic_semester_preferences
      WHERE user_id = $1`,
    [user]
  );

  const configured = res.rows?.[0] || null;
  const startMonth = normalizeAcademicStartMonth(configured?.academic_year_start_month);
  const current = buildSemesterMeta(localDateText(), startMonth);
  return {
    user_id: user,
    academic_year_start_month: startMonth,
    defaulted: !configured,
    updated_at: configured?.updated_at || null,
    current_semester_key: current?.semester_key || '',
    current_semester_label: current?.semester_label || '',
  };
}

