import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..', '..');
const publicSrc = path.join(root, 'public');
const publicDst = path.join(__dirname, 'public');

async function main() {
  await rm(publicDst, { recursive: true, force: true });
  await mkdir(publicDst, { recursive: true });
  await cp(publicSrc, publicDst, { recursive: true });
  console.log(`[tizen] Copied ${publicSrc} -> ${publicDst}`);
  console.log('[tizen] Next: run Tizen CLI packaging/signing to produce .wgt');
}

main().catch((err) => {
  console.error('[tizen] Prepare failed:', err);
  process.exit(1);
});
