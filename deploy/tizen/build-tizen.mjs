#!/usr/bin/env node
/**
 * Automated Tizen .wgt build (+ optional install / launch).
 *
 * Fixes the long-standing install failure where `tizen package` names the
 * widget from config.xml's <name> ("SageTV MiniClient") — which contains a
 * space — and `tizen install -n 'SageTV MiniClient.wgt'` then fails. This
 * script renames the freshly produced widget to a space-free filename
 * automatically, so the whole prepare -> package -> install -> run flow is a
 * single command.
 *
 * Usage:
 *   node deploy/tizen/build-tizen.mjs               # prepare + package + rename
 *   node deploy/tizen/build-tizen.mjs --install     # also install to the TV
 *   node deploy/tizen/build-tizen.mjs --install --run
 *
 * Config resolution order per value: env var > tizen.local.json > placeholder.
 * Copy tizen.local.example.json -> tizen.local.json (gitignored) and fill in
 * your own values. Keys / env vars:
 *   cli    / TIZEN_CLI     path to tizen(.bat)
 *   sdb    / TIZEN_SDB     path to sdb(.exe)
 *   cert   / TIZEN_CERT    Samsung signing profile name
 *   target / TIZEN_TARGET  sdb device name (from `sdb devices`)
 *   serial / TIZEN_SERIAL  sdb connect target, <TV_IP>:26101
 *   appid  / TIZEN_APPID   application id (matches config.xml)
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, renameSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');

// Local, gitignored overrides so a real TV IP / device name / signing profile
// never land in the repo. Copy tizen.local.example.json -> tizen.local.json and
// fill in your values, or set the matching TIZEN_* env vars. Precedence:
// env var > tizen.local.json > placeholder default.
let local = {};
try {
  const lp = path.join(__dirname, 'tizen.local.json');
  if (existsSync(lp)) local = JSON.parse(readFileSync(lp, 'utf8'));
} catch (e) {
  console.warn('[tizen] Could not read tizen.local.json:', e.message);
}
const cfg = (env, key, fallback) => process.env[env] || local[key] || fallback;

const CLI = cfg('TIZEN_CLI', 'cli', 'C:\\tizen-studio\\tools\\ide\\bin\\tizen.bat');
const SDB = cfg('TIZEN_SDB', 'sdb', 'C:\\tizen-studio\\tools\\sdb.exe');
const CERT = cfg('TIZEN_CERT', 'cert', 'CERT_PROFILE');
const TARGET = cfg('TIZEN_TARGET', 'target', '');
const SERIAL = cfg('TIZEN_SERIAL', 'serial', '');
const APPID = cfg('TIZEN_APPID', 'appid', 'Pwasagetvm.SageTVMiniClient');
const WGT_NAME = 'SageTVMiniClient.wgt';

const args = new Set(process.argv.slice(2));
const doInstall = args.has('--install') || args.has('--deploy');
const doRun = args.has('--run');

function run(cmd, cmdArgs, opts = {}) {
  // Build a single quoted command string and run it through the shell. Passing
  // one string (rather than an args array) with shell:true avoids Node's
  // DEP0190 warning; args with spaces are quoted defensively.
  const quote = (a) => (/\s/.test(a) ? `"${a}"` : a);
  const line = [cmd, ...cmdArgs].map(quote).join(' ');
  console.log(`\n$ ${line}`);
  const r = spawnSync(line, { stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) {
    throw new Error(`Command failed (exit ${r.status}): ${line}`);
  }
}

async function prepare() {
  const publicSrc = path.join(root, 'public');
  const publicDst = path.join(__dirname, 'public');
  await rm(publicDst, { recursive: true, force: true });
  await mkdir(publicDst, { recursive: true });
  await cp(publicSrc, publicDst, { recursive: true });
  console.log(`[tizen] Staged ${publicSrc} -> ${publicDst}`);
}

function listWgts() {
  return readdirSync(__dirname).filter((f) => f.toLowerCase().endsWith('.wgt'));
}

function packageWgt() {
  // Clear stale .wgt files so we can reliably detect the fresh output.
  for (const f of listWgts()) rmSync(path.join(__dirname, f), { force: true });

  run(CLI, ['package', '-t', 'wgt', '-s', CERT, '--', '.'], { cwd: __dirname });

  // Rename the freshly produced (possibly space-named) widget to space-free.
  const produced = listWgts()
    .map((f) => ({ f, m: statSync(path.join(__dirname, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!produced.length) throw new Error('No .wgt produced by `tizen package`');

  const src = path.join(__dirname, produced[0].f);
  const dst = path.join(__dirname, WGT_NAME);
  if (src !== dst) {
    if (existsSync(dst)) rmSync(dst, { force: true });
    renameSync(src, dst);
  }
  console.log(`[tizen] Packaged -> ${dst}`);
  return dst;
}

function install() {
  if (!SERIAL || !TARGET) {
    throw new Error(
      'Device not configured. Set TIZEN_SERIAL (e.g. 1.2.3.4:26101) and ' +
      'TIZEN_TARGET (sdb device name from `sdb devices`) via env vars or ' +
      'deploy/tizen/tizen.local.json (see tizen.local.example.json).');
  }
  run(SDB, ['connect', SERIAL]);
  run(CLI, ['install', '-n', WGT_NAME, '-t', TARGET], { cwd: __dirname });
}

function launch() {
  run(CLI, ['run', '-p', APPID, '-t', TARGET], { cwd: __dirname });
}

async function main() {
  await prepare();
  packageWgt();
  if (doInstall) install();
  if (doRun) launch();
  console.log('\n[tizen] Done.');
}

main().catch((err) => {
  console.error('[tizen] Build failed:', err.message);
  process.exit(1);
});
