import fs from 'node:fs/promises';
import path from 'node:path';
import { readConfig, requireConfigValue, resolvePath } from '../config.js';
import {
  readToken,
  hashFile,
  readManifest,
  writeManifest,
  sanitizeFilename,
  ensurePosixPath,
  ensureUniqueFilePath,
  buildConflictPath,
  resolveFileType,
} from '../api/helpers.js';
import {
  deleteRemoteDocument,
  collectWikiDocNodes,
  fetchDocumentMeta,
  downloadDocumentToFile,
  uploadMarkdownToDocument,
  createDocumentFromMarkdown,
} from '../api/feishu.js';

if (typeof fetch !== 'function') {
  console.error('This CLI requires Node.js 18+ (global fetch).');
  process.exit(1);
}

const MANIFEST_NAME = '.feishu-sync.json';

function expandHomeDir(inputPath) {
  if (!inputPath) return inputPath;
  if (inputPath === '~') return process.env.HOME || inputPath;
  if (inputPath.startsWith('~/')) {
    const home = process.env.HOME || '';
    return path.join(home, inputPath.slice(2));
  }
  return inputPath;
}

function isMarkdownFile(entry) {
  return entry.toLowerCase().endsWith('.md');
}

async function listMarkdownFiles(rootDir, manifestName) {
  const files = [];
  const skipDirs = new Set(['.git', 'node_modules']);

  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === manifestName) continue;
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isMarkdownFile(entry.name)) continue;
      if (entry.name.endsWith('.remote.md')) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = ensurePosixPath(path.relative(rootDir, fullPath));
      files.push({ fullPath, relPath });
    }
  };

  await walk(rootDir);
  return files;
}

async function deleteLocalFile(filePath) {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}



