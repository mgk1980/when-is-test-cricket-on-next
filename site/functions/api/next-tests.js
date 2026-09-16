// Cloudflare Pages Function — runs server-side, so the API key never
// reaches the browser. Available at /api/next-tests once deployed.
//
// Requires an environment variable / secret called CRICKET_API_KEY,
// set in the Cloudflare Pages project settings (Settings > Environment
// variables). Get a free key at https://bigballsdata.com/signup

const API_BASE = 'https://api.bigballsdata.com/v1/cricket';

// --- Manual broadcaster override -------------------------------------
// There's no reliable feed for "which channel is showing this match"
// in Ireland, so this is filled in by hand. Match on a distinctive
// piece of either team's name (lowercase, partial match is fine).
// Edit this list whenever the next Test changes broadcaster.
const BROADCASTER_OVERRIDES = [
  // { teams: ['ireland'], broadcaster: 'TNT Sports' },
  // { teams: ['england'], broadcaster: 'Sky Sports Cricket' },
];
const DEFAULT_BROADCASTER = 'Check Sky Sports Cricket or TNT Sports listings';

function pickBroadcaster(home, away) {
  const names = (home + ' ' + away).toLowerCase();
  for (const rule of BROADCASTER_OVERRIDES) {
    if (rule.teams.some((t) => names.includes(t))) return rule.broadcaster;
  }
  return DEFAULT_BROADCASTER;
}

// --- Flexible field extraction ----------------------------------------
// The exact shape of a match object from the API hasn't been confirmed
// against a live response yet (needs a real API key to check). This
// tries a few likely field names so a small mismatch doesn't break the
// whole page — but this is the first place to look if matches don't
// show up correctly once a real key is wired in.
function firstOf(obj, keys) {
  for (const k of keys) {
    const val = k.split('.').reduce((o, part) => (o ? o[part] : undefined), obj);
    if (val !== undefined && val !== null && val !== '') return val;
  }
  return undefined;
}

function normalizeMatch(raw) {
  const home = firstOf(raw, ['home.name', 'home_team', 'homeTeam', 'home']);
  const away = firstOf(raw, ['away.name', 'away_team', 'awayTeam', 'away']);
  const start = firstOf(raw, ['start_date', 'startDate', 'date', 'scheduled']);
  const venue = firstOf(raw, ['venue.name', 'venue', 'ground']);
  const series = firstOf(raw, ['series.name', 'series', 'tournament']);
  const format = (firstOf(raw, ['format', 'type', 'match_type']) || '').toString().toLowerCase();
  const status = (firstOf(raw, ['status']) || '').toString().toLowerCase();
  if (!home || !away || !start) return null;
  return { home: String(home), away: String(away), start: String(start), venue, series, format, status };
}

export async function onRequestGet(context) {
  const { env } = context;

  if (!env.CRICKET_API_KEY) {
    return json({ error: 'CRICKET_API_KEY not set' }, 500);
  }

  const cache = caches.default;
  const cacheKey = new Request('https://cache.internal/next-tests');
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let raw;
  try {
    const res = await fetch(`${API_BASE}/matches?sport=cricket&format=test`, {
      headers: { Authorization: `Bearer ${env.CRICKET_API_KEY}` },
    });
    if (!res.ok) throw new Error('upstream ' + res.status);
    raw = await res.json();
  } catch (err) {
    return json({ error: 'upstream fetch failed' }, 502);
  }

  const list = Array.isArray(raw) ? raw : raw.data || raw.matches || [];
  const now = Date.now();

  const tests = list
    .map(normalizeMatch)
    .filter(Boolean)
    .filter((m) => m.format.includes('test') || m.format === '' /* keep if format field wasn't found */)
    .filter((m) => new Date(m.start).getTime() > now || m.status.includes('live') || m.status.includes('progress'))
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  let selected = [];
  if (tests.length) {
    const soonest = new Date(tests[0].start).getTime();
    const WINDOW_MS = 4 * 24 * 60 * 60 * 1000; // treat Tests starting within 4 days of the soonest as "concurrent"
    selected = tests.filter((m) => new Date(m.start).getTime() - soonest <= WINDOW_MS).slice(0, 2);
  }

  const matches = selected.map((m) => ({
    home: m.home,
    away: m.away,
    start: m.start,
    venue: m.venue || null,
    series: m.series || null,
    broadcaster: pickBroadcaster(m.home, m.away),
  }));

  const response = json({ matches, updated: new Date().toISOString() }, 200, {
    'Cache-Control': 'public, max-age=3600',
  });

  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
  });
}
