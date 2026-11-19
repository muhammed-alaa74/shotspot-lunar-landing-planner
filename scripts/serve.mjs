import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`SHOTSPOT requires Node.js 22.12+ (found ${process.version}).`);
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = path.join(root, 'ready-to-run');
const sourceBuild = path.join(root, 'frontend', 'dist', 'frontend', 'browser');
const portValue = process.env.PORT ?? process.argv[2] ?? '4200';
const port = Number(portValue);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid PORT: ${portValue}. Choose an integer from 1 to 65535.`);
  process.exit(1);
}

let webRoot = packaged;
try {
  await access(path.join(webRoot, 'index.html'));
} catch {
  try {
    await access(path.join(sourceBuild, 'index.html'));
    webRoot = sourceBuild;
    console.warn('ready-to-run/ was not found; serving frontend/dist/frontend/browser instead.');
  } catch {
    console.error('No browser build found. Expected ready-to-run/index.html.');
    console.error('Create it with: npm run build');
    process.exit(1);
  }
}

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.avif', 'image/avif'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.map', 'application/json; charset=utf-8'],
  ['.bin', 'application/octet-stream'],
]);

const isAppRoute = (pathname) =>
  pathname === '/' ||
  pathname === '/mission' ||
  pathname === '/demo' ||
  pathname === '/planner' ||
  pathname === '/about' ||
  /^\/plan(?:\/.*)?$/.test(pathname);

const safePath = (pathname) => {
  if (pathname.includes('\\') || pathname.includes('\0')) return null;
  const relative = pathname.replace(/^\/+/, '');
  const absolute = path.resolve(webRoot, relative);
  const relativeToRoot = path.relative(webRoot, absolute);
  if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    return null;
  }
  return absolute;
};

const sendText = (response, status, message) => {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(message);
};

const server = http.createServer(async (request, response) => {
  // Relative API URLs work identically in the packaged app and Angular development.
  if ((request.url ?? '').startsWith('/api/')) {
    const upstream = http.request({ hostname: '127.0.0.1', port: Number(process.env.COPILOT_API_PORT ?? 8000),
      method: request.method, path: request.url, headers: { 'content-type': request.headers['content-type'] ?? 'application/json',
        ...(request.headers['content-length'] ? { 'content-length': request.headers['content-length'] } : {}) } }, result => {
      response.writeHead(result.statusCode ?? 502, { 'Content-Type': result.headers['content-type'] ?? 'application/json', 'Cache-Control': 'no-store' });
      result.pipe(response);
    });
    upstream.setTimeout(145000, () => upstream.destroy());
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ detail: 'Copilot backend is not running. Start FastAPI and retry.' })); });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendText(response, 405, 'Method Not Allowed\n');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  } catch {
    sendText(response, 400, 'Bad Request\n');
    return;
  }

  const requestedPath = safePath(pathname);
  if (!requestedPath) {
    sendText(response, 400, 'Bad Request\n');
    return;
  }

  let filePath = requestedPath;
  let fileStat;
  try {
    fileStat = await stat(filePath);
    if (fileStat.isDirectory()) filePath = path.join(filePath, 'index.html');
    fileStat = await stat(filePath);
  } catch {
    if (isAppRoute(pathname)) {
      filePath = path.join(webRoot, 'index.html');
      try {
        fileStat = await stat(filePath);
      } catch {
        sendText(response, 500, 'Missing application entrypoint\n');
        return;
      }
    } else {
      sendText(response, 404, 'Not Found\n');
      return;
    }
  }

  if (!fileStat.isFile()) {
    sendText(response, 404, 'Not Found\n');
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    'Content-Type': mimeTypes.get(extension) ?? 'application/octet-stream',
    'Content-Length': fileStat.size,
    'Cache-Control': 'no-cache',
  });
  if (request.method === 'HEAD') {
    response.end();
  } else {
    createReadStream(filePath).pipe(response);
  }
});

server.on('error', (error) => {
  console.error(`Could not start server on port ${port}: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`SHOTSPOT serving ${path.relative(root, webRoot)}/`);
  console.log(`Open http://localhost:${port}/`);
  console.log('Press Ctrl+C to stop.');
});
