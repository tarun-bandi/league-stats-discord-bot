import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import worker from '../src/index.js';
import { lpSeries, lpGraphCommand, responseBody, GRAPH_QUEUES } from '../src/lp-graph.js';
import { renderLpChart, axisRank } from '../src/lp-chart.js';
import { testDb, stateFixture, envFixture, interaction } from './helpers/db.js';
import { writeRecord } from '../src/store.js';

const end = Date.parse('2026-09-07T16:00:00Z'), HOUR = 3600_000, start = end - 24 * HOUR;
const rank = (lp, extra = {}) => ({ tier: 'GOLD', rank: 'II', leaguePoints: lp, wins: 10, losses: 5, ...extra });
const point = (at, lp = 30, extra = {}) => ({ at: new Date(at).toISOString(), entries: { [GRAPH_QUEUES.solo]: rank(lp, extra), [GRAPH_QUEUES.flex]: rank(70 - lp) } });
const fixture = () => ({ ...stateFixture(), rank_history: Array.from({ length: 25 }, (_, i) => point(start + i * HOUR, 20 + i)) });

async function signedRun(command, env) {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex');
  const body = JSON.stringify(command), timestamp = String(Math.floor(Date.now() / 1000));
  const signature = Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(timestamp + body))).toString('hex');
  const pending = [];
  const response = await worker.fetch(new Request('https://worker.test/', { method: 'POST', body, headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp } }), { ...env, DISCORD_PUBLIC_KEY: publicKey }, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending); return response.json();
}

test('rank progress is chronological, queue-specific and includes promotions and apex LP', () => {
  const state = fixture(); state.rank_history.reverse();
  const series = lpSeries(state, GRAPH_QUEUES.solo, start, end);
  assert.equal(series.points.length, 25); assert.equal(series.delta, 24); assert.equal(series.partial, false);
  assert.equal(lpSeries(state, GRAPH_QUEUES.flex, start, end).delta, -24);
  state.rank_history = [point(start, 90), point(start + HOUR, 15, { rank: 'I' })];
  assert.equal(lpSeries(state, GRAPH_QUEUES.solo, start, end).delta, 25);
  state.rank_history = [point(start, 400, { tier: 'MASTER' }), point(start + HOUR, 450, { tier: 'GRANDMASTER' })];
  const apex = lpSeries(state, GRAPH_QUEUES.solo, start, end);
  assert.equal(apex.delta, 50); assert.equal(apex.peak.rank.tier, 'GRANDMASTER');
  assert.equal(axisRank(2850), 'MASTER+ 50');
});

test('gaps, resets, unranked observations and resumed tracking break lines and suppress net change', () => {
  const cases = [
    { rank_history: [point(start), point(start + 3 * HOUR)] },
    { rank_history: [point(start), point(start + HOUR, 40, { wins: 0 })] },
    { rank_history: [point(start), { at: new Date(start + HOUR).toISOString(), entries: {} }, point(start + 2 * HOUR)] },
    { rank_history: [point(start), point(start + HOUR)], monitor_started_at: new Date(start + HOUR / 2).toISOString() },
    { rank_history: [point(start), point(start + HOUR)], baseline_history: [{ at: new Date(start + HOUR / 2).toISOString() }] },
  ];
  for (const state of cases) {
    const series = lpSeries(state, GRAPH_QUEUES.solo, start, end);
    assert.equal(series.segments.length, 2); assert.equal(series.delta, null); assert.equal(series.partial, true);
  }
});

test('exact date bounds, invalid data and duplicates never create fake zero LP', () => {
  const state = { rank_history: [point(start - 1), point(start), point(start), point(end), point(end + 1), { at: 'bad', entries: {} }] };
  const series = lpSeries(state, GRAPH_QUEUES.solo, start, end);
  assert.equal(series.points.length, 2);
  const empty = lpSeries({ rank_history: [point(start, -1)] }, GRAPH_QUEUES.solo, start, end);
  assert.equal(empty.points.length, 0); assert.equal(empty.delta, null);
  const one = lpSeries({ rank_history: [point(start)] }, GRAPH_QUEUES.solo, start, end);
  assert.equal(one.points.length, 1); assert.equal(one.delta, null);
});

