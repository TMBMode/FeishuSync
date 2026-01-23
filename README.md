# Feishu FS

Feishu FS is a CLI tool that bridges Feishu Docs/Wiki with a local folder. It can authenticate a user, fetch and convert documents, and keep a wiki space in sync with Markdown files on disk.

## Requirements
- Node.js 18+ (uses the global `fetch` API)
- A Feishu app with user authorization enabled (client ID/secret)
- A Wiki Space ID you have access to

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Create your config:
   ```bash
   cp config.example.json config.json
   ```
3. Edit `config.json` with your Feishu credentials and space ID.

## Quick start (preferred)
Use the bundled start/stop helpers to keep auth + sync running in the background:
```bash
npm start
# later...
npm stop
```

## Configuration
`config.json` supports:

```json
{
  "tokenPath": "./user-token.txt",
  "wikiSpaceId": "1234567890",
  "auth": {
    "clientId": "cli_abc123",
    "clientSecret": "abcABC123"
  },
  "sync": {
    "folderPath": "wikid",
    "pollIntervalSeconds": 30,
    "initialSync": true
  }
}
```

Notes:
- `tokenPath` is where the auth script writes the user access token.
- `sync.folderPath` is the local folder for Markdown files.
- `pollIntervalSeconds` can be `0`/`false` to disable polling; realtime updates still use websockets.
- You can also set `FEISHU_APP_ID` / `FEISHU_APP_SECRET` to override `auth.clientId` / `auth.clientSecret`.

## Commands
All commands are available as npm scripts:

- `npm run auth`  
  Starts a local auth server, opens a browser, and writes the access token to `tokenPath`.

- `npm run list`  
  Lists the wiki space tree (title + document token).

- `npm run fetch <doc-url-or-id>`  
  Prints a document’s metadata and blocks JSON to stdout.

- `npm run download <doc-url-or-id>`  
  Downloads a document as Markdown into the current directory.

- `npm run upload <markdown-file>`  
  Creates a new document in the configured wiki space from a Markdown file.

- `npm run convert to-md <json-file|->`  
  Converts Feishu JSON (from `fetch`) to Markdown. Use `-` to read from stdin.

- `npm run convert to-feishu <markdown-file|->`  
  Converts Markdown to Feishu JSON.

- `npm run update`  
  One-shot bidirectional sync between the wiki space and local folder.
  - Creates `.feishu-sync.json` in the sync folder to track hashes/revisions.
  - If both local and remote changed, the remote copy is saved as `*.remote.md`.

- `npm run sync`  
  Realtime sync with websockets + optional polling. Also watches the local folder for changes.

- `npm start` / `npm stop`  
  Convenience wrapper to run `auth` and `sync` as detached background processes.

## Example workflow
```bash
# Authenticate
npm run auth

# One-time sync
npm run update

# Continuous sync
npm run sync
```

## Troubleshooting
- If you see “Token file is empty”, run `npm run auth` again.
- If sync fails to start, verify `wikiSpaceId` and the app credentials in `config.json`.
