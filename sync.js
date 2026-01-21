const fs = require('fs/promises');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const {
  feishuToMarkdown,
  markdownToBlocks,
  inlineMarkdownToElements,
  BLOCK_TYPE,
} = require('./feishu-md');

const TOKEN_PATH = './user-token.txt';
const API_BASE = 'https://open.feishu.cn/open-apis';
const DEFAULT_WIKI_SPACE_ID = '7493965382345932804';
const MANIFEST_NAME = '.feishu-sync.json';
const DELETE_BATCH_SIZE = 100;
const CREATE_BATCH_SIZE = 100;

if (typeof fetch !== 'function') {
  console.error('This CLI requires Node.js 18+ (global fetch).');
  process.exit(1);
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function expandHomeDir(inputPath) {
  if (!inputPath) return inputPath;
  if (inputPath === '~') return process.env.HOME || inputPath;
  if (inputPath.startsWith('~/')) {
    const home = process.env.HOME || '';
    return path.join(home, inputPath.slice(2));
  }
  return inputPath;
}

async function readToken() {
  const raw = await fs.readFile(TOKEN_PATH, 'utf8');
  const token = raw.trim();
  if (!token) {
    throw new Error('user-token.txt is empty. Run npm run auth first.');
  }
  return token;
}

async function apiRequest(method, pathSuffix, token, { query = {}, body } = {}) {
  const url = new URL(`${API_BASE}${pathSuffix}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const headers = {
    Authorization: `Bearer ${token}`,
  };
  const options = {
    method,
    headers,
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    options.body = JSON.stringify(body);
  }

  const maxRetries = 5;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (err) {
      const bodyPreview = body ? JSON.stringify(body).slice(0, 200) : '';
      throw new Error(
        `Fetch failed for ${url.toString()}: ${err && err.message ? err.message : err}${
          bodyPreview ? ` | body=${bodyPreview}` : ''
        }`
      );
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const delayMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : Math.min(8000, 1000 * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (err) {
      throw new Error(
        `API response is not JSON (status ${response.status}). Raw response: ${text || '<empty>'}`
      );
    }

    if (!data) {
      throw new Error(`API response is empty (status ${response.status}).`);
    }

    if (data.code !== 0) {
      const message = data.msg || data.error_description || data.error || 'Unknown error';
      throw new Error(`API error (${data.code}): ${message}`);
    }
    return data.data ?? data;
  }

  throw new Error('API error: rate limited (429) after retries.');
}

async function apiGet(pathSuffix, token, query) {
  return apiRequest('GET', pathSuffix, token, { query });
}

async function apiPost(pathSuffix, token, body, query) {
  return apiRequest('POST', pathSuffix, token, { query, body });
}

async function apiDelete(pathSuffix, token, body, query) {
  return apiRequest('DELETE', pathSuffix, token, { query, body });
}

async function fetchAllBlocks(documentId, token) {
  const blocks = [];
  let pageToken;
  let hasMore = true;

  while (hasMore) {
    const data = await apiGet(
      `/docx/v1/documents/${documentId}/blocks`,
      token,
      {
        page_size: 100,
        document_revision_id: -1,
        page_token: pageToken,
      }
    );

    const items = data.items || data.blocks || [];
    blocks.push(...items);

    pageToken = data.page_token || data.next_page_token || '';
    if (typeof data.has_more === 'boolean') {
      hasMore = data.has_more;
    } else {
      hasMore = Boolean(pageToken);
    }
  }

  return blocks;
}

async function fetchWikiNodes(spaceId, token, parentNodeToken) {
  const nodes = [];
  let pageToken;
  let hasMore = true;

  while (hasMore) {
    const data = await apiGet(`/wiki/v2/spaces/${spaceId}/nodes`, token, {
      parent_node_token: parentNodeToken,
      page_token: pageToken,
      page_size: 50,
    });

    const items = data.items || data.nodes || [];
    nodes.push(...items);

    pageToken = data.page_token || data.next_page_token || '';
    if (typeof data.has_more === 'boolean') {
      hasMore = data.has_more;
    } else {
      hasMore = Boolean(pageToken);
    }
  }

  return nodes;
}

async function collectWikiDocNodes(spaceId, token, parentNodeToken, result) {
  const nodes = await fetchWikiNodes(spaceId, token, parentNodeToken);
  for (const node of nodes) {
    const hasChild = node.has_child ?? node.hasChild;
    const nodeToken = node.node_token || node.nodeToken;
    const objType = node.obj_type || node.objType;
    const objToken = node.obj_token || node.objToken;

    if (objToken && (objType === 'docx' || objType === 'doc')) {
      result.push({
        nodeToken,
        documentId: objToken,
        title: node.title || node.name || '',
      });
    }

    if (hasChild && nodeToken) {
      await collectWikiDocNodes(spaceId, token, nodeToken, result);
    }
  }
}

async function fetchDocumentMeta(documentId, token) {
  const data = await apiGet(`/docx/v1/documents/${documentId}`, token);
  return data.document || data;
}

function sanitizeFilename(name) {
  return name
    .replace(/[\\/\n\r\t\0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function ensurePosixPath(value) {
  return value.split(path.sep).join('/');
}

function isMarkdownFile(entry) {
  return entry.toLowerCase().endsWith('.md');
}

async function listMarkdownFiles(rootDir) {
  const files = [];
  const skipDirs = new Set(['.git', 'node_modules']);

  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === MANIFEST_NAME) continue;
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

async function hashFile(filePath) {
  const data = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function readManifest(folder) {
  const manifestPath = path.join(folder, MANIFEST_NAME);
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') {
      return { spaceId: '', docs: {} };
    }
    return {
      spaceId: data.spaceId || '',
      docs: data.docs && typeof data.docs === 'object' ? data.docs : {},
    };
  } catch (err) {
    return { spaceId: '', docs: {} };
  }
}

async function writeManifest(folder, manifest) {
  const manifestPath = path.join(folder, MANIFEST_NAME);
  const output = {
    spaceId: manifest.spaceId || '',
    updatedAt: new Date().toISOString(),
    docs: manifest.docs || {},
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

async function downloadDocumentToFile(documentId, token, metadata, filePath) {
  const blocks = await fetchAllBlocks(documentId, token);
  const markdown = feishuToMarkdown({ metadata, blocks });
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, markdown, 'utf8');
  const hash = crypto.createHash('sha256').update(markdown).digest('hex');
  return hash;
}

async function ensureUniqueFilePath(baseDir, fileName, usedPaths) {
  const base = fileName.replace(/\.md$/i, '');
  let candidate = `${base}.md`;
  let fullPath = path.join(baseDir, candidate);
  let counter = 1;
  while (usedPaths.has(ensurePosixPath(path.relative(baseDir, fullPath)))) {
    candidate = `${base}-${counter}.md`;
    fullPath = path.join(baseDir, candidate);
    counter += 1;
  }
  return ensurePosixPath(path.relative(baseDir, fullPath));
}

function buildCellTextBlocks(content) {
  const lines = content.split('\n');
  const blocks = [];
  for (const line of lines) {
    const elements = inlineMarkdownToElements(line);
    blocks.push({
      block_type: BLOCK_TYPE.text,
      text: {
        style: {},
        elements,
      },
    });
  }
  return blocks;
}

function extractBlocksFromResponse(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.children)) return data.children;
  if (Array.isArray(data.blocks)) return data.blocks;
  if (Array.isArray(data.items)) return data.items;
  if (data.data) return extractBlocksFromResponse(data.data);
  return [];
}

async function createTableWithContent(documentId, token, tableBlock, index) {
  const rows = tableBlock._table?.rows || [];
  const rowSize = tableBlock.table?.property?.row_size || rows.length;
  const columnSize = tableBlock.table?.property?.column_size || rows[0]?.length || 0;
  const headerRow = Boolean(tableBlock.table?.property?.header_row);

  if (!rows.length || !columnSize) {
    return index;
  }

  const payload = {
    block_type: BLOCK_TYPE.table,
    table: {
      property: {
        row_size: rowSize,
        column_size: columnSize,
        header_row: headerRow,
        header_column: false,
      },
    },
  };

  const resp = await apiPost(
    `/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
    token,
    {
      index,
      children: [payload],
    }
  );

  const created = extractBlocksFromResponse(resp);
  const createdTable =
    created.find((block) => block.block_type === BLOCK_TYPE.table) || created[0];
  const cellIds = createdTable?.table?.cells || [];

  if (!cellIds.length) {
    return index + 1;
  }

  for (let r = 0; r < rows.length; r += 1) {
    for (let c = 0; c < rows[r].length; c += 1) {
      const cellId = cellIds[r * columnSize + c];
      if (!cellId) continue;
      const cellContent = rows[r][c] || '';
      if (!cellContent.trim()) continue;
      const children = buildCellTextBlocks(cellContent);
      await apiPost(
        `/docx/v1/documents/${documentId}/blocks/${cellId}/children`,
        token,
        {
          index: 0,
          children,
        }
      );
    }
  }

  return index + 1;
}

async function appendBlocks(documentId, token, blocks, startIndex = 0) {
  if (!blocks.length) return startIndex;
  let index = startIndex;
  for (let i = 0; i < blocks.length; i += CREATE_BATCH_SIZE) {
    const chunk = blocks.slice(i, i + CREATE_BATCH_SIZE);
    await apiPost(`/docx/v1/documents/${documentId}/blocks/${documentId}/children`, token, {
      index,
      children: chunk,
    });
    index += chunk.length;
  }
  return index;
}

async function appendBlocksWithTables(documentId, token, blocks) {
  let index = 0;
  let buffer = [];

  const flushBuffer = async () => {
    if (!buffer.length) return;
    index = await appendBlocks(documentId, token, buffer, index);
    buffer = [];
  };

  for (const block of blocks) {
    if (block.block_type === BLOCK_TYPE.table && block._table) {
      await flushBuffer();
      index = await createTableWithContent(documentId, token, block, index);
      continue;
    }
    buffer.push(block);
  }

  await flushBuffer();
}

async function createDocument(token, title) {
  try {
    const data = await apiPost('/docx/v1/documents', token, title ? { title } : undefined);
    const documentId = data?.document?.document_id || data?.document_id || data?.documentId;
    if (!documentId) {
      throw new Error('Create document response missing document_id.');
    }
    return { documentId, usedTitle: Boolean(title) };
  } catch (err) {
    if (title) {
      const data = await apiPost('/docx/v1/documents', token);
      const documentId = data?.document?.document_id || data?.document_id || data?.documentId;
      if (!documentId) {
        throw new Error('Create document response missing document_id.');
      }
      return { documentId, usedTitle: false };
    }
    throw err;
  }
}

async function addDocToWiki(spaceId, token, documentId) {
  await apiPost(`/wiki/v2/spaces/${spaceId}/nodes/move_docs_to_wiki`, token, {
    obj_type: 'docx',
    obj_token: documentId,
  });
}

async function fetchChildrenCount(documentId, token) {
  let count = 0;
  let pageToken;
  let hasMore = true;
  while (hasMore) {
    const data = await apiGet(
      `/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
      token,
      {
        page_size: 200,
        document_revision_id: -1,
        page_token: pageToken,
      }
    );
    const items = data.items || data.blocks || data.children || [];
    count += items.length;
    pageToken = data.page_token || data.next_page_token || '';
    if (typeof data.has_more === 'boolean') {
      hasMore = data.has_more;
    } else {
      hasMore = Boolean(pageToken);
    }
  }
  return count;
}

async function deleteAllChildren(documentId, token) {
  let remaining = await fetchChildrenCount(documentId, token);
  while (remaining > 0) {
    const batch = Math.min(DELETE_BATCH_SIZE, remaining);
    await apiDelete(
      `/docx/v1/documents/${documentId}/blocks/${documentId}/children/batch_delete`,
      token,
      {
        start_index: 0,
        end_index: batch,
      },
      { document_revision_id: -1 }
    );
    remaining -= batch;
  }
}

async function uploadMarkdownToDocument(documentId, token, markdown) {
  const { blocks } = markdownToBlocks(markdown);
  await deleteAllChildren(documentId, token);
  await appendBlocksWithTables(documentId, token, blocks);
}

async function createDocumentFromMarkdown(spaceId, token, markdown) {
  const { title, blocks } = markdownToBlocks(markdown);
  const { documentId, usedTitle } = await createDocument(token, title);

  const contentBlocks = usedTitle
    ? blocks
    : [
        {
          block_type: BLOCK_TYPE.heading1,
          heading1: {
            style: {},
            elements: [{ text_run: { content: title, text_element_style: {} } }],
          },
        },
        ...blocks,
      ];

  await appendBlocksWithTables(documentId, token, contentBlocks);
  await addDocToWiki(spaceId, token, documentId);
  return documentId;
}

function buildConflictPath(relPath) {
  if (relPath.toLowerCase().endsWith('.md')) {
    return relPath.replace(/\.md$/i, '.remote.md');
  }
  return `${relPath}.remote.md`;
}

async function main() {
  const spaceInput = await ask(`Wiki space ID (default ${DEFAULT_WIKI_SPACE_ID}): `);
  const spaceId = spaceInput || DEFAULT_WIKI_SPACE_ID;
  const folderInput = await ask('Local folder path: ');
  if (!folderInput) {
    console.error('Local folder path is required.');
    process.exit(1);
  }

  const resolvedFolder = path.resolve(expandHomeDir(folderInput));
  await fs.mkdir(resolvedFolder, { recursive: true });

  const token = await readToken();
  const manifest = await readManifest(resolvedFolder);
  const manifestDocs = manifest.docs || {};
  manifest.spaceId = spaceId;

  const localFiles = await listMarkdownFiles(resolvedFolder);
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

  for (const doc of remoteDocs) {
    const existing = manifestDocs[doc.documentId];
    let fileRel = existing?.file;
    if (!fileRel) {
      const baseName = sanitizeFilename(doc.title) || doc.documentId;
      fileRel = await ensureUniqueFilePath(resolvedFolder, `${baseName}.md`, usedPaths);
    }

    const fileAbs = path.join(resolvedFolder, fileRel);
    const localInfo = localMap.get(fileRel);
    const localExists = Boolean(localInfo);

    if (!existing || !localExists) {
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
        hash,
      };
      usedPaths.add(fileRel);
      localMap.set(fileRel, { fullPath: fileAbs, relPath: fileRel, hash });
      downloaded += 1;
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
    if (!localInfo) {
      delete manifestDocs[docId];
      continue;
    }
    const markdown = await fs.readFile(localInfo.fullPath, 'utf8');
    const newDocId = await createDocumentFromMarkdown(spaceId, token, markdown);
    const meta = await fetchDocumentMeta(newDocId, token);
    manifestDocs[newDocId] = {
      file: fileRel,
      revisionId: meta.revision_id ?? meta.revisionId ?? null,
      title: meta.title || entry.title || '',
      hash: localInfo.hash,
    };
    delete manifestDocs[docId];
    uploaded += 1;
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
      hash: localInfo.hash,
    };
    uploaded += 1;
  }

  await writeManifest(resolvedFolder, { spaceId, docs: manifestDocs });

  console.log(
    `Sync complete. Downloaded: ${downloaded}, Uploaded: ${uploaded}, Conflicts: ${conflicts}, Skipped: ${skipped}`
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