async function main() {
  const config = await readConfig();
  const spaceId = requireConfigValue(config, 'wikiSpaceId');
  const folderInput = requireConfigValue(config, 'sync.folderPath');
  const manifestName = MANIFEST_NAME;
  const tokenPath = resolvePath(requireConfigValue(config, 'tokenPath'));

  const resolvedFolder = path.resolve(expandHomeDir(folderInput));
  await fs.mkdir(resolvedFolder, { recursive: true });

  const token = await readToken(tokenPath);
  const manifest = await readManifest(resolvedFolder, manifestName);
  const manifestDocs = manifest.docs || {};
  manifest.spaceId = spaceId;

  const localFiles = await listMarkdownFiles(resolvedFolder, manifestName);
  const localMap = new Map();
  for (const file of localFiles) {
    const hash = await hashFile(file.fullPath);
    localMap.set(file.relPath, { ...file, hash });
  }

  const wikiDocs = [];
  await collectWikiDocNodes(spaceId, token, undefined, wikiDocs);

  const remoteDocs = [];
  for (const node of wikiDocs) {
    const meta = await fetchDocumentMeta(node.documentId, token);
    remoteDocs.push({
      documentId: node.documentId,
      nodeToken: node.nodeToken,
      title: meta.title || node.title || '',
      revisionId: meta.revision_id ?? meta.revisionId ?? null,
      fileType: node.objType || 'docx',
    });
  }

  const remoteMap = new Map(remoteDocs.map((doc) => [doc.documentId, doc]));
  const usedPaths = new Set(localFiles.map((file) => file.relPath));
  for (const entry of Object.values(manifestDocs)) {
    if (entry && entry.file) {
      usedPaths.add(entry.file);
    }
  }

  let downloaded = 0;
  let uploaded = 0;
  let conflicts = 0;
  let skipped = 0;
  let deletedLocal = 0;
  let deletedRemote = 0;

  for (const doc of remoteDocs) {
    const existing = manifestDocs[doc.documentId];
    const baseName = sanitizeFilename(doc.title) || doc.documentId;
    const desiredName = `${baseName}.md`;
    let fileRel = existing?.file;
    const renameCandidates = new Set(usedPaths);
    if (fileRel) {
      renameCandidates.delete(fileRel);
    }
    const desiredRel = await ensureUniqueFilePath(
      resolvedFolder,
      desiredName,
      renameCandidates
    );
    if (!fileRel) {
      fileRel = desiredRel;
    } else if (desiredRel && desiredRel !== fileRel) {
      const oldRel = fileRel;
      const oldInfo = localMap.get(oldRel);
      const oldAbs = path.join(resolvedFolder, oldRel);
      const newAbs = path.join(resolvedFolder, desiredRel);
      if (oldInfo) {
        await fs.rename(oldAbs, newAbs);
        localMap.delete(oldRel);
        localMap.set(desiredRel, { ...oldInfo, relPath: desiredRel, fullPath: newAbs });
      }
      usedPaths.delete(oldRel);
      usedPaths.add(desiredRel);
      fileRel = desiredRel;
      if (existing) {
        existing.file = fileRel;
      }
    }

    const fileAbs = path.join(resolvedFolder, fileRel);
    const localInfo = localMap.get(fileRel);
    const localExists = Boolean(localInfo);

    if (!existing) {
      const hash = await downloadDocumentToFile(
        doc.documentId,
        token,
        {
          document_id: doc.documentId,
          revision_id: doc.revisionId,
          title: doc.title,
        },
        fileAbs
      );
      manifestDocs[doc.documentId] = {
        file: fileRel,
        revisionId: doc.revisionId,
        title: doc.title,
        fileType: resolveFileType(doc),
        hash,
      };
      usedPaths.add(fileRel);
      localMap.set(fileRel, { fullPath: fileAbs, relPath: fileRel, hash });
      downloaded += 1;
      continue;
    }

    if (!localExists) {
      await deleteRemoteDocument(doc.documentId, token, resolveFileType(doc, existing));
      delete manifestDocs[doc.documentId];
      deletedRemote += 1;
      continue;
    }

    const localChanged =
      existing.hash && localInfo.hash && existing.hash !== localInfo.hash;
    const remoteChanged =
      existing.revisionId && doc.revisionId && existing.revisionId !== doc.revisionId;

    if (remoteChanged && localChanged) {
      const conflictRel = buildConflictPath(fileRel);
      const conflictAbs = path.join(resolvedFolder, conflictRel);
      await downloadDocumentToFile(
        doc.documentId,
        token,
        {
          document_id: doc.documentId,
          revision_id: doc.revisionId,
          title: doc.title,
        },
        conflictAbs
      );
      conflicts += 1;
      continue;
    }

    if (remoteChanged && !localChanged) {
      const hash = await downloadDocumentToFile(
        doc.documentId,
        token,
        {
          document_id: doc.documentId,
          revision_id: doc.revisionId,
          title: doc.title,
        },
        fileAbs
      );
      manifestDocs[doc.documentId] = {
        ...existing,
        file: fileRel,
        revisionId: doc.revisionId,
        title: doc.title,
        fileType: resolveFileType(doc, existing),
        hash,
      };
      localMap.set(fileRel, { ...localInfo, hash });
      downloaded += 1;
      continue;
    }

    if (localChanged && !remoteChanged) {
      const markdown = await fs.readFile(localInfo.fullPath, 'utf8');
      await uploadMarkdownToDocument(doc.documentId, token, markdown);
      const meta = await fetchDocumentMeta(doc.documentId, token);
      manifestDocs[doc.documentId] = {
        ...existing,
        file: fileRel,
        revisionId: meta.revision_id ?? meta.revisionId ?? doc.revisionId,
        title: meta.title || doc.title,
        fileType: resolveFileType(doc, existing),
        hash: localInfo.hash,
      };
      uploaded += 1;
      continue;
    }

    manifestDocs[doc.documentId] = {
      ...existing,
      file: fileRel,
      revisionId: doc.revisionId,
      title: doc.title,
      fileType: resolveFileType(doc, existing),
      hash: localInfo.hash || existing.hash,
    };
    skipped += 1;
  }

  for (const [docId, entry] of Object.entries({ ...manifestDocs })) {
    if (remoteMap.has(docId)) continue;
    const fileRel = entry.file;
    if (!fileRel) {
      delete manifestDocs[docId];
      continue;
    }
    const localInfo = localMap.get(fileRel);
    if (localInfo) {
      await deleteLocalFile(localInfo.fullPath);
      localMap.delete(fileRel);
      deletedLocal += 1;
    }
    delete manifestDocs[docId];
  }

  const fileToDoc = new Map();
  for (const [docId, entry] of Object.entries(manifestDocs)) {
    if (entry.file) fileToDoc.set(entry.file, docId);
  }

  for (const [fileRel, localInfo] of localMap.entries()) {
    if (fileToDoc.has(fileRel)) continue;
    const markdown = await fs.readFile(localInfo.fullPath, 'utf8');
    const newDocId = await createDocumentFromMarkdown(spaceId, token, markdown);
    const meta = await fetchDocumentMeta(newDocId, token);
    manifestDocs[newDocId] = {
      file: fileRel,
      revisionId: meta.revision_id ?? meta.revisionId ?? null,
      title: meta.title || '',
      fileType: 'docx',
      hash: localInfo.hash,
    };
    uploaded += 1;
  }

  await writeManifest(resolvedFolder, { spaceId, docs: manifestDocs }, manifestName);

  console.log(
    `Sync complete. Downloaded: ${downloaded}, Uploaded: ${uploaded}, Deleted Local: ${deletedLocal}, Deleted Remote: ${deletedRemote}, Conflicts: ${conflicts}, Skipped: ${skipped}`
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
