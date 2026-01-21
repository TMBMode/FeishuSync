const fs = require('fs/promises');
const readline = require('readline');

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

function formatNodeLine(node, indent) {
  const title = node.title || node.name || '(untitled)';
  const nodeToken = node.node_token || node.nodeToken || '';
  return `${'  '.repeat(indent)}- ${title} ${nodeToken}`;
}

async function listNodes(spaceId, token, parentNodeToken, indent) {
  const nodes = await fetchWikiNodes(spaceId, token, parentNodeToken);
  for (const node of nodes) {
    console.log(formatNodeLine(node, indent));
    const hasChild = node.has_child ?? node.hasChild;
    if (hasChild) {
      const nodeToken = node.node_token || node.nodeToken;
      if (nodeToken) {
        await listNodes(spaceId, token, nodeToken, indent + 1);
      }
    }
  }
}

async function main() {
  const input = await ask(`Wiki space ID (default ${WIKI_SPACE_ID}): `);
  const spaceId = input || WIKI_SPACE_ID;
  const token = await readToken();

  await listNodes(spaceId, token, undefined, 0);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
