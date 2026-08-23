import { cp, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..', '..');
const publicSrc = path.join(root, 'public');
const publicDst = path.join(__dirname, 'public');

/*
 * Critical-function guardrails — abort the build if any required symbol
 * is missing from the staged source files.  Add entries here whenever a
 * "silently lost" regression is discovered.
 */
const REQUIRED_SYMBOLS = [
  { file: 'js/protocol/connection.js', symbols: [
    '_getTizenPanelResolution',
    '_getDisplaySinkResolution',
  ]},
  { file: 'js/media/avplay-player.js', symbols: [
    '_bridgeSessionId',
    '_phoneHome',
  ]},
  { file: 'js/media/codec-probe.js', symbols: [
    'Phase 3',
  ]},
];

// Privileges required in config.xml for Tizen APIs to work
const REQUIRED_PRIVILEGES = [
  'http://developer.samsung.com/privilege/productinfo',  // isUdPanelSupported() for 4K panel detection
  'http://tizen.org/privilege/tv.display',                // display resolution APIs
];


async function validateSources() {
  const errors = [];
  for (const { file, symbols } of REQUIRED_SYMBOLS) {
    const absPath = path.join(publicSrc, file);
    let content;
    try {
      content = await readFile(absPath, 'utf-8');
    } catch (e) {
      errors.push(`  MISSING FILE: ${file}`);
      continue;
    }
    // Detect UTF-16 BOM — indicates a corrupted pull
    if (content.charCodeAt(0) === 0xFFFE || content.charCodeAt(0) === 0xFEFF) {
      errors.push(`  UTF-16 BOM detected: ${file} — re-pull with scp/docker cp, not shell redirect`);
    }
    for (const sym of symbols) {
      if (!content.includes(sym)) {
        errors.push(`  ${file}: missing required symbol "${sym}"`);
      }
    }
  }
  // Validate config.xml privileges
  const configPath = path.join(__dirname, 'config.xml');
  try {
    const configContent = await readFile(configPath, 'utf-8');
    for (const priv of REQUIRED_PRIVILEGES) {
      if (!configContent.includes(priv)) {
        errors.push(`  config.xml: missing required privilege "${priv}"`);
      }
    }
  } catch (e) {
    errors.push(`  MISSING FILE: config.xml`);
  }

  if (errors.length) {
    console.error('[tizen] ❌ PRE-DEPLOY VALIDATION FAILED — aborting build:');
    errors.forEach(e => console.error(e));
    console.error('[tizen] These symbols are required for correct Tizen operation.');
    console.error('[tizen] If source was overwritten, pull from server:');
    console.error('[tizen]   ssh <SSH_USER>@<SERVER_IP> "docker cp <CONTAINER>:/opt/sagetv/server/pwa-miniclient/public/<file> /tmp/f"');
    console.error('[tizen]   scp <SSH_USER>@<SERVER_IP>:/tmp/f public/<file>');
    process.exit(1);
  }
  console.log(`[tizen] ✅ Pre-deploy validation passed (${REQUIRED_SYMBOLS.reduce((n, r) => n + r.symbols.length, 0)} symbols, ${REQUIRED_PRIVILEGES.length} privileges verified)`);
}

async function main() {
  await validateSources();
  await rm(publicDst, { recursive: true, force: true });
  await mkdir(publicDst, { recursive: true });
  await cp(publicSrc, publicDst, { recursive: true });
  console.log(`[tizen] Staged ${publicSrc} -> ${publicDst}`);
}

main().catch((err) => {
  console.error('[tizen] Prepare failed:', err);
  process.exit(1);
});
