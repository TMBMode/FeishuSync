import fs from 'node:fs/promises';
import { readConfig, requireConfigValue, resolvePath } from '../config.js';
import { readToken } from '../api/helpers.js';
import { createDocumentFromMarkdown } from '../api/feishu.js';

if (typeof fetch !== 'function') {
  console.error('This CLI requires Node.js 18+ (global fetch).');
  process.exit(1);
}

async function main() {
  const config = await readConfig();
  const inputPathArg = process.argv[2];
  if (!inputPathArg) {
    console.error('Usage: npm run upload <markdown-file>');
    process.exit(1);
  }
  const inputPath = resolvePath(inputPathArg);
  const wikiSpaceId = requireConfigValue(config, 'wikiSpaceId');
  const tokenPath = resolvePath(requireConfigValue(config, 'tokenPath'));

  const markdown = await fs.readFile(inputPath, 'utf8');
  const token = await readToken(tokenPath);

  const documentId = await createDocumentFromMarkdown(wikiSpaceId, token, markdown);
  console.log(`Uploaded document: ${documentId}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
