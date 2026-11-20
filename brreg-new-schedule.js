/**
 * Run the Brreg-first new-business scraper on the 15th and 30th at 06:00 local time.
 * Disabled by default. Enable with ENABLE_BRREG_NEW_SCHEDULE=1.
 *
 *   node brreg-new-schedule.js
 *   ENABLE_BRREG_NEW_SCHEDULE=1 node brreg-new-schedule.js
 */
const { spawn } = require('child_process');
const path = require('path');

const ENABLED = process.env.ENABLE_BRREG_NEW_SCHEDULE === '1';
const RUN_HOUR = 6;
const RUN_MINUTE = 0;

function lastDayOfMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function isRunDay(date) {
  const day = date.getDate();
  if (day === 15 || day === 30) return true;
  const last = lastDayOfMonth(date.getFullYear(), date.getMonth());
  return last < 30 && day === last;
}

function nextRunDate(from = new Date()) {
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMilliseconds(0);

  const todaysSlot = new Date(cursor);
  todaysSlot.setHours(RUN_HOUR, RUN_MINUTE, 0, 0);
  if (isRunDay(cursor) && cursor < todaysSlot) return todaysSlot;

  cursor.setDate(cursor.getDate() + 1);
  cursor.setHours(RUN_HOUR, RUN_MINUTE, 0, 0);
  while (!isRunDay(cursor)) {
    cursor.setDate(cursor.getDate() + 1);
  }
  return cursor;
}

function runScraper() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'brreg-new-businesses.js')], {
      cwd: __dirname,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`brreg-new-businesses exited ${code}`));
    });
  });
}

async function loop() {
  while (true) {
    const next = nextRunDate();
    const waitMs = Math.max(1000, next.getTime() - Date.now());
    console.log(`Next Brreg-new run: ${next.toISOString()} (in ${Math.round(waitMs / 3600000)}h)`);
    await new Promise((r) => setTimeout(r, waitMs));
    console.log(`Starting scheduled Brreg-new run at ${new Date().toISOString()}`);
    try {
      await runScraper();
    } catch (err) {
      console.error('Scheduled run failed:', err.message);
    }
    await new Promise((r) => setTimeout(r, 60 * 1000));
  }
}

if (!ENABLED) {
  const next = nextRunDate();
  console.log('Brreg-new scheduler is OFF.');
  console.log('Set ENABLE_BRREG_NEW_SCHEDULE=1 to run on the 15th and 30th at 06:00.');
  console.log(`If enabled, next slot would be ${next.toISOString()}.`);
  process.exit(0);
}

loop().catch((err) => {
  console.error(err);
  process.exit(1);
});
