const fs = require('fs/promises');
const readline = require('readline');
const { markdownToBlocks, inlineMarkdownToElements, BLOCK_TYPE } = require('./feishu-md');

const TOKEN_PATH = './user-token.txt';
const API_BASE = 'https://open.feishu.cn/open-apis';
const WIKI_SPACE_ID = '7493965382345932804';

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

async function readToken() {
  const raw = await fs.readFile(TOKEN_PATH, 'utf8');
  const token = raw.trim();
  if (!token) {
    throw new Error('user-token.txt is empty. Run npm run auth first.');
  }
  return token;
}

async function apiPost(path, token, body, query = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const headers = {
    Authorization: `Bearer ${token}`,
  };

  const options = {
    method: 'POST',
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

async function appendBlocks(documentId, token, blocks, startIndex = 0) {
  if (!blocks.length) return;
  const batchSize = 100;
  let index = startIndex;
  for (let i = 0; i < blocks.length; i += batchSize) {
    const chunk = blocks.slice(i, i + batchSize);
    await apiPost(`/docx/v1/documents/${documentId}/blocks/${documentId}/children`, token, {
      index,
      children: chunk,
    });
    index += chunk.length;
  }
  return index;
}

async function addDocToWiki(spaceId, token, documentId) {
  await apiPost(`/wiki/v2/spaces/${spaceId}/nodes/move_docs_to_wiki`, token, {
    obj_type: 'docx',
    obj_token: documentId,
  });
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

async function main() {
  const inputPath = await ask('Markdown file path: ');
  if (!inputPath) {
    console.error('Markdown file path is required.');
    process.exit(1);
  }

  const markdown = await fs.readFile(inputPath, 'utf8');
  const token = await readToken();

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
  await addDocToWiki(WIKI_SPACE_ID, token, documentId);
  console.log(`Uploaded document: ${documentId}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
