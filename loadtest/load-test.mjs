#!/usr/bin/env node
// Backend concurrency test for the People Bingo Supabase RPC workflow.
// Run against a fresh, disposable room only; this creates participant and submission rows.
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const arg = (name, fallback) => {
  const found = process.argv.find(v => v.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : fallback;
};
const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const roomCode = (process.env.BINGO_ROOM_CODE || 'LOAD26').toUpperCase();
const count = Number(arg('--count', process.env.LOAD_TEST_COUNT || '200'));
const prefix = `LT${Date.now().toString(36).toUpperCase()}`;

if (!supabaseUrl || !anonKey) {
  console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY in your environment first.');
  process.exit(2);
}
if (!Number.isInteger(count) || count < 1 || count > 200) {
  console.error('--count must be an integer between 1 and 200.');
  process.exit(2);
}

const baseUrl = supabaseUrl.replace(/\/$/, '');
const measurements = { join: [], square: [], submit: [] };
const errors = [];

async function rpc(name, payload) {
  const start = performance.now();
  const response = await fetch(`${baseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45000)
  });
  const elapsed = performance.now() - start;
  const bodyText = await response.text();
  let data;
  try { data = bodyText ? JSON.parse(bodyText) : null; } catch { data = bodyText; }
  if (!response.ok) {
    const detail = typeof data === 'string' ? data : (data?.message || data?.hint || JSON.stringify(data));
    throw new Error(`${name} returned HTTP ${response.status}: ${detail}`);
  }
  return { data, elapsed };
}

async function simulateParticipant(index) {
  const participantName = `${prefix}-${String(index + 1).padStart(3, '0')}`;
  const token = randomUUID();
  try {
    const join = await rpc('join_bingo_room', {
      p_room_code: roomCode,
      p_participant_name: participantName,
      p_session_token: token
    });
    measurements.join.push(join.elapsed);

    // Complete the first horizontal row with four different synthetic colleagues.
    for (let square = 0; square < 4; square++) {
      const mark = await rpc('set_bingo_square', {
        p_session_token: token,
        p_square_index: square,
        p_colleague_name: `${prefix}-Person-${index + 1}-${square + 1}`
      });
      measurements.square.push(mark.elapsed);
    }

    const submit = await rpc('submit_bingo_card', { p_session_token: token });
    measurements.submit.push(submit.elapsed);
    return { ok: true, participantName };
  } catch (error) {
    errors.push({ participantName, error: error.message });
    return { ok: false, participantName, error: error.message };
  }
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}
function report(label, values) {
  if (!values.length) return `${label}: no successful requests`;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return `${label}: n=${values.length}, avg=${avg.toFixed(0)}ms, p50=${percentile(values, .5).toFixed(0)}ms, p95=${percentile(values, .95).toFixed(0)}ms, max=${Math.max(...values).toFixed(0)}ms`;
}

console.log(`People Bingo load test: ${count} concurrent simulated attendees`);
console.log(`Room: ${roomCode}. Test prefix: ${prefix}`);
console.log('Starting participant joins, four square updates per participant, and one Bingo submission each…');
const started = performance.now();
const results = await Promise.all(Array.from({ length: count }, (_, i) => simulateParticipant(i)));
const duration = (performance.now() - started) / 1000;
const successes = results.filter(r => r.ok).length;
console.log('\nResults');
console.log(`Participants successful: ${successes}/${count}`);
console.log(`Elapsed: ${duration.toFixed(1)}s`);
console.log(report('Join RPC', measurements.join));
console.log(report('Square RPC', measurements.square));
console.log(report('Submit RPC', measurements.submit));

if (count === 200 && successes === 200) {
  try {
    await rpc('join_bingo_room', {
      p_room_code: roomCode,
      p_participant_name: `${prefix}-OVER-CAP`,
      p_session_token: randomUUID()
    });
    console.error('CAPACITY CHECK FAILED: an additional participant was admitted after 200 registrations.');
    errors.push({ participantName: `${prefix}-OVER-CAP`, error: 'Capacity was exceeded.' });
  } catch (error) {
    if (error.message.includes('reached its participant limit')) {
      console.log('Capacity check: PASS — the 201st participant was rejected.');
    } else {
      console.error(`Capacity check inconclusive: ${error.message}`);
      errors.push({ participantName: `${prefix}-OVER-CAP`, error: error.message });
    }
  }
} else if (count === 200) {
  console.log('Capacity check skipped because all 200 simulated joins did not succeed.');
}

if (errors.length) {
  console.log(`\nErrors: ${errors.length}`);
  for (const item of errors.slice(0, 20)) console.log(`- ${item.participantName}: ${item.error}`);
  if (errors.length > 20) console.log(`…and ${errors.length - 20} more`);
}
console.log('\nThis test writes synthetic participant, card and submission rows. Delete the temporary test room after reviewing the results.');
process.exit(successes === count && errors.length === 0 ? 0 : 1);
