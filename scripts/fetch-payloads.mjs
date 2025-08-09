import { mkdirp } from 'fs-extra/esm';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const payloads = path.join(root, 'payloads');

const targets = [
  // Node.js LTS win-x64
  {
    name: 'node',
    out: path.join(payloads, 'node', 'node.zip'),
    url: process.env.NODE_ZIP_URL || 'https://nodejs.org/dist/v20.12.2/node-v20.12.2-win-x64.zip',
  },
  // PHP TS build for Windows (zip)
  {
    name: 'php',
    out: path.join(payloads, 'php', 'php.zip'),
    url: process.env.PHP_ZIP_URL || 'https://windows.php.net/downloads/releases/php-8.2.29-Win32-vs16-x64.zip',
  },
  // Composer phar (saved into php folder so installer can find it)
  {
    name: 'composer',
    out: path.join(payloads, 'php', 'composer.phar'),
    url: process.env.COMPOSER_PHAR_URL || 'https://getcomposer.org/composer-stable.phar',
  },
  // Yualan app source zip
  {
    name: 'app',
    out: path.join(payloads, 'app', 'app.zip'),
    url: process.env.APP_ZIP_URL || 'https://github.com/Abdurozzaq/Yualan/archive/refs/tags/pre-alpha-1.3.zip',
  },
  // Apache and PostgreSQL with defaults; override via env for mirrors
  {
    name: 'apache',
    out: path.join(payloads, 'apache', 'apache.zip'),
    url: process.env.APACHE_ZIP_URL || 'https://www.apachelounge.com/download/VS17/binaries/httpd-2.4.65-250724-Win64-VS17.zip',
  },
  {
    name: 'postgres',
    out: path.join(payloads, 'postgres', 'postgres.zip'),
    url: process.env.POSTGRES_ZIP_URL || 'https://get.enterprisedb.com/postgresql/postgresql-15.2-1-windows-x64-binaries.zip',
  },
].filter(Boolean);

function download(url, out, redirects = 0) {
  return new Promise(async (resolve, reject) => {
    await mkdirp(path.dirname(out));
    const file = fs.createWriteStream(out);
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      const status = res.statusCode || 200;
      if (status >= 300 && status < 400 && res.headers.location) {
        if (redirects > 5) { reject(new Error('Too many redirects')); return; }
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).toString();
        res.resume();
        file.close(() => fs.unlink(out, () => download(next, out, redirects + 1).then(resolve, reject)));
        return;
      }
      if (status >= 400) {
        reject(new Error(`Download failed ${status} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    });
    req.on('error', (err) => fs.unlink(out, () => reject(err)));
  });
}

(async () => {
  for (const t of targets) {
    const exists = fs.existsSync(t.out);
    if (exists) { console.log(`[skip] ${t.name} already at ${t.out}`); continue; }
    console.log(`[get] ${t.name} -> ${t.out}`);
    try {
      await download(t.url, t.out);
      console.log(`[ok] ${t.name}`);
    } catch (e) {
      console.error(`[fail] ${t.name}:`, e.message);
    }
  }
})();
