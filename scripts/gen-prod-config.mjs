/**
 * Generate wrangler.prod.toml from environment variables at build time.
 *
 * Why this exists: the repository must not contain the live event code, the
 * couple's names or the Drive folder id, but the deploy needs them. Cloudflare
 * Workers Builds exposes build-time variables to the build command, so the CI
 * job generates the private config from them and deploys with it. The file is
 * gitignored, so it never reaches the repository.
 *
 *   EVENT_CODE=... EVENT_NAMES=... DRIVE_FOLDER_ID=... node scripts/gen-prod-config.mjs
 *
 * Refuses to write anything if a value is missing, which turns a half-configured
 * build into a red build instead of an album that nobody can open.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = ['EVENT_CODE', 'EVENT_NAMES', 'DRIVE_FOLDER_ID'];

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[prod-config] missing environment variable(s): ${missing.join(', ')}`);
  console.error('[prod-config] refusing to write a config that would open or break the album');
  process.exit(1);
}

const source = readFileSync(path.join(root, 'wrangler.toml'), 'utf8');

let out = source;
for (const key of REQUIRED) {
  const value = process.env[key];
  const re = new RegExp(`^${key}\\s*=\\s*".*".*$`, 'm');
  if (!re.test(out)) {
    console.error(`[prod-config] ${key} is not present in wrangler.toml`);
    process.exit(1);
  }
  out = out.replace(re, `${key} = "${value.replace(/"/g, '\\"')}"`);
}

const target = path.join(root, 'wrangler.prod.toml');
writeFileSync(target, out, 'utf8');

const mask = (v) => `${v.slice(0, 3)}…${v.slice(-2)} (len ${v.length})`;
console.log(`[prod-config] wrote ${path.basename(target)}`);
console.log(`  EVENT_CODE      ${mask(process.env.EVENT_CODE)}`);
console.log(`  EVENT_NAMES     ${mask(process.env.EVENT_NAMES)}`);
console.log(`  DRIVE_FOLDER_ID ${mask(process.env.DRIVE_FOLDER_ID)}`);
