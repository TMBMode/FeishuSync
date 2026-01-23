import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readConfig, requireConfigValue, resolvePath } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_PID = path.join(__dirname, '.feishu-fs-auth.pid');
const SYNC_PID = path.join(__dirname, '.feishu-fs-sync.pid');

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return false;
  }
}

async function readPid(pidPath) {
  try {
    const raw = await fs.readFile(pidPath, 'utf8');
    const pid = Number(raw.trim());
    return Number.isFinite(pid) ? pid : null;
  } catch (err) {
    return null;
  }
}

async function writePid(pidPath, pid) {
  await fs.writeFile(pidPath, `${pid}\n`, 'utf8');
}

async function removePid(pidPath) {
  try {
    await fs.unlink(pidPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
}

function spawnDetached(nodeArgs) {
  const child = spawn(process.execPath, nodeArgs, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  return child;
}

async function waitForToken(tokenPath) {
  const intervalMs = 1000;
  for (;;) {
    try {
      const raw = await fs.readFile(tokenPath, 'utf8');
      if (raw.trim()) return true;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        console.error(`[start] failed reading token file: ${err.message || err}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function start() {
  const config = await readConfig();
  const tokenPath = resolvePath(requireConfigValue(config, 'tokenPath'));

  const authPid = await readPid(AUTH_PID);
  if (authPid && isProcessAlive(authPid)) {
    console.log(`[start] auth already running (pid ${authPid})`);
  } else {
    if (authPid) await removePid(AUTH_PID);
    const authScript = path.join(__dirname, 'scripts', 'auth.js');
    const child = spawnDetached([authScript]);
    await writePid(AUTH_PID, child.pid);
    console.log(`[start] auth started (pid ${child.pid})`);
  }

  const syncPid = await readPid(SYNC_PID);
  if (syncPid && isProcessAlive(syncPid)) {
    console.log(`[start] sync already running (pid ${syncPid})`);
    return;
  }
  if (syncPid) await removePid(SYNC_PID);

  console.log('[start] waiting for token file...');
  await waitForToken(tokenPath);

  const syncScript = path.join(__dirname, 'scripts', 'sync.js');
  const syncChild = spawnDetached([syncScript]);
  await writePid(SYNC_PID, syncChild.pid);
  console.log(`[start] sync started (pid ${syncChild.pid})`);
}

async function stop() {
  const authPid = await readPid(AUTH_PID);
  const syncPid = await readPid(SYNC_PID);

  if (syncPid) {
    if (isProcessAlive(syncPid)) {
      try {
        process.kill(syncPid, 'SIGTERM');
        console.log(`[stop] sync stopped (pid ${syncPid})`);
      } catch (err) {
        console.warn(`[stop] failed to stop sync (pid ${syncPid}): ${err.message || err}`);
      }
    }
    await removePid(SYNC_PID);
  } else {
    console.log('[stop] sync not running');
  }

  if (authPid) {
    if (isProcessAlive(authPid)) {
      try {
        process.kill(authPid, 'SIGTERM');
        console.log(`[stop] auth stopped (pid ${authPid})`);
      } catch (err) {
        console.warn(`[stop] failed to stop auth (pid ${authPid}): ${err.message || err}`);
      }
    }
    await removePid(AUTH_PID);
  } else {
    console.log('[stop] auth not running');
  }
}

const command = process.argv[2] || 'start';
if (command === 'start') {
  start().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else if (command === 'stop') {
  stop().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
} else {
  console.log('Usage: node index.js [start|stop]');
  process.exit(1);
}
