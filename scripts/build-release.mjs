import { cp, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'frontend', 'dist', 'frontend', 'browser');
const destination = path.join(root, 'ready-to-run');

try {
  await access(path.join(source, 'index.html'));
} catch {
  console.error(`Build output not found: ${source}`);
  console.error('Run the Angular production build first, for example: npm --prefix frontend run build');
  process.exit(1);
}

await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
console.log(`Copied Angular browser build to ${path.relative(root, destination)}/`);
