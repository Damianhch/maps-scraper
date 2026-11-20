/**
 * Runs scrape+expand for queued industry lists (after current manual run).
 * Usage: node overnight-chain.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const SCRAPED_LOG = path.join(ROOT, 'industries-already-scraped.txt');
const ACTIVE_LIST = path.join(ROOT, 'list of industries.txt');
const RUNS_DIR = path.join(ROOT, 'runs');

const QUEUED_RUNS = [
  {
    label: 'unchecked-run',
    industryFile: 'list of industries - unchecked-run.txt',
    note: 'English broad — service businesses likely needing web (review tomorrow)',
  },
  {
    label: 'overnight-run-2',
    industryFile: 'list of industries - overnight-run-2.txt',
    note: 'English broad — batch 2 service verticals',
  },
  {
    label: 'overnight-run-3',
    industryFile: 'list of industries - overnight-run-3.txt',
    note: 'English broad — batch 3 professional & local services',
  },
];

function readIndustryLines(filePath) {
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function appendToScrapedLog(lines, sectionTitle) {
  const block = [
    '',
    `# ${sectionTitle}`,
    ...lines,
    '',
  ].join('\n');
  fs.appendFileSync(SCRAPED_LOG, block, 'utf-8');
}

function copyLatestOutputs(runDir, label) {
  const files = fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith('.xlsx') && !f.startsWith('~$') && /^GoogleMapsResults_/i.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(ROOT, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);

  const seen = new Set();
  const toCopy = [];
  for (const { f } of files) {
    if (f.includes('ALL_CUMULATIVE')) continue;
    const key = f.replace(/_\d{4}-\d{2}-\d{2}T[\d-]+/, '_TIMESTAMP');
    if (seen.has(key)) continue;
    if (f.endsWith('_ALL.xlsx')) {
      seen.add('_ALL');
      toCopy.push(f);
    } else if (f.endsWith('_EXPANDED.xlsx')) {
      seen.add('_EXPANDED');
      toCopy.push(f);
    } else if (f.endsWith('.xlsx') && !f.includes('_ALL') && !f.includes('_EXPANDED')) {
      seen.add('_FILTERED');
      toCopy.push(f);
    }
    if (seen.size >= 3) break;
  }

  fs.mkdirSync(runDir, { recursive: true });
  for (const f of toCopy) {
    const dest = path.join(runDir, f);
    fs.copyFileSync(path.join(ROOT, f), dest);
  }

  if (fs.existsSync(path.join(ROOT, 'run-progress.json'))) {
    fs.copyFileSync(
      path.join(ROOT, 'run-progress.json'),
      path.join(runDir, 'run-progress.json')
    );
  }
  if (fs.existsSync(path.join(ROOT, 'run-progress.txt'))) {
    fs.copyFileSync(path.join(ROOT, 'run-progress.txt'), path.join(runDir, 'run-progress.txt'));
  }

  return toCopy;
}

function runOne({ label, industryFile, note }) {
  const src = path.join(ROOT, industryFile);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing industry file: ${industryFile}`);
  }

  const industries = readIndustryLines(src);
  fs.writeFileSync(ACTIVE_LIST, industries.join('\n') + '\n', 'utf-8');

  const manifest = {
    label,
    note,
    startedAt: new Date().toISOString(),
    industryFile,
    industries,
    industryCount: industries.length,
  };
  fs.writeFileSync(path.join(ROOT, 'current-run-label.txt'), label, 'utf-8');

  const runDir = path.join(RUNS_DIR, label);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log('\n' + '='.repeat(70));
  console.log(`🏷️  RUN: ${label}`);
  console.log(`📋 ${industryFile} (${industries.length} industries)`);
  console.log(`📝 ${note}`);
  console.log('='.repeat(70) + '\n');

  execSync('npm run fast', { stdio: 'inherit', cwd: ROOT, env: { ...process.env } });

  manifest.finishedAt = new Date().toISOString();
  const copied = copyLatestOutputs(runDir, label);
  manifest.outputFiles = copied;

  let summary = {};
  try {
    summary = JSON.parse(fs.readFileSync(path.join(ROOT, 'run-progress.json'), 'utf-8'));
  } catch {
    /* ignore */
  }
  manifest.summary = summary;
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  appendToScrapedLog(industries, `${label} (${manifest.finishedAt})`);

  console.log(`\n✅ ${label} done. Outputs copied to runs/${label}/\n`);
  return manifest;
}

function main() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const summaryPath = path.join(RUNS_DIR, 'overnight-summary.json');
  const results = [];

  console.log('🌙 Overnight chain: 3 runs with new English industry lists\n');
  console.log(`📚 Scraped log: ${SCRAPED_LOG}\n`);

  for (const run of QUEUED_RUNS) {
    try {
      results.push(runOne(run));
    } catch (error) {
      console.error(`\n❌ ${run.label} failed:`, error.message);
      results.push({ label: run.label, error: error.message });
      break;
    }
  }

  fs.writeFileSync(
    summaryPath,
    JSON.stringify({ completedAt: new Date().toISOString(), results }, null, 2)
  );
  console.log(`\n🌙 Chain finished. Summary: ${summaryPath}\n`);
}

main();
