import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Lark from '@larksuiteoapi/node-sdk';
import { readConfig, requireConfigValue, resolvePath } from './config.js';
import {
  readToken,
  readManifest,
  resolveSyncFolder,
  pickAppCredentials,
  normalizeLoggerLevel,
  normalizeFileTypes,
  startLocalWatcher,
  resolveFileType,
} from './api/helpers.js';
import {
  subscribeToDocEvents,
  createChangeProcessor,
  syncNewDocsFromWiki,
} from './api/feishu.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (typeof fetch !== 'function') {
  console.error('This CLI requires Node.js 18+ (global fetch).');
  process.exit(1);
}

function requireBoolean(config, keyPath) {
  const value = requireConfigValue(config, keyPath);
  if (typeof value !== 'boolean') {
    throw new Error(`Expected ${keyPath} to be a boolean in config.json.`);
  }
  return value;
}

function requireNonNegativeNumber(config, keyPath) {
  const raw = requireConfigValue(config, keyPath);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Expected ${keyPath} to be a non-negative number in config.json.`);
  }
  return value;
}

function requirePositiveNumber(config, keyPath) {
  const raw = requireConfigValue(config, keyPath);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected ${keyPath} to be a positive number in config.json.`);
  }
  return value;
}

function requireNonEmptyArray(config, keyPath) {
  const value = requireConfigValue(config, keyPath);
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Expected ${keyPath} to be a non-empty array in config.json.`);
  }
  return value;
}

async function main() {
  const config = await readConfig();
  const tokenPath = resolvePath(requireConfigValue(config, 'tokenPath'));
  const spaceId = requireConfigValue(config, 'wikiSpaceId');
  const folderInput = requireConfigValue(config, 'sync.folderPath');
  const manifestName = requireConfigValue(config, 'sync.manifestName');
  const rootDir = resolveSyncFolder(folderInput);
  await fs.mkdir(rootDir, { recursive: true });
  const token = await readToken(tokenPath);

  const realtime = requireConfigValue(config, 'realtime');
  if (!realtime || typeof realtime !== 'object') {
    throw new Error('Expected realtime to be an object in config.json.');
  }
  const { appId, appSecret } = pickAppCredentials(config);

  const debounceMs = requireNonNegativeNumber(config, 'realtime.debounceMs');
  const dedupeWindowMs = requireNonNegativeNumber(config, 'realtime.dedupeWindowMs');
  const localIgnoreWindowMs = requireNonNegativeNumber(
    config,
    'realtime.localIgnoreWindowMs'
  );
  const logEvents = requireBoolean(config, 'realtime.logEvents');
  const fileTypes = normalizeFileTypes(
    requireNonEmptyArray(config, 'realtime.fileTypes')
  );
  const subscribeEvents = requireBoolean(config, 'realtime.subscribeEvents');
  const pollIntervalSecondsRaw = requireConfigValue(
    config,
    'realtime.pollIntervalSeconds'
  );
  const pollDisabled =
    pollIntervalSecondsRaw === false ||
    pollIntervalSecondsRaw === 0 ||
    pollIntervalSecondsRaw === '0';
  const pollIntervalSeconds = pollDisabled
    ? 0
    : requirePositiveNumber(config, 'realtime.pollIntervalSeconds');

  const eventTypes = requireNonEmptyArray(config, 'realtime.eventTypes');

  const loggerLevel = normalizeLoggerLevel(
    requireConfigValue(config, 'realtime.loggerLevel'),
    Lark.LoggerLevel
  );
  const initialSync = requireBoolean(config, 'realtime.initialSync');

  let ignoreLocalChanges = false;
  const subscribedDocs = new Set();
  const subscribeToDocument = async (docId, fileType) => {
    if (!subscribeEvents) return;
    if (!docId) return;
    if (subscribedDocs.has(docId)) return;
    const normalizedType = fileType ? String(fileType).toLowerCase() : 'docx';
    if (fileTypes && !fileTypes.has(normalizedType)) return;
    try {
      await subscribeToDocEvents(docId, token, normalizedType);
      subscribedDocs.add(docId);
      if (logEvents) {
        console.log(`[realtime-sync] subscribed ${docId} (${normalizedType})`);
      }
    } catch (err) {
      console.warn(
        `[realtime-sync] subscribe failed for ${docId}: ${err.message || err}`
      );
    }
  };

  const subscribeManifestDocs = async () => {
    if (!subscribeEvents) return;
    const manifest = await readManifest(rootDir, manifestName);
    const entries = Object.entries(manifest.docs || {});
    for (const [docId, entry] of entries) {
      await subscribeToDocument(docId, resolveFileType(null, entry));
    }
    if (logEvents) {
      console.log(`[realtime-sync] subscription scan complete (${entries.length} docs)`);
    }
  };

  const runFullSync = (reason) =>
    new Promise((resolve) => {
      const reasonText = reason ? ` (${reason})` : '';
      console.log(`[realtime-sync] running full sync${reasonText}`);
      const child = spawn(process.execPath, [path.join(__dirname, 'update.js')], {
        stdio: 'inherit',
      });
      child.on('error', (err) => {
        console.error(`[realtime-sync] full sync failed: ${err.message || err}`);
      });
      child.on('exit', (code, signal) => {
        const status =
          code === 0
            ? 'completed'
            : `failed (code ${code ?? 'unknown'}, signal ${signal ?? 'none'})`;
        console.log(`[realtime-sync] full sync ${status}`);
        resolve();
      });
    });

  const pollForNewDocs = async () => {
    ignoreLocalChanges = true;
    try {
      await syncNewDocsFromWiki({
        rootDir,
        spaceId,
        token,
        logEvents,
        subscribeToDocument,
        manifestName,
      });
    } finally {
      ignoreLocalChanges = false;
    }
  };

  const startPolling = () => {
    if (pollDisabled || !pollIntervalSeconds) return;
    let running = false;
    const intervalMs = pollIntervalSeconds * 1000;
    setInterval(() => {
      if (running) return;
      running = true;
      pollForNewDocs()
        .catch((err) => {
          console.error(`[realtime-sync] poll sync failed: ${err.message || err}`);
        })
        .finally(() => {
          running = false;
        });
    }, intervalMs);
    console.log(`[realtime-sync] polling every ${pollIntervalSeconds}s`);
  };

  const {
    handleEvent,
    handleLocalChange,
    getLastProcessCompletedAt,
    isProcessing,
    processPending,
  } = createChangeProcessor({
    token,
    spaceId,
    rootDir,
    debounceMs,
    dedupeWindowMs,
    logEvents,
    fileTypes,
    runFullSync,
    subscribeToDocument,
    manifestName,
  });

  if (initialSync) {
    await runFullSync('startup');
  }

  await subscribeManifestDocs();
  startPolling();

  startLocalWatcher(rootDir, {
    onChange: handleLocalChange,
    logEvents,
    localIgnoreWindowMs,
    getLastProcessCompletedAt,
    isProcessing,
    shouldIgnoreLocal: () => ignoreLocalChanges,
    manifestName,
  });

  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    loggerLevel,
  });

  const dispatcher = new Lark.EventDispatcher({ loggerLevel });
  const handlers = {};
  for (const eventType of eventTypes) {
    handlers[eventType] = async (data) => handleEvent(eventType, data);
  }
  dispatcher.register(handlers);

  console.log('[realtime-sync] websocket client starting');
  await wsClient.start({ eventDispatcher: dispatcher });
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
