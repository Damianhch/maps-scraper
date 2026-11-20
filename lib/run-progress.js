const fs = require('fs');
const path = require('path');

const PROGRESS_JSON = path.join(__dirname, '..', 'run-progress.json');
const PROGRESS_TXT = path.join(__dirname, '..', 'run-progress.txt');

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const min = m % 60;
  return min > 0 ? `${h}h ${min}m` : `${h}h`;
}

function estimateRemaining(elapsedSec, completed, total) {
  if (!total || completed <= 0 || completed >= total) {
    return { remainingSec: null, etaAt: null };
  }
  const rate = completed / elapsedSec;
  if (rate <= 0) return { remainingSec: null, etaAt: null };
  const remainingSec = (total - completed) / rate;
  const etaAt = new Date(Date.now() + remainingSec * 1000).toISOString();
  return { remainingSec, etaAt };
}

function buildSummary(data) {
  if (data.summary) return data.summary;
  if (data.phase === 'scrape') {
    const done = data.industriesDone ?? 0;
    const total = data.totalIndustries ?? '?';
    const pct = total ? Math.round((done / total) * 100) : 0;
    const eta =
      data.remainingSec != null ? `~${formatDuration(data.remainingSec)} left` : 'ETA calculating…';
    const allNote =
      data.leadsAll != null ? ` · ${data.leadsAll} all rows` : '';
    return `Scrape ${done}/${total} industries (${pct}%) · ${formatDuration(data.elapsedSec)} elapsed · ${eta} · ${data.leadsKept ?? 0} filtered${allNote}`;
  }
  if (data.phase === 'expand') {
    const done = data.processed ?? 0;
    const total = data.total ?? '?';
    const pct = total ? Math.round((done / total) * 100) : 0;
    const eta =
      data.remainingSec != null ? `~${formatDuration(data.remainingSec)} left` : 'ETA calculating…';
    return `Expand ${done}/${total} rows (${pct}%) · ${formatDuration(data.elapsedSec)} elapsed · ${eta} · ${data.matched ?? 0} Brreg matches`;
  }
  if (data.phase === 'brreg-new') {
    const done = data.processed ?? 0;
    const total = data.total ?? '?';
    const pct = total && total !== '?' ? Math.round((done / total) * 100) : 0;
    const eta =
      data.remainingSec != null ? `~${formatDuration(data.remainingSec)} left` : 'ETA calculating…';
    return `Brreg-new ${done}/${total} (${pct}%) · ${formatDuration(data.elapsedSec)} elapsed · ${eta} · ${data.matched ?? 0} contacts`;
  }
  if (data.phase === 'brreg-phones') {
    const done = data.processed ?? 0;
    const total = data.total ?? '?';
    const pct = total && total !== '?' ? Math.round((done / total) * 100) : 0;
    const eta =
      data.remainingSec != null ? `~${formatDuration(data.remainingSec)} left` : 'ETA calculating…';
    return `Brreg-phones ${done}/${total} (${pct}%) · ${formatDuration(data.elapsedSec)} elapsed · ${eta} · ${data.matched ?? 0} matched`;
  }
  if (data.phase === 'done') return data.summary || 'Run finished';
  return data.phase || 'Idle';
}

function readProgress() {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_JSON, 'utf8'));
  } catch {
    return {};
  }
}

function writeProgress(patch, { log = false } = {}) {
  const prev = readProgress();
  const next = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  if (!next.startedAt && patch.startedAt) next.startedAt = patch.startedAt;
  next.summary = buildSummary(next);

  fs.writeFileSync(PROGRESS_JSON, JSON.stringify(next, null, 2), 'utf8');
  const txtLines = [
    next.summary,
    `Updated: ${next.updatedAt}`,
    next.scrapeAllOutputFile ? `All places: ${next.scrapeAllOutputFile}` : null,
    next.scrapeOutputFile ? `Filtered: ${next.scrapeOutputFile}` : null,
    next.expandOutputFile ? `Expand: ${next.expandOutputFile}` : null,
    next.brregNewOutputFile ? `Brreg-new: ${next.brregNewOutputFile}` : null,
    next.phase === 'scrape' && next.activeWorkers?.length
      ? `Active: ${next.activeWorkers.join(' | ')}`
      : null,
    next.phase === 'scrape' && next.currentTile
      ? `Tile: ${next.currentTile}`
      : null,
    next.phase === 'expand' && next.inputFile ? `File: ${next.inputFile}` : null,
    next.etaAt ? `ETA: ${next.etaAt}` : null,
  ].filter(Boolean);
  fs.writeFileSync(PROGRESS_TXT, txtLines.join('\n'), 'utf8');

  if (log) {
    console.log(`\n📈 ${next.summary}`);
    if (next.activeWorkers?.length) {
      console.log(`   Active: ${next.activeWorkers.join(' | ')}`);
    }
    if (next.currentTile) {
      console.log(`   Tile: ${next.currentTile}`);
    }
  }
}

function clearProgress(phase) {
  writeProgress({
    phase,
    startedAt: new Date().toISOString(),
    industriesDone: 0,
    totalIndustries: 0,
    processed: 0,
    total: 0,
    leadsKept: 0,
    leadsAll: 0,
    matched: 0,
    elapsedSec: 0,
    remainingSec: null,
    etaAt: null,
    activeWorkers: [],
    currentTile: null,
    apiRequests: 0,
  });
}

function reportScrapeProgress(state, { log = true } = {}) {
  const {
    industriesDone,
    totalIndustries,
    startedAtMs,
    leadsKept,
    leadsAll,
    apiRequests,
    currentIndustries,
    currentTile,
  } = state;
  const elapsedSec = (Date.now() - startedAtMs) / 1000;
  const { remainingSec, etaAt } = estimateRemaining(
    elapsedSec,
    industriesDone,
    totalIndustries
  );
  const activeWorkers = (currentIndustries || []).filter(Boolean);

  writeProgress(
    {
      phase: 'scrape',
      industriesDone,
      totalIndustries,
      elapsedSec: Math.round(elapsedSec),
      remainingSec: remainingSec != null ? Math.round(remainingSec) : null,
      etaAt,
      leadsKept: leadsKept ?? 0,
      leadsAll: leadsAll ?? null,
      apiRequests: apiRequests ?? 0,
      activeWorkers,
      currentTile: currentTile || null,
    },
    { log }
  );
}

function reportExpandProgress(state, { log = false } = {}) {
  const { processed, total, startedAtMs, matched, inputFile } = state;
  const elapsedSec = (Date.now() - startedAtMs) / 1000;
  const { remainingSec, etaAt } = estimateRemaining(elapsedSec, processed, total);

  writeProgress(
    {
      phase: 'expand',
      processed,
      total,
      elapsedSec: Math.round(elapsedSec),
      remainingSec: remainingSec != null ? Math.round(remainingSec) : null,
      etaAt,
      matched: matched ?? 0,
      inputFile: inputFile || null,
    },
    { log }
  );
}

function markDone(summary) {
  writeProgress(
    {
      phase: 'done',
      remainingSec: 0,
      summary,
    },
    { log: true }
  );
}

module.exports = {
  PROGRESS_JSON,
  PROGRESS_TXT,
  formatDuration,
  estimateRemaining,
  clearProgress,
  writeProgress,
  reportScrapeProgress,
  reportExpandProgress,
  markDone,
};
