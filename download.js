const fs = require('fs/promises');
const readline = require('readline');
const { feishuToMarkdown } = require('./feishu-md');

const TOKEN_PATH = './user-token.txt';
const API_BASE = 'https://open.feishu.cn/open-apis';

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

function extractDocumentId(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/dox[a-zA-Z0-9]+/);
  if (match) return match[0];
  return trimmed;
}

function sanitizeFilename(name) {
  return name
    .replace(/[\\/\n\r\t\0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

async function readToken() {
  const raw = await fs.readFile(TOKEN_PATH, 'utf8');
  const token = raw.trim();
  if (!token) {
    throw new Error('user-token.txt is empty. Run npm run auth first.');
  }
  return token;
}

async function apiGet(path, token, query = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const data = await response.json();
  if (data.code !== 0) {
    const message = data.msg || data.error_description || data.error || 'Unknown error';
    throw new Error(`API error (${data.code}): ${message}`);
  }

  return data.data ?? data;
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

async function main() {
  const docInput = await ask('Doc URL or ID: ');
  if (!docInput) {
    console.error('Document URL or ID is required.');
    process.exit(1);
  }

  const documentId = extractDocumentId(docInput);
  const token = await readToken();

  const documentInfo = await apiGet(`/docx/v1/documents/${documentId}`, token);
  const metadata = documentInfo.document || documentInfo;
  const blocks = await fetchAllBlocks(documentId, token);

  const markdown = feishuToMarkdown({ metadata, blocks });
  const title = metadata.title || documentId;
  const filename = `${sanitizeFilename(title) || documentId}.md`;

  await fs.writeFile(filename, markdown, 'utf8');
  console.log(`Saved ${filename}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