test('renderer produces valid compressed indexed PNG and visible plotted pixels', async () => {
  const series = lpSeries(fixture(), GRAPH_QUEUES.solo, start, end);
  const png = Buffer.from(await renderLpChart(series, start, end, 'Solo/Duo'));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = []; let offset = 8;
  while (offset < png.length) {
    const size = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + size);
    if (type === 'IHDR') { assert.equal(data.readUInt32BE(0), 960); assert.equal(data.readUInt32BE(4), 420); assert.equal(data[9], 3); }
    if (type === 'IDAT') chunks.push(data);
    offset += 12 + size;
  }
  const pixels = inflateSync(Buffer.concat(chunks));
  assert.equal(pixels.length, (960 + 1) * 420);
  assert.ok(pixels.includes(4));
  assert.ok(png.length < 100000);
});

test('graph reads stored data without external calls, retains state and builds two images', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw Error('No external history requests'); });
  const state = fixture(), db = testDb(state), env = envFixture(db);
  const payload = await lpGraphCommand(interaction('lpgraph', { summoner: 'Test#NA1', days: 1 }), env, end);
  assert.equal(payload.files.length, 2); assert.equal(payload.embeds.length, 2);
  assert.match(payload.embeds[0].description, /\+24/); assert.match(payload.embeds[1].description, /-24/);
  assert.match(payload.embeds[0].description, /Highest observed/);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.equal(db.sqlite.prepare('SELECT state_json FROM monitor_state').get().state_json, JSON.stringify(state));
  const solo = await lpGraphCommand(interaction('lpgraph', { summoner: 'test#na1', days: 1, queue: 'solo' }), env, end);
  assert.equal(solo.files.length, 1);
});

test('missing history stays unavailable; guild, account and options are validated', async () => {
  const env = envFixture(testDb(stateFixture()));
  const payload = await lpGraphCommand(interaction('lpgraph', { summoner: 'Test#NA1' }), env, end);
  assert.equal(payload.files.length, 0); assert.match(payload.embeds[0].description, /No saved/);
  await assert.rejects(lpGraphCommand(interaction('lpgraph', { summoner: 'Nope#NA1' }), env, end), /No saved rank history/);
  await assert.rejects(lpGraphCommand(interaction('lpgraph', { summoner: 'Test#NA1' }, { guild_id: 'other' }), env, end), /configured tracking server/);
  for (const options of [{ days: 31 }, { days: 1.5 }, { queue: 'aram' }]) await assert.rejects(lpGraphCommand(interaction('lpgraph', { summoner: 'Test#NA1', ...options }), env, end), /Choose/);
});

test('multipart attachment IDs and image URLs match; plain messages remain JSON', async () => {
  const payload = await lpGraphCommand(interaction('lpgraph', { summoner: 'Test#NA1', days: 1 }), envFixture(testDb(fixture())), end);
  const result = responseBody(payload), data = JSON.parse(result.body.get('payload_json'));
  assert.equal(result.headers, undefined); assert.equal(data.files, undefined);
  for (let id = 0; id < 2; id++) {
    const file = result.body.get(`files[${id}]`);
    assert.equal(file.type, 'image/png'); assert.equal(file.name, data.attachments[id].filename);
    assert.equal(data.embeds[id].image.url, `attachment://${file.name}`);
  }
  assert.deepEqual(JSON.parse(responseBody({ content: 'hello', files: [] }).body), { content: 'hello' });
});

test('signed graph command honors profile privacy and sends multipart only to Discord', async (t) => {
  const state = fixture(); state.rank_history = state.rank_history.map((p) => ({ ...p, at: new Date(Date.parse(p.at) + Date.now() - end).toISOString() }));
  const db = testDb(state), env = envFixture(db), bodies = [];
  await writeRecord(db, 'profile:456:111', { summoner: 'Test#NA1', private: true, region: 'euw', mode: 450 });
  t.mock.method(globalThis, 'fetch', async (url, init) => { assert.match(url, /discord.com\/api\/v10\/webhooks/); bodies.push(init.body); return Response.json({ id: '999' }); });
  const response = await signedRun(interaction('lpgraph', { days: 1 }), env);
  assert.equal(response.type, 5); assert.equal(response.data.flags, 64);
  assert.ok(bodies[0] instanceof FormData);
  const publicResponse = await signedRun(interaction('lpgraph', { private: false, queue: 'solo' }), env);
  assert.equal(publicResponse.data.flags, undefined);
  const unauthorized = await worker.fetch(new Request('https://worker.test/', { method: 'POST', body: '{}' }), env, {});
  assert.equal(unauthorized.status, 401);
});
