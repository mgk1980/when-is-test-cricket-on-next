// Builds data/schedule.json — every men's and women's international Test
// that CricketData.org knows about, from about two months ago to about ten
// months ahead, with whether each one has started or finished.
//
// Runs hourly on GitHub (.github/workflows/update-schedule.yml).
// Once a day it does a full search for Test series. In between, it only
// re-checks series with a Test that is about to start or is in progress,
// to stay well inside the free plan's 100 requests a day.

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const KEY = process.env.CRICKETDATA_API_KEY;
const OUT = 'data/schedule.json';
const API = 'https://api.cricapi.com/v1/';
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const REQUEST_CEILING = 95; // stop before the free plan's 100 a day

const FULL_MEMBERS = [
  'Afghanistan', 'Australia', 'Bangladesh', 'England', 'India', 'Ireland',
  'New Zealand', 'Pakistan', 'South Africa', 'Sri Lanka', 'West Indies', 'Zimbabwe',
];
// A teams, Lions, under-19s, academies, invitation XIs: not Tests.
const NOT_SENIOR = /\bA\b|Lions|\bU-?\d\d\b|Under[- ]?\d\d|Emerging|Academy|Development|\bXI\b/i;

let hitsToday = 0;

async function api(path, params = {}) {
  if (hitsToday >= REQUEST_CEILING) {
    throw new Error(`Stopped: ${hitsToday} CricketData requests already used today`);
  }
  const url = new URL(API + path);
  url.searchParams.set('apikey', KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const json = await res.json();
  if (json.info && typeof json.info.hitsToday === 'number') hitsToday = json.info.hitsToday;
  if (json.status !== 'success') {
    // Never print the URL: it contains the key.
    throw new Error(`${path} failed: ${json.reason || json.status || res.status}`);
  }
  return json;
}

function isoDayMs(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? Date.parse(s + 'T00:00:00Z') : null;
}

function isTestSeries(s) {
  const name = s.name || '';
  if (!(Number(s.test) > 0)) return false;
  if (NOT_SENIOR.test(name)) return false;
  return FULL_MEMBERS.some((n) => name.includes(n)) || /Ashes|Test Championship|Test Match/i.test(name);
}

function tidyTeam(t) {
  return (t || '').trim().replace(/\s+Wom[ae]n'?s?$/i, ' (w)');
}

function tidySeries(name) {
  return (name || '')
    .replace(/\bWomens\b/g, "Women's")
    .replace(/\s+tour of\s+/i, ' in ')
    .replace(/[,\s]+\d{4}(-\d{2,4})?\s*$/, '')
    .trim();
}

function testsFromSeries(seriesId, data) {
  const seriesName = tidySeries(data.info && data.info.name);
  const out = [];
  for (const m of data.matchList || []) {
    const name = m.name || '';
    if (!/\bTest\b/i.test(name) || !m.dateTimeGMT) continue;
    const [fixture, label = ''] = name.split(',').map((x) => x.trim());
    const [home, away] = fixture.split(/\s+vs?\s+/i).map(tidyTeam);
    if (!home || !away || /\b(tbc|tba)\b/i.test(home + ' ' + away)) continue;
    out.push({
      id: m.id,
      seriesId,
      home,
      away,
      start: m.dateTimeGMT.replace(/Z?$/, 'Z'),
      venue: m.venue || '',
      series: label ? `${seriesName} (${label})` : seriesName,
      started: !!m.matchStarted,
      // CricketData sometimes flags a match as ended mid-game. Trust the
      // status text over the flag when it plainly shows play in progress.
      ended: !!m.matchEnded && !IN_PROGRESS.test(m.status || ''),
      status: m.status || '',
    });
  }
  return out;
}

const IN_PROGRESS = /^Day \d|\b(stumps|lunch|tea|innings break|rain stops play|bad light|drinks|session)\b/i;

async function fetchSeriesTests(seriesId) {
  const j = await api('series_info', { id: seriesId });
  return testsFromSeries(seriesId, j.data || {});
}

async function discover(now) {
  // The full series list comes newest first, 25 to a page. Read pages until
  // two in a row are entirely older than the window.
  const candidates = new Map();
  let oldPages = 0;
  for (let page = 0; page < 12 && oldPages < 2; page++) {
    const rows = (await api('series', { offset: page * 25 })).data || [];
    if (!rows.length) break;
    const dated = rows.map((s) => isoDayMs(s.startDate)).filter((d) => d !== null);
    const allOld = dated.length > 0 && dated.every((d) => d < now - 60 * DAY);
    oldPages = allOld ? oldPages + 1 : 0;
    for (const s of rows) {
      const sd = isoDayMs(s.startDate);
      if (sd !== null && (sd < now - 60 * DAY || sd > now + 300 * DAY)) continue;
      if (isTestSeries(s)) candidates.set(s.id, s);
    }
  }
  const matches = [];
  for (const id of candidates.keys()) {
    try {
      matches.push(...(await fetchSeriesTests(id)));
    } catch (e) {
      console.log(`Skipped series ${id}: ${e.message}`);
    }
  }
  return { matches, seriesCount: candidates.size };
}

function dedupe(matches) {
  // The same fixture sometimes appears under two series entries.
  const byKey = new Map();
  for (const m of matches) {
    const key = `${m.home}|${m.away}|${m.start.slice(0, 10)}`;
    const prev = byKey.get(key);
    if (!prev || (m.ended && !prev.ended) || (m.started && !prev.started)) byKey.set(key, m);
  }
  return [...byKey.values()].sort((a, b) => a.start.localeCompare(b.start));
}

async function main() {
  if (!KEY) throw new Error('CRICKETDATA_API_KEY secret is not set');
  const now = Date.now();

  let old = null;
  try { old = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* first run */ }

  let matches;
  let discoveredAt = old && old.discoveredAt;
  const due = !old || !discoveredAt || now - Date.parse(discoveredAt) > 20 * HOUR;

  if (due) {
    const found = await discover(now);
    const oldUpcoming = old ? old.matches.filter((m) => Date.parse(m.start) > now).length : 0;
    const newUpcoming = found.matches.filter((m) => Date.parse(m.start) > now).length;
    if (old && newUpcoming < oldUpcoming / 2) {
      // Looks like a bad day at CricketData's end: keep what we had.
      throw new Error(`Search found only ${newUpcoming} upcoming Tests (had ${oldUpcoming}); keeping previous schedule`);
    }
    matches = found.matches;
    discoveredAt = new Date(now).toISOString();
    console.log(`Full search: ${found.seriesCount} series, ${matches.length} Tests`);
  } else {
    // Only re-check series with a Test about to start, in progress, or
    // recently marked finished (in case the feed marked it ended too soon).
    matches = old.matches.slice();
    const active = new Set(
      matches
        .filter((m) => {
          const s = Date.parse(m.start);
          return now >= s - 3 * HOUR && now <= s + 6 * DAY;
        })
        .map((m) => m.seriesId),
    );
    for (const id of active) {
      try {
        const fresh = await fetchSeriesTests(id);
        if (fresh.length) matches = matches.filter((m) => m.seriesId !== id).concat(fresh);
      } catch (e) {
        console.log(`Could not refresh series ${id}: ${e.message}`);
      }
    }
    console.log(`Refreshed ${active.size} active series`);
  }

  const out = { discoveredAt, matches: dedupe(matches) };
  await mkdir('data', { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${out.matches.length} Tests; CricketData requests used today: ${hitsToday}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
