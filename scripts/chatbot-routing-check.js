const BASE_URL = String(process.env.CHATBOT_TEST_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const API_PATH = String(process.env.CHATBOT_TEST_PATH || '/api/chat');
const STRICT_HYBRID = String(process.env.CHATBOT_TEST_STRICT_HYBRID || 'true').toLowerCase() !== 'false';
const REQUEST_TIMEOUT_MS = Math.max(1000, Math.min(15000, Number(process.env.CHATBOT_TEST_TIMEOUT_MS || 7000)));

const CASES = [
  { name: 'Greeting Basic', message: 'halo', lane: 'simple' },
  { name: 'Target Daily', message: 'cek target harian pasangan', lane: 'simple' },
  { name: 'Reminder Focus', message: 'ingatkan aku fokus 25 menit', lane: 'simple' },
  { name: 'Evaluation Short', message: 'evaluasi hari ini', lane: 'simple' },
  { name: 'Recommend Priority', message: 'rekomendasi tugas kuliah paling prioritas', lane: 'simple' },
  { name: 'Check-in Progress', message: 'check-in progres tugas hari ini', lane: 'simple' },
  { name: 'Affirmation Flow', message: 'oke lanjut', lane: 'simple' },
  { name: 'Study Schedule Prompt', message: 'jadwal belajar besok pagi 120 menit', lane: 'simple' },

  { name: 'Complex Multi-step 1', message: 'tolong analisis prioritas tugas kuliah minggu ini lalu bandingkan dengan assignment yang deadlinenya dekat dan kasih strategi detail besok pagi', lane: 'complex' },
  { name: 'Complex Multi-action 2', message: 'buat task review basis data deadline besok 19:00 dan buat assignment ringkasan ai deadline besok 21:00 lalu jelaskan urutan eksekusinya', lane: 'complex' },
  { name: 'Complex Reasoning 3', message: 'kenapa performa belajar gue drop minggu ini, bandingkan dengan pola reminder, lalu rekomendasikan perubahan strategi yang realistis', lane: 'complex' },
  { name: 'Complex Ambiguous 4', message: 'yang tadi tolong lanjutkan sekalian prioritasin dan jelasin kenapanya biar gak salah langkah', lane: 'complex' },
  { name: 'Complex Comparative 5', message: 'bandingkan fokus pagi vs malam dari data konteksku, terus kasih plan 3 langkah yang paling aman untuk deadline 48 jam', lane: 'complex' },
  { name: 'Complex Couple 6', message: 'analisis pembagian beban antara aku dan pasangan minggu ini, identifikasi risiko miss deadline, lalu rekomendasikan check-in otomatis', lane: 'complex' },
];

function color(text, code) {
  return `\u001b[${code}m${text}\u001b[0m`;
}

function ok(text) {
  return color(text, '32');
}

function warn(text) {
  return color(text, '33');
}

function fail(text) {
  return color(text, '31');
}

function formatMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '-';
  return `${Math.round(n)}ms`;
}

function shouldPassLane(caseDef, payload) {
  const router = payload?.router && typeof payload.router === 'object' ? payload.router : {};
  const mode = String(router.mode || '').toLowerCase();
  const selected = String(router.selected_engine || '').toLowerCase();

  if (!STRICT_HYBRID) return { pass: true, note: 'strict_hybrid=off' };
  if (mode !== 'hybrid') return { pass: true, note: `router_mode=${mode || 'unknown'}` };

  if (caseDef.lane === 'simple') {
    const passLane = selected === 'rule' || selected === 'rule-fallback';
    return { pass: passLane, note: `selected=${selected}` };
  }

  const passLane = selected === 'python' || selected === 'llm';
  return { pass: passLane, note: `selected=${selected}` };
}

async function callChat(message) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(`${BASE_URL}${API_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'bot',
        stateless: true,
        message,
      }),
      signal: controller.signal,
    });
    const json = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      status: response.status,
      body: json,
      latencyMs: Date.now() - started,
      error: '',
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: {},
      latencyMs: Date.now() - started,
      error: String(err?.message || 'request_failed'),
    };
  } finally {
    clearTimeout(timer);
  }
}

function basicPayloadValid(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (!String(payload.reply || '').trim()) return false;
  if (!String(payload.engine || '').trim()) return false;
  if (!payload.router || typeof payload.router !== 'object') return false;
  return true;
}

async function main() {
  console.log(`Routing check -> ${BASE_URL}${API_PATH}`);
  console.log(`Cases: ${CASES.length} | strict_hybrid=${STRICT_HYBRID}`);
  console.log('');

  let passed = 0;
  let failed = 0;
  let warned = 0;
  const startedAll = Date.now();

  for (let i = 0; i < CASES.length; i += 1) {
    const tc = CASES[i];
    const res = await callChat(tc.message);

    if (!res.ok) {
      failed += 1;
      console.log(fail(`[${i + 1}/${CASES.length}] FAIL ${tc.name}`));
      console.log(`  status=${res.status} latency=${formatMs(res.latencyMs)} error=${res.error || '-'}`);
      continue;
    }

    const payload = res.body;
    if (!basicPayloadValid(payload)) {
      failed += 1;
      console.log(fail(`[${i + 1}/${CASES.length}] FAIL ${tc.name}`));
      console.log(`  invalid payload shape | status=${res.status} latency=${formatMs(res.latencyMs)}`);
      continue;
    }

    const laneResult = shouldPassLane(tc, payload);
    const engine = String(payload.engine || '');
    const router = payload.router || {};
    const selected = String(router.selected_engine || '-');
    const mode = String(router.mode || '-');
    const complexity = Number(router.complexity_score);

    if (!laneResult.pass) {
      failed += 1;
      console.log(fail(`[${i + 1}/${CASES.length}] FAIL ${tc.name}`));
      console.log(`  lane=${tc.lane} mode=${mode} selected=${selected} engine=${engine} complexity=${Number.isFinite(complexity) ? complexity : '-'} latency=${formatMs(res.latencyMs)}`);
      continue;
    }

    if (laneResult.note.startsWith('router_mode=')) {
      warned += 1;
      console.log(warn(`[${i + 1}/${CASES.length}] WARN ${tc.name}`));
      console.log(`  ${laneResult.note} engine=${engine} latency=${formatMs(res.latencyMs)}`);
      continue;
    }

    passed += 1;
    console.log(ok(`[${i + 1}/${CASES.length}] PASS ${tc.name}`));
    console.log(`  lane=${tc.lane} mode=${mode} selected=${selected} engine=${engine} complexity=${Number.isFinite(complexity) ? complexity : '-'} latency=${formatMs(res.latencyMs)}`);
  }

  const totalMs = Date.now() - startedAll;
  console.log('');
  console.log(`Summary: pass=${passed} warn=${warned} fail=${failed} total=${CASES.length} duration=${formatMs(totalMs)}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
