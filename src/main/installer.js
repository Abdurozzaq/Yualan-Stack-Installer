const path = require('path');
const os = require('os');
const fs = require('fs');
const fse = require('fs-extra');
const net = require('net');
const crypto = require('crypto');
const { DownloaderHelper } = require('node-downloader-helper');
const extract = require('extract-zip');
const Handlebars = require('handlebars');
const { spawn } = require('child_process');
const treeKill = require('tree-kill');

// State
let processes = {
  postgres: null,
  laravel: null,
  queue: null,
  scheduler: null,
};

// Handle both development and portable/ASAR scenarios
function getResourcePath(relativePath) {
  if (process.env.NODE_ENV === 'development' || !process.resourcesPath) {
    // Development mode - use relative paths from __dirname
    return path.resolve(__dirname, relativePath);
  } else {
    // Portable/packaged mode - use app.asar.unpacked or resources path
    const resourcesPath = process.resourcesPath;
    const unpackedPath = path.join(resourcesPath, 'app.asar.unpacked', relativePath.replace(/^\.\.\/\.\.\//, ''));
    const asarPath = path.join(resourcesPath, 'app', relativePath.replace(/^\.\.\/\.\.\//, ''));
    const regularPath = path.join(resourcesPath, relativePath.replace(/^\.\.\/\.\.\//, ''));
    
    // Try unpacked first, then regular resources path
    if (fs.existsSync(unpackedPath)) return unpackedPath;
    if (fs.existsSync(regularPath)) return regularPath;
    if (fs.existsSync(asarPath)) return asarPath;
    
    // Fallback to original logic
    return path.resolve(__dirname, relativePath);
  }
}

const payloadBase = getResourcePath('../../payloads');
const templatesBase = getResourcePath('../../templates');

// Debug logging for portable mode
console.log('[Installer Debug] __dirname:', __dirname);
console.log('[Installer Debug] process.resourcesPath:', process.resourcesPath);
console.log('[Installer Debug] NODE_ENV:', process.env.NODE_ENV);
console.log('[Installer Debug] payloadBase:', payloadBase);
console.log('[Installer Debug] templatesBase:', templatesBase);
console.log('[Installer Debug] payloadBase exists:', fs.existsSync(payloadBase));
console.log('[Installer Debug] templatesBase exists:', fs.existsSync(templatesBase));

function emit(progress, evt) {
  if (typeof progress === 'function') progress(evt);
}

function renderTemplate(file, data) {
  const source = fs.readFileSync(file, 'utf8');
  const template = Handlebars.compile(source);
  return template(data);
}

function isLikelyZip(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    // ZIP magic: PK\x03\x04 or empty archive PK\x05\x06
    const a = buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
    const b = buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x05 && buf[3] === 0x06;
    return a || b;
  } catch (_) {
    return false;
  }
}

async function findBinary(baseDir, candidates, maxDepth = 4) {
  const seen = new Set();
  async function walk(dir, depth) {
    if (depth > maxDepth) return null;
    let list;
    try { list = await fse.readdir(dir); } catch { return null; }
    for (const name of list) {
      const full = path.join(dir, name);
      if (seen.has(full)) continue; seen.add(full);
      let stat;
      try { stat = await fse.stat(full); } catch { continue; }
      if (stat.isFile()) {
        if (candidates.some(c => name.toLowerCase() === c.toLowerCase())) return full;
      } else if (stat.isDirectory()) {
        const hit = await walk(full, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }
  return walk(baseDir, 0);
}

async function ensureZipExtract(zipPath, targetDir) {
  try {
    console.log(`[Extract Debug] zipPath: ${zipPath}`);
    console.log(`[Extract Debug] targetDir: ${targetDir}`);
    console.log(`[Extract Debug] zipPath exists: ${fs.existsSync(zipPath)}`);
    console.log(`[Extract Debug] targetDir parent exists: ${fs.existsSync(path.dirname(targetDir))}`);
    
    await fse.ensureDir(targetDir);
    console.log(`[Extract Debug] ensureDir completed for: ${targetDir}`);
    
    await extract(zipPath, { dir: targetDir });
    console.log(`[Extract Debug] extraction completed`);
  } catch (error) {
    console.error(`[Extract Error] Failed to extract ${zipPath} to ${targetDir}:`, error);
    throw new Error(`Extract failed: ${error.message}`);
  }
}

async function downloadIfMissing(url, destDir, fileName, progress) {
  await fse.ensureDir(destDir);
  const dest = path.join(destDir, fileName);
  if (await fse.pathExists(dest)) return dest;

  emit(progress, { stage: 'download', message: `Downloading ${fileName}...` });
  const dl = new DownloaderHelper(url, destDir, { fileName });
  dl.on('progress', (stats) => emit(progress, { stage: 'download', progress: stats.progress }));
  await dl.start().catch((e) => { throw new Error(`Download failed: ${e.message}`); });
  return dest;
}

// Setup Server: install PHP, Apache, Node.js, PostgreSQL and prepare DB/user
async function setupServer(options, progress) {
  const installDir = options.installDir;
  const appDir = path.join(installDir, 'app');
  const stackDir = path.join(installDir, 'stack');
  const phpDir = path.join(stackDir, 'php');
  // Apache removed; we'll use php artisan serve for the app
  const nodeDir = path.join(stackDir, 'node');
  const pgDir = path.join(stackDir, 'postgres');

  await fse.ensureDir(installDir);
  await fse.ensureDir(appDir);
  await fse.ensureDir(stackDir);

  // 1) Lay down payloads (server components only)
  const defaultUrls = {
    php: 'https://yualan.web.id/php-8.2.29-Win32-vs16-x64.zip',
    node: 'https://nodejs.org/dist/v20.12.2/node-v20.12.2-win-x64.zip',
    postgres: 'https://get.enterprisedb.com/postgresql/postgresql-15.2-1-windows-x64-binaries.zip',
  };
  const plan = [
    { key: 'php', url: options.phpUrl || defaultUrls.php, localZip: options.phpZip, destDir: phpDir, zipName: 'php.zip' },
    { key: 'node', url: options.nodeUrl || defaultUrls.node, localZip: options.nodeZip, destDir: nodeDir, zipName: 'node.zip' },
    { key: 'postgres', url: options.postgresUrl || defaultUrls.postgres, localZip: options.postgresZip, destDir: pgDir, zipName: 'postgres.zip' },
  ];

  for (const item of plan) {
    const bucket = path.join(payloadBase, item.key);
    const bundledZip = path.join(bucket, item.zipName);
    let zipToUse = null;

    // 1) Prefer user-provided zip
    if (item.localZip && await fse.pathExists(item.localZip)) {
      if (isLikelyZip(item.localZip)) zipToUse = item.localZip;
      else emit(progress, { stage: 'warn', message: `${item.key} zip appears invalid: ${item.localZip}` });
    }
    // 2) Bundled zip under payloads
    if (!zipToUse && await fse.pathExists(bundledZip)) {
      if (isLikelyZip(bundledZip)) zipToUse = bundledZip;
      else {
        emit(progress, { stage: 'warn', message: `${item.key} zip in payloads looks corrupt, redownloading...` });
        try { await fse.remove(bundledZip); } catch (_) {}
      }
    }
    // 3) Download if we still don't have a valid zip and URL is available
    if (!zipToUse && item.url) {
      const zipPath = await downloadIfMissing(item.url, bucket, item.zipName, progress);
      if (isLikelyZip(zipPath)) zipToUse = zipPath;
      else emit(progress, { stage: 'error', message: `Downloaded ${item.key} is not a valid zip: ${zipPath}` });
    }

    if (zipToUse) {
      emit(progress, { stage: 'extract', message: `Extracting ${item.key}...` });
      await ensureZipExtract(zipToUse, item.destDir);
    } else {
      emit(progress, { stage: 'skip', message: `Skip ${item.key} (no valid zip found)` });
    }
  }

  // If composer.phar exists in payloads/php, copy into extracted php dir
  const payloadComposer = path.join(payloadBase, 'php', 'composer.phar');
  if (await fse.pathExists(payloadComposer)) {
    try {
      await fse.copy(payloadComposer, path.join(phpDir, 'composer.phar'));
      emit(progress, { stage: 'composer', message: 'composer.phar copied from payloads.' });
    } catch (_) {}
  }

  // Resolve real roots in case zips contain nested folders
  const roots = await resolveRoots({ phpDir, apacheDir: path.join(stackDir, 'apache'), nodeDir, pgDir });

  // Render php.ini to enable required extensions
  const phpIniTpl = path.join(templatesBase, 'php', 'php.ini.hbs');
  if (await fse.pathExists(phpIniTpl) && roots.phpRoot) {
    const phpIni = renderTemplate(phpIniTpl, {
      phpExtDir: path.join(roots.phpRoot, 'ext').replace(/\\/g, '/'),
    });
    await fse.writeFile(path.join(roots.phpRoot, 'php.ini'), phpIni, 'utf8');
  }

  // PostgreSQL initdb (if empty data dir)
  const pgDataDir = roots.pgRoot ? path.join(roots.pgRoot, 'data') : path.join(pgDir, 'data');
  await fse.ensureDir(pgDataDir);
  // Initialize PG and provision role/db
  const env = makeEnvFromRoots(process.env, roots);
  // Choose an available port (scan a small range to avoid conflicts like 5432/5433 both taken)
  const preferred = Number(options?.pgPort) || 5432;
  let port = preferred;
  
  // Check if preferred port is available, attempt to free it if busy
  const portFree = await isPortFree(preferred);
  if (!portFree) {
    emit(progress, { stage: 'postgres', message: `Port ${preferred} is busy, attempting to free it...` });
    const killed = await killPortProcess(preferred, progress);
    
    if (killed && await isPortFree(preferred)) {
      port = preferred;
      emit(progress, { stage: 'postgres', message: `Port ${preferred} is now free` });
    } else {
      // Find alternative port if can't free the preferred one
      for (let i = 1; i <= 20; i++) {
        const candidate = preferred + i;
        if (await isPortFree(candidate).catch(() => true)) { 
          port = candidate; 
          emit(progress, { stage: 'postgres', message: `Using alternative port ${port}` });
          break; 
        }
      }
    }
  }
  
  if (port !== preferred) emit(progress, { stage: 'postgres', message: `Preferred port ${preferred} was busy, using ${port} for provisioning.` });
  const pgVersionFile = path.join(pgDataDir, 'PG_VERSION');
  if (!(await fse.pathExists(pgVersionFile))) {
    emit(progress, { stage: 'postgres', message: 'Initializing PostgreSQL data directory...' });
    await runInitdb(roots.pgRoot || pgDir, pgDataDir, env, progress);
    await writePgHba(pgDataDir, progress);
  }
  await writePgHba(pgDataDir, progress);
  // Clean up potential stale postmaster.pid if no server is actually running
  try {
    const pidFile = path.join(pgDataDir, 'postmaster.pid');
    const stat = await fse.stat(pidFile).catch(() => null);
    if (stat) {
      const ageMs = Date.now() - stat.mtimeMs;
      const portFree = await isPortFree(port).catch(() => true);
      if (ageMs > 60_000 && portFree) {
        // Best-effort: remove stale lock if it's old and no one is listening on our chosen port
        await fse.remove(pidFile).catch(() => {});
        emit(progress, { stage: 'postgres', message: 'Removed stale postmaster.pid before start.' });
      }
    }
  } catch (_) {}
  const pgCtl = await findBinary(path.join(roots.pgRoot || pgDir, 'bin'), ['pg_ctl.exe', 'pg_ctl']);
  if (!pgCtl) throw new Error('pg_ctl not found');
  await fse.ensureDir(path.join(roots.pgRoot || pgDir, 'logs'));
  const serverLog = path.join(roots.pgRoot || pgDir, 'logs', 'server.log');
  const startArgs = ['start', '-w', '-t', '60', '-D', pgDataDir, '-l', serverLog, '-o', `-c port=${port} -c listen_addresses=127.0.0.1`];
  emit(progress, { stage: 'postgres', message: 'Starting PostgreSQL (temporary)...' });
  const startRes = await runCommand(pgCtl, startArgs, { env, progress, stage: 'postgres', logPrefix: 'pg_ctl start', timeoutMs: 70000, quiet: true });
  if (startRes.code !== 0) {
    const logs = await readBestPgLogs(pgDataDir, path.dirname(serverLog));
    emit(progress, { stage: 'postgres', log: `pg_ctl start failed. Logs:\n${logs}` });
    throw new Error('PostgreSQL failed to start');
  }
  const ok = await waitForPostgres(roots.pgRoot || pgDir, port, env, progress, { retries: 90, delayMs: 1000 });
  if (!ok) {
    const logs = await readBestPgLogs(pgDataDir, path.dirname(serverLog));
    emit(progress, { stage: 'postgres', log: `PostgreSQL did not become ready. Logs:\n${logs}` });
    throw new Error('PostgreSQL not ready');
  }
  emit(progress, { stage: 'postgres', message: 'PostgreSQL ready. Provisioning role and database...' });
  const dbUser = options.pgUser || 'yualan';
  const dbPass = options.pgPassword || 'yualan';
  const dbName = options.pgDatabase || 'yualan';
  await ensureRoleDb(roots.pgRoot || pgDir, port, { user: dbUser, password: dbPass, database: dbName }, env, progress);
  await ensureDbPrivileges(roots.pgRoot || pgDir, port, { user: dbUser, database: dbName }, env, progress);
  emit(progress, { stage: 'postgres', message: 'Provisioning complete.' });
  await runCommand(pgCtl, ['stop', '-D', pgDataDir, '-m', 'fast', '-t', '60'], { env, progress, stage: 'postgres', logPrefix: 'pg_ctl stop' });

  emit(progress, { stage: 'done', message: 'Server setup complete.' });
  return { ok: true };
}

// Backward-compat: original installer entrypoint now delegates to setupServer + installApp
async function install(options, progress) {
  await setupServer(options, progress);
  return installApp(options, progress);
}

async function resolveRoots({ phpDir, apacheDir, nodeDir, pgDir }) {
  const roots = { phpRoot: null, apacheRoot: null, nodeRoot: null, pgRoot: null };
  const phpExe = await findBinary(phpDir, ['php.exe', 'php']);
  if (phpExe) roots.phpRoot = path.dirname(phpExe);
  const httpdExe = await findBinary(apacheDir, ['httpd.exe', 'httpd']);
  if (httpdExe) {
    const binDir = path.dirname(httpdExe);
    roots.apacheRoot = path.basename(binDir).toLowerCase() === 'bin' ? path.dirname(binDir) : binDir;
  }
  const nodeCmd = (await findBinary(nodeDir, ['node.exe', 'npm.cmd', 'node'])) || null;
  if (nodeCmd) {
    let base = path.dirname(nodeCmd);
    // If we accidentally matched a corepack shim path, climb up to the real Node dir where node.exe lives
    const tryAscendToNode = async (dir, maxUp = 6) => {
      let cur = dir;
      for (let i = 0; i < maxUp; i++) {
        const candidate = path.join(cur, 'node.exe');
        if (await fse.pathExists(candidate)) return cur;
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
      return dir;
    };
    if (/node_modules[\\\/]corepack[\\\/]shims/i.test(base)) {
      base = await tryAscendToNode(base);
    }
    roots.nodeRoot = base;
  }
  const pgCtl = await findBinary(pgDir, ['pg_ctl.exe', 'pg_ctl']);
  if (pgCtl) {
    const binDir = path.dirname(pgCtl);
    roots.pgRoot = path.basename(binDir).toLowerCase() === 'bin' ? path.dirname(binDir) : binDir;
  }
  return roots;
}

// Detect the actual Laravel app root inside appDir, accounting for nested wrapper directories
async function resolveAppRoot(appDir, maxDepth = 5) {
  console.log(`[ResolveAppRoot Debug] Starting with appDir: ${appDir}`);
  console.log(`[ResolveAppRoot Debug] appDir exists: ${fs.existsSync(appDir)}`);
  
  // Try multiple strategies to find the Laravel root
  const strategies = [
    () => findLaravelRootByArtisan(appDir, maxDepth),
    () => findLaravelRootByComposer(appDir, maxDepth), 
    () => findLaravelRootByStructure(appDir, maxDepth),
    () => appDir // fallback to original directory
  ];
  
  for (const strategy of strategies) {
    try {
      const result = await strategy();
      if (result && result !== appDir) {
        console.log(`[ResolveAppRoot Debug] Strategy found Laravel root: ${result}`);
        
        // Validate the found directory has Laravel characteristics
        const hasLaravelFiles = await validateLaravelDirectory(result);
        if (hasLaravelFiles) {
          return result;
        }
      }
    } catch (error) {
      console.log(`[ResolveAppRoot Debug] Strategy failed: ${error.message}`);
    }
  }
  
  console.log(`[ResolveAppRoot Debug] Using fallback appDir: ${appDir}`);
  return appDir;
}

// Find Laravel root by looking for artisan file
async function findLaravelRootByArtisan(baseDir, maxDepth) {
  try {
    const artisanPath = await findBinary(baseDir, ['artisan'], maxDepth);
    if (artisanPath) {
      console.log(`[ResolveAppRoot Debug] Found artisan at: ${artisanPath}`);
      return path.dirname(artisanPath);
    }
  } catch (error) {
    console.log(`[ResolveAppRoot Debug] Artisan search failed: ${error.message}`);
  }
  return null;
}

// Find Laravel root by looking for composer.json with Laravel dependencies
async function findLaravelRootByComposer(baseDir, maxDepth) {
  const walk = async (dir, depth) => {
    if (depth > maxDepth) return null;
    
    try {
      const entries = await fse.readdir(dir, { withFileTypes: true });
      
      // Check for composer.json in current directory
      const composerFile = path.join(dir, 'composer.json');
      if (await fse.pathExists(composerFile)) {
        try {
          const composer = await fse.readJson(composerFile);
          if (composer?.require?.['laravel/framework'] || 
              composer?.require?.['illuminate/support'] ||
              (composer?.name && composer.name.includes('laravel'))) {
            console.log(`[ResolveAppRoot Debug] Found Laravel composer.json at: ${dir}`);
            return dir;
          }
        } catch (e) {
          console.log(`[ResolveAppRoot Debug] Invalid composer.json at: ${composerFile}`);
        }
      }
      
      // Recurse into subdirectories
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name.toLowerCase() !== '__macosx') {
          const result = await walk(path.join(dir, entry.name), depth + 1);
          if (result) return result;
        }
      }
    } catch (error) {
      console.log(`[ResolveAppRoot Debug] Error walking ${dir}: ${error.message}`);
    }
    return null;
  };
  
  return await walk(baseDir, 0);
}

// Find Laravel root by looking for typical Laravel directory structure
async function findLaravelRootByStructure(baseDir, maxDepth) {
  const walk = async (dir, depth) => {
    if (depth > maxDepth) return null;
    
    try {
      const entries = await fse.readdir(dir, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory()).map(e => e.name.toLowerCase());
      const files = entries.filter(e => e.isFile()).map(e => e.name.toLowerCase());
      
      // Look for typical Laravel structure
      const hasLaravelDirs = ['app', 'config', 'database', 'routes'].every(d => dirs.includes(d));
      const hasLaravelFiles = files.includes('artisan') || files.includes('composer.json');
      
      if (hasLaravelDirs && hasLaravelFiles) {
        console.log(`[ResolveAppRoot Debug] Found Laravel structure at: ${dir}`);
        return dir;
      }
      
      // Recurse into subdirectories
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name.toLowerCase() !== '__macosx') {
          const result = await walk(path.join(dir, entry.name), depth + 1);
          if (result) return result;
        }
      }
    } catch (error) {
      console.log(`[ResolveAppRoot Debug] Error checking structure in ${dir}: ${error.message}`);
    }
    return null;
  };
  
  return await walk(baseDir, 0);
}

// Validate that a directory has Laravel characteristics
async function validateLaravelDirectory(dir) {
  try {
    const hasArtisan = await fse.pathExists(path.join(dir, 'artisan'));
    const hasComposerJson = await fse.pathExists(path.join(dir, 'composer.json'));
    const hasAppDir = await fse.pathExists(path.join(dir, 'app'));
    const hasConfigDir = await fse.pathExists(path.join(dir, 'config'));
    
    // Require at least artisan OR composer.json + typical Laravel structure
    return hasArtisan || (hasComposerJson && hasAppDir && hasConfigDir);
  } catch (error) {
    console.log(`[ResolveAppRoot Debug] Validation error for ${dir}: ${error.message}`);
    return false;
  }
}

function makeEnvFromRoots(baseEnv, roots) {
  const env = { ...baseEnv };
  const addPath = [];
  if (roots.phpRoot) addPath.push(roots.phpRoot);
  if (roots.nodeRoot) addPath.push(roots.nodeRoot);
  if (roots.pgRoot) addPath.push(path.join(roots.pgRoot, 'bin'));
  env.PATH = addPath.concat(env.PATH || '').join(path.delimiter);
  return env;
}

// Resolve npm runner from Node root with multiple fallback strategies
// Priority: 1) system npm, 2) npm.cmd, 3) npm-cli.js, 4) manual npm install
async function resolveNpmRunner(nodeRoot) {
  try {
    if (!nodeRoot) return null;
    
    const nodeExe = await findBinary(nodeRoot, ['node.exe', 'node'], 0);
    if (!nodeExe) return null;

    // Strategy 1: Try system npm first (usually more reliable)
    try {
      const systemNpmTest = await runCommand('npm', ['--version'], { 
        env: process.env, 
        progress: () => {}, 
        quiet: true, 
        timeoutMs: 5000 
      });
      if (systemNpmTest.code === 0) {
        return { cmd: 'npm', prefix: [] };
      }
    } catch (_) {}

    if (process.platform === 'win32') {
      // Strategy 2: Try bundled npm.cmd
      const npmCmd = await findBinary(nodeRoot, ['npm.cmd'], 0);
      if (npmCmd) {
        try {
          const test = await runCommand(npmCmd, ['--version'], { 
            env: { ...process.env, PATH: nodeRoot + ';' + process.env.PATH }, 
            progress: () => {}, 
            quiet: true, 
            timeoutMs: 5000 
          });
          if (test.code === 0) return { cmd: npmCmd, prefix: [] };
        } catch (_) {}
      }

      // Strategy 3: Try npm-cli.js directly
      const npmCli = path.join(nodeRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (await fse.pathExists(npmCli)) {
        return { cmd: nodeExe, prefix: [npmCli] };
      }

      // Strategy 4: Try alternative npm locations
      const altPaths = [
        path.join(nodeRoot, 'npm.cmd'),
        path.join(nodeRoot, 'bin', 'npm.cmd'),
        path.join(nodeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(nodeRoot, 'node_modules', 'npm', 'cli.js')
      ];
      
      for (const altPath of altPaths) {
        if (await fse.pathExists(altPath)) {
          if (altPath.endsWith('.js')) {
            return { cmd: nodeExe, prefix: [altPath] };
          } else {
            return { cmd: altPath, prefix: [] };
          }
        }
      }

      // Strategy 5: Manual npm bootstrap (last resort)
      return await bootstrapNpm(nodeRoot, nodeExe);
    } else {
      // Non-Windows
      const npmBin = await findBinary(nodeRoot, ['npm'], 0);
      if (npmBin) return { cmd: npmBin, prefix: [] };
    }
  } catch (_) {}
  return null;
}

// Bootstrap npm manually if not found
async function bootstrapNpm(nodeRoot, nodeExe) {
  try {
    const npmDir = path.join(nodeRoot, 'npm-bootstrap');
    await fse.ensureDir(npmDir);
    
    // Create a simple npm wrapper script
    const npmScript = `
const { spawn } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const npm = path.join(__dirname, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js');

if (require('fs').existsSync(npm)) {
  const child = spawn(process.execPath, [npm, ...args], { 
    stdio: 'inherit', 
    cwd: process.cwd(),
    env: process.env 
  });
  child.on('exit', process.exit);
} else {
  console.error('npm not found, trying to install...');
  // Fallback: use system npm to install npm locally
  const child = spawn('npm', ['install', 'npm@latest'], {
    stdio: 'inherit',
    cwd: path.dirname(__dirname),
    env: process.env
  });
  child.on('exit', (code) => {
    if (code === 0) {
      console.log('npm installed, please try again');
    }
    process.exit(code);
  });
}
`;
    
    const scriptPath = path.join(npmDir, 'npm-wrapper.js');
    await fse.writeFile(scriptPath, npmScript.trim());
    
    return { cmd: nodeExe, prefix: [scriptPath] };
  } catch (_) {
    return null;
  }
}

// Check if package manager is available and working
async function checkPackageManager(cmd, env, progress) {
  try {
    const result = await runCommand(cmd, ['--version'], {
      env,
      progress,
      stage: 'npm',
      logPrefix: `${cmd} check`,
      quiet: true,
      timeoutMs: 5000
    });
    return result.code === 0;
  } catch (_) {
    return false;
  }
}

// Get best available package manager with fallback priority
async function getBestPackageManager(nodeRoot, env, progress) {
  const managers = [
    { cmd: 'npm', name: 'system npm', strategy: 'system' },
    { cmd: 'yarn', name: 'yarn', strategy: 'yarn' },
    { cmd: 'pnpm', name: 'pnpm', strategy: 'pnpm' }
  ];
  
  // Check system package managers first
  for (const manager of managers) {
    if (await checkPackageManager(manager.cmd, env, progress)) {
      emit(progress, { stage: 'npm', message: `Found working ${manager.name}` });
      return { cmd: manager.cmd, prefix: [], strategy: manager.strategy };
    }
  }
  
  // Try bundled npm as fallback
  if (nodeRoot) {
    const runner = await resolveNpmRunner(nodeRoot);
    if (runner) {
      // Test the bundled npm
      try {
        const testResult = await runCommand(runner.cmd, [...runner.prefix, '--version'], {
          env: { ...env, PATH: nodeRoot + path.delimiter + env.PATH },
          progress,
          stage: 'npm',
          logPrefix: 'bundled npm test',
          quiet: true,
          timeoutMs: 5000
        });
        if (testResult.code === 0) {
          emit(progress, { stage: 'npm', message: 'Found working bundled npm' });
          return { ...runner, strategy: 'bundled' };
        }
      } catch (_) {}
    }
  }
  
  return null;
}

// Read existing .env values from an installed app within installDir
async function readExistingEnv(installDir) {
  try {
    const appDir = path.join(installDir, 'app');
    let target = appDir;
    // Use version marker if present
    try {
      const marker = await fse.readJson(path.join(appDir, 'current.json')).catch(() => null);
      if (marker?.current) {
        const candidate = path.join(appDir, 'versions', String(marker.current));
        if (await fse.pathExists(candidate)) target = candidate;
      }
    } catch (_) {}
    const appRoot = await resolveAppRoot(target);
    const envFile = path.join(appRoot, '.env');
    if (!(await fse.pathExists(envFile))) return {};
    const txt = await fse.readFile(envFile, 'utf8');
    const out = {};
    for (const line of txt.split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#')) continue;
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      // Trim surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
    return out;
  } catch (_) { return {}; }
}

// Read last N bytes of a file for diagnostics
async function tailFile(file, maxBytes) {
  const stat = await fse.stat(file).catch(() => null);
  if (!stat) return '';
  const size = stat.size;
  const start = Math.max(0, size - maxBytes);
  const fd = await fse.open(file, 'r');
  try {
    const len = size - start;
    const buf = Buffer.alloc(len);
    await fd.read(buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    await fd.close();
  }
}

// Enhanced npm preparation with multiple strategies
async function prepareNpm(nodeRoot, env, progress) {
  try {
    // Strategy 1: Try system npm first
    try {
      const systemTest = await runCommand('npm', ['--version'], { 
        env, 
        progress, 
        stage: 'npm', 
        logPrefix: 'system npm test',
        quiet: true, 
        timeoutMs: 5000 
      });
      if (systemTest.code === 0) {
        emit(progress, { stage: 'npm', message: 'Using system npm.' });
        return;
      }
    } catch (_) {}

    // Strategy 2: Try to fix bundled Node.js npm
    const nodeExe = await findBinary(nodeRoot, ['node.exe', 'node']);
    if (!nodeExe) {
      emit(progress, { stage: 'npm', message: 'Node.js executable not found.' });
      return;
    }

    // Check if npm modules exist
    const npmModulePath = path.join(nodeRoot, 'node_modules', 'npm');
    if (!(await fse.pathExists(npmModulePath))) {
      emit(progress, { stage: 'npm', message: 'npm modules not found, attempting to install...' });
      
      // Try to install npm using the bundled node
      try {
        // First check if we have internet and can download npm
        const testDownload = await runCommand(nodeExe, ['-e', `
          const https = require('https');
          https.get('https://registry.npmjs.org/npm/latest', (res) => {
            console.log('npm registry accessible');
            process.exit(0);
          }).on('error', () => {
            console.error('npm registry not accessible');
            process.exit(1);
          });
        `], { env, progress, stage: 'npm', logPrefix: 'connectivity test', timeoutMs: 10000, quiet: true });
        
        if (testDownload.code === 0) {
          // Manual npm bootstrap using node
          const bootstrapScript = `
            const path = require('path');
            const fs = require('fs');
            const https = require('https');
            const { execSync } = require('child_process');
            
            console.log('Bootstrapping npm...');
            
            // Simple npm install simulation
            try {
              execSync('node -e "console.log(\\'npm bootstrap attempt\\')"', { 
                stdio: 'inherit', 
                cwd: '${nodeRoot.replace(/\\/g, '\\\\')}'
              });
            } catch (e) {
              console.error('Bootstrap failed:', e.message);
              process.exit(1);
            }
          `;
          
          await fse.writeFile(path.join(nodeRoot, 'npm-bootstrap.js'), bootstrapScript);
          await runCommand(nodeExe, [path.join(nodeRoot, 'npm-bootstrap.js')], {
            env, progress, stage: 'npm', logPrefix: 'npm bootstrap', timeoutMs: 30000
          });
        }
      } catch (e) {
        emit(progress, { stage: 'npm', message: `npm install failed: ${e.message}` });
      }
    }

    // Strategy 3: Try corepack as fallback
    try {
      const corepackCmd = await findBinary(nodeRoot, ['corepack.cmd', 'corepack']) || 'corepack';
      
      await runCommand(nodeExe, ['-e', `
        try {
          require('child_process').execSync('${corepackCmd} --version', {stdio: 'pipe'});
          console.log('corepack available');
        } catch {
          console.log('corepack not available');
          process.exit(1);
        }
      `], { env, progress, stage: 'npm', timeoutMs: 5000, quiet: true });

      // Enable corepack
      await runCommand(corepackCmd, ['enable'], { 
        env: { ...env, PATH: nodeRoot + path.delimiter + env.PATH },
        progress, stage: 'npm', logPrefix: 'corepack enable', timeoutMs: 10000
      });

      // Prepare npm
      await runCommand(corepackCmd, ['prepare', 'npm@latest', '--activate'], { 
        env: { ...env, PATH: nodeRoot + path.delimiter + env.PATH },
        progress, stage: 'npm', logPrefix: 'corepack prepare npm', timeoutMs: 30000
      });

    } catch (e) {
      emit(progress, { stage: 'npm', message: `Corepack fallback failed: ${e.message}` });
    }

  } catch (e) {
    emit(progress, { stage: 'npm', message: `npm preparation failed: ${e.message}` });
  }
}

// Initialize a new PostgreSQL data directory with best-effort logging
async function runInitdb(pgRootOrDir, dataDir, env, progress) {
  const pgBinDir = await (async () => {
    const initdbPath = await findBinary(pgRootOrDir, ['initdb.exe', 'initdb']);
    if (initdbPath) return path.dirname(initdbPath);
    return path.join(pgRootOrDir, 'bin');
  })();
  const initdb = (await findBinary(pgBinDir, ['initdb.exe', 'initdb'])) || path.join(pgBinDir, 'initdb.exe');
  const pgCtl = (await findBinary(pgBinDir, ['pg_ctl.exe', 'pg_ctl'])) || path.join(pgBinDir, 'pg_ctl.exe');

  // Prefer running initdb directly; fallback to pg_ctl initdb
  const argsDirect = ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8'];
  const argsCtl = ['initdb', '-D', dataDir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8'];

  const trySpawn = (cmd, args) => new Promise((resolve) => {
    let p;
    let stderr = '';
    let stdout = '';
    try {
      p = spawn(cmd, args, { env });
    } catch (err) {
      resolve({ code: -1, stderr: String(err && err.message || err), stdout: '' });
      return;
    }
    p.stderr?.on('data', (d) => { stderr += d.toString(); });
    p.stdout?.on('data', (d) => { stdout += d.toString(); });
    p.on('close', (code) => resolve({ code, stderr, stdout }));
  });

  // Ensure target dir exists and is empty
  await fse.ensureDir(dataDir);
  try { await fse.emptyDir(dataDir); } catch (_) {}

  // Try direct
  let res = await trySpawn(initdb, argsDirect);
  if (res.code !== 0) {
    emit(progress, { stage: 'postgres', log: `initdb direct failed (code ${res.code}). Falling back to pg_ctl.\nCMD: ${initdb} ${argsDirect.join(' ')}\nSTDERR:\n${res.stderr || ''}\nSTDOUT:\n${res.stdout || ''}` });
    res = await trySpawn(pgCtl, argsCtl);
  }
  if (res.code !== 0) {
    emit(progress, { stage: 'postgres', log: `initdb failed (code ${res.code}).\nCMD: ${pgCtl} ${argsCtl.join(' ')}\nSTDERR:\n${res.stderr || ''}\nSTDOUT:\n${res.stdout || ''}` });
    throw new Error('initdb failed');
  }
}

// Ensure pg_hba.conf uses permissive local trust for dev
async function writePgHba(dataDir, progress) {
  try {
    const tpl = path.join(templatesBase, 'pg', 'pg_hba.conf.hbs');
    if (!(await fse.pathExists(tpl))) return;
    const content = renderTemplate(tpl, {});
    await fse.writeFile(path.join(dataDir, 'pg_hba.conf'), content, 'utf8');
    emit(progress, { stage: 'postgres', message: 'pg_hba.conf updated (trust for local).' });
  } catch (err) {
    emit(progress, { stage: 'warn', message: `Failed to write pg_hba.conf: ${err.message}` });
  }
}

// Simple TCP port availability check
function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

// Check and update ports: find available ports, update UI form and .env file
async function checkAndUpdatePorts(options, appRoot, progress) {
  let webPort = Number(options?.webPort) || 8080;
  let pgPort = Number(options?.pgPort) || 5432;
  let portsChanged = false;
  
  emit(progress, { stage: 'port-check', message: `Checking requested ports - Web: ${webPort}, DB: ${pgPort}` });
  
  // Check web port
  const webPortFree = await isPortFree(webPort);
  if (!webPortFree) {
    // Find next available port for web
    let newWebPort = webPort;
    for (let i = 1; i <= 50; i++) {
      newWebPort = webPort + i;
      if (await isPortFree(newWebPort)) {
        break;
      }
    }
    emit(progress, { stage: 'port-check', message: `Web port ${webPort} busy, using ${newWebPort}` });
    webPort = newWebPort;
    portsChanged = true;
  }
  
  // Check postgres port
  const pgPortFree = await isPortFree(pgPort);
  if (!pgPortFree) {
    // Find next available port for postgres
    let newPgPort = pgPort;
    for (let i = 1; i <= 50; i++) {
      newPgPort = pgPort + i;
      if (await isPortFree(newPgPort)) {
        break;
      }
    }
    emit(progress, { stage: 'port-check', message: `DB port ${pgPort} busy, using ${newPgPort}` });
    pgPort = newPgPort;
    portsChanged = true;
  }
  
  if (portsChanged) {
    emit(progress, { stage: 'port-update', message: 'Updating .env and UI with new ports...' });
    
    // Update .env file
    await writeEnvValue(appRoot, 'APP_URL', `http://localhost:${webPort}`);
    await writeEnvValue(appRoot, 'DB_PORT', String(pgPort));
    
    // Send port updates to UI
    emit(progress, { 
      stage: 'port-update', 
      type: 'port-update',
      webPort: webPort,
      pgPort: pgPort,
      message: `Ports updated - Web: ${webPort}, DB: ${pgPort}` 
    });
  } else {
    emit(progress, { stage: 'port-check', message: 'Requested ports are available' });
  }
  
  return { webPort, pgPort, portsChanged };
}
async function killPortProcess(port, progress) {
  try {
    if (process.platform === 'win32') {
      // Windows: find and kill process using port
      const netstatResult = await runCommand('netstat', ['-ano'], { 
        env: process.env, 
        progress, 
        stage: 'port-kill', 
        logPrefix: 'netstat', 
        quiet: true, 
        timeoutMs: 10000 
      });
      
      if (netstatResult.code === 0) {
        const lines = netstatResult.stdout.split('\n');
        for (const line of lines) {
          if (line.includes(`:${port} `) && line.includes('LISTENING')) {
            const parts = line.trim().split(/\s+/);
            const pid = parts[parts.length - 1];
            if (pid && pid !== '0') {
              emit(progress, { stage: 'port-kill', message: `Killing process ${pid} using port ${port}` });
              await runCommand('taskkill', ['/F', '/PID', pid], { 
                env: process.env, 
                progress, 
                stage: 'port-kill', 
                logPrefix: 'taskkill', 
                quiet: true 
              });
              
              // Wait a moment for the process to be killed
              await new Promise(resolve => setTimeout(resolve, 1000));
              return true;
            }
          }
        }
      }
    } else {
      // Unix-like systems
      const lsofResult = await runCommand('lsof', ['-ti', `:${port}`], { 
        env: process.env, 
        progress, 
        stage: 'port-kill', 
        logPrefix: 'lsof', 
        quiet: true, 
        timeoutMs: 10000 
      });
      
      if (lsofResult.code === 0 && lsofResult.stdout.trim()) {
        const pid = lsofResult.stdout.trim();
        emit(progress, { stage: 'port-kill', message: `Killing process ${pid} using port ${port}` });
        await runCommand('kill', ['-9', pid], { 
          env: process.env, 
          progress, 
          stage: 'port-kill', 
          logPrefix: 'kill', 
          quiet: true 
        });
        
        // Wait a moment for the process to be killed
        await new Promise(resolve => setTimeout(resolve, 1000));
        return true;
      }
    }
  } catch (e) {
    emit(progress, { stage: 'port-kill', message: `Failed to kill process on port ${port}: ${e.message}` });
  }
  return false;
}

// Read best available Postgres logs (server.log or pg_log/pg_logs directory)
async function readBestPgLogs(dataDir, logDir) {
  try {
    const candidates = [
      path.join(logDir, 'server.log'),
      path.join(dataDir, 'log', 'server.log'),
      path.join(dataDir, 'pg_log'),
      path.join(dataDir, 'pg_logs'),
      path.join(dataDir, 'log'),
    ];
    for (const pth of candidates) {
      const stat = await fse.stat(pth).catch(() => null);
      if (!stat) continue;
      if (stat.isFile()) {
        return await tailFile(pth, 65536).catch(() => '');
      }
      if (stat.isDirectory()) {
        const files = (await fse.readdir(pth).catch(() => [])).filter(f => f.toLowerCase().endsWith('.log'));
        files.sort();
        const last = files[files.length - 1];
        if (last) {
          return await tailFile(path.join(pth, last), 65536).catch(() => '');
        }
      }
    }
  } catch (_) {}
  return '';
}

// Quote APP_NAME in .env if it contains whitespace and isn't already quoted
async function ensureEnvSafety(appRoot) {
  try {
    const envFile = path.join(appRoot, '.env');
    if (!(await fse.pathExists(envFile))) return;
    let txt = await fse.readFile(envFile, 'utf8');
    const m = txt.match(/^APP_NAME=(.*)$/m);
    if (!m) return;
    const val = m[1].trim();
    const needsQuote = /\s/.test(val) && !(val.startsWith('"') && val.endsWith('"')) && !(val.startsWith("'") && val.endsWith("'"));
    if (needsQuote) {
      txt = txt.replace(/^APP_NAME=.*$/m, `APP_NAME="${val.replace(/^\"|\"$/g, '')}"`);
      await fse.writeFile(envFile, txt, 'utf8');
    }
  } catch (_) {}
}

// Read a single key from .env
async function readEnvValue(appRoot, key) {
  try {
    const envFile = path.join(appRoot, '.env');
    if (!(await fse.pathExists(envFile))) return null;
    const txt = await fse.readFile(envFile, 'utf8');
    const re = new RegExp(`^${key}=([^\n\r]*)`, 'm');
    const m = txt.match(re);
    if (!m) return null;
    return m[1].trim().replace(/^"|"$/g, '');
  } catch (_) { return null; }
}

// Update or append a key=value line in .env
async function writeEnvValue(appRoot, key, value) {
  try {
    const envFile = path.join(appRoot, '.env');
    let txt = '';
    try { txt = await fse.readFile(envFile, 'utf8'); } catch (_) {}
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(txt)) txt = txt.replace(re, line);
    else txt += (txt.endsWith('\n') ? '' : '\n') + line + '\n';
    await fse.writeFile(envFile, txt, 'utf8');
  } catch (_) {}
}

// Small runner utility
function runCommand(cmd, args, { cwd, env, progress, stage, logPrefix, timeoutMs, quiet } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
  // Use direct execution (shell: false) so Windows handles quoted paths correctly via CreateProcess
  const p = spawn(cmd, args, { cwd, env, shell: false, windowsHide: true, stdio: quiet ? 'ignore' : 'pipe' });
    let killed = false;
    let timer = null;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        killed = true;
        try { p.kill('SIGKILL'); } catch (_) {}
      }, timeoutMs);
    }
    const flushLines = (buf, which) => {
      const s = buf.toString();
      const lines = s.split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        if (!quiet) emit(progress, { stage: stage || 'exec', log: `${logPrefix || cmd}> ${line}` });
      }
    };
    if (!quiet) {
      p.stdout?.on('data', (d) => { stdout += d.toString(); flushLines(d, 'stdout'); });
      p.stderr?.on('data', (d) => { stderr += d.toString(); flushLines(d, 'stderr'); });
    }
    p.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (!quiet) emit(progress, { stage: stage || 'exec', message: `${logPrefix || cmd}: ${killed ? 'timeout, process killed' : 'exit ' + code}` });
      resolve({ code, stdout, stderr });
    });
    p.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (!quiet) emit(progress, { stage: stage || 'exec', log: `${logPrefix || cmd} error: ${err.message}` });
      resolve({ code: -1, stdout: '', stderr: String(err && err.message || err) });
    });
  });
}

async function waitForPostgres(pgRoot, port, env, progress, { retries = 60, delayMs = 1000 } = {}) {
  // Try bin first, then the root recursively as a fallback
  let psql = await findBinary(path.join(pgRoot, 'bin'), ['psql.exe', 'psql']);
  if (!psql) psql = await findBinary(pgRoot, ['psql.exe', 'psql']);
  if (!psql) throw new Error('psql not found');
  for (let i = 0; i < retries; i++) {
  const res = await runCommand(psql, ['-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-h', '127.0.0.1', '-p', String(port), '-d', 'postgres', '-c', 'SELECT 1;'], { env, progress, stage: 'postgres', logPrefix: 'psql probe' });
    if (res.code === 0) return true;
    await new Promise(r => setTimeout(r, delayMs));
    emit(progress, { stage: 'postgres', message: `Waiting for PostgreSQL to be ready... (${i + 1}/${retries})` });
  }
  return false;
}

async function ensureRoleDb(pgRoot, port, { user, password, database }, env, progress) {
  // Find psql robustly
  let psql = await findBinary(path.join(pgRoot, 'bin'), ['psql.exe', 'psql']);
  if (!psql) psql = await findBinary(pgRoot, ['psql.exe', 'psql']);
  if (!psql) throw new Error('psql not found');

  // Escape for SQL literal context
  const esc = (s) => String(s).replace(/'/g, "''");
  emit(progress, { stage: 'postgres', message: `Provisioning role "${user}" and database "${database}"...` });

  const roleSql = `DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${esc(user)}') THEN
    CREATE ROLE ${user} LOGIN PASSWORD '${esc(password)}';
  ELSE
    ALTER ROLE ${user} LOGIN PASSWORD '${esc(password)}';
  END IF;
END$$;`;
  const roleRes = await runCommand(psql, ['-U', 'postgres', '-h', '127.0.0.1', '-p', String(port), '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', roleSql], { env, progress, stage: 'postgres', logPrefix: 'ensure role' });
  if (roleRes.code !== 0) throw new Error('Failed to create/alter role');

  const dbSql = `DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_database WHERE datname = '${esc(database)}') THEN
    RAISE NOTICE 'db_missing';
  END IF;
END$$;`;
  // Check if DB exists
  const existsRes = await runCommand(psql, ['-U', 'postgres', '-h', '127.0.0.1', '-p', String(port), '-d', 'postgres', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', `SELECT 1 FROM pg_database WHERE datname='${esc(database)}' LIMIT 1;`], { env, progress, stage: 'postgres', logPrefix: 'check db exists' });
  const exists = existsRes.code === 0 && (existsRes.stdout || '').trim().startsWith('1');
  if (!exists) {
    const createRes = await runCommand(psql, ['-U', 'postgres', '-h', '127.0.0.1', '-p', String(port), '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${database} OWNER ${user};`], { env, progress, stage: 'postgres', logPrefix: 'create database' });
    if (createRes.code !== 0) throw new Error('Failed to create database');
  }
}

async function ensureDbPrivileges(pgRoot, port, { user, database }, env, progress) {
  let psql = await findBinary(path.join(pgRoot, 'bin'), ['psql.exe', 'psql']);
  if (!psql) psql = await findBinary(pgRoot, ['psql.exe', 'psql']);
  if (!psql) throw new Error('psql not found');
  const cmds = [
    `ALTER DATABASE ${database} OWNER TO ${user};`,
    `GRANT ALL PRIVILEGES ON DATABASE ${database} TO ${user};`,
    `ALTER SCHEMA public OWNER TO ${user};`,
    `GRANT ALL ON SCHEMA public TO ${user};`,
    `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${user};`,
    `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${user};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO ${user};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO ${user};`,
  ];
  for (const sql of cmds) {
    const res = await runCommand(psql, ['-U', 'postgres', '-h', '127.0.0.1', '-p', String(port), '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', sql], { env, progress, stage: 'postgres', logPrefix: 'grant' });
    if (res.code !== 0) throw new Error('Failed to grant database privileges');
  }
}

// Check if a database exists
async function databaseExists(pgRoot, port, database, env, progress) {
  const psql = await findBinary(path.join(pgRoot, 'bin'), ['psql.exe', 'psql']);
  if (!psql) throw new Error('psql not found');
  const sql = `SELECT 1 FROM pg_database WHERE datname='${database}' LIMIT 1;`;
  const res = await runCommand(psql, ['-U', 'postgres', '-h', '127.0.0.1', '-p', String(port), '-d', 'postgres', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql], { env, progress, stage: 'postgres', logPrefix: 'check db exists' });
  const out = (res.stdout || '').trim();
  return res.code === 0 && out.startsWith('1');
}

async function start(progress, options = {}) { return startServices(progress, options); }

// Install the application (supports multi-version via appVersion and multiple URLs)
async function installApp(options = {}, progress) {
  const installDir = options.installDir;
  if (!installDir) throw new Error('installDir is required');
  
  console.log(`[InstallApp Debug] installDir: ${installDir}`);
  console.log(`[InstallApp Debug] installDir exists: ${fs.existsSync(installDir)}`);
  
  const appDir = path.join(installDir, 'app');
  const stackDir = path.join(installDir, 'stack');
  const phpDir = path.join(stackDir, 'php');
  const nodeDir = path.join(stackDir, 'node');

  console.log(`[InstallApp Debug] appDir: ${appDir}`);
  console.log(`[InstallApp Debug] stackDir: ${stackDir}`);
  
  try {
    await fse.ensureDir(appDir);
    console.log(`[InstallApp Debug] appDir ensured successfully`);
  } catch (error) {
    console.error(`[InstallApp Error] Failed to ensure appDir:`, error);
    throw new Error(`Failed to create app directory: ${error.message}`);
  }
  const version = options.appVersion || options.version || null;
  const targetDir = version ? path.join(appDir, 'versions', String(version)) : appDir;
  await fse.ensureDir(targetDir);

  // Gather sources
  const sources = [];
  if (options.appZip || options.appUrl) sources.push({ localZip: options.appZip, url: options.appUrl, zipName: 'app.zip' });
  if (Array.isArray(options.appUrls)) options.appUrls.forEach((u, i) => sources.push({ url: u, zipName: `app-${i + 1}.zip` }));
  // Fallback: use bundled payloads/app/app.zip if no source provided
  if (sources.length === 0) {
    const bundled = path.join(payloadBase, 'app', 'app.zip');
    if (await fse.pathExists(bundled) && isLikelyZip(bundled)) {
      emit(progress, { stage: 'extract', message: 'Using bundled app.zip from payloads.' });
      sources.push({ localZip: bundled, zipName: 'app.zip' });
    } else {
      emit(progress, { stage: 'error', message: 'No application source provided. Pick an App Zip or place payloads/app/app.zip.' });
      throw new Error('No application source provided');
    }
  }

  for (const item of sources) {
    const bucket = path.join(payloadBase, 'app');
    await fse.ensureDir(bucket);
    let useZip = null;
    if (item.localZip && await fse.pathExists(item.localZip) && isLikelyZip(item.localZip)) useZip = item.localZip;
    if (!useZip && item.url) {
      const z = await downloadIfMissing(item.url, bucket, item.zipName || 'app.zip', progress);
      if (isLikelyZip(z)) useZip = z;
    }
    if (useZip) {
      emit(progress, { stage: 'extract', message: `Extracting ${path.basename(useZip)}...` });
      await ensureZipExtract(useZip, targetDir);
    }
  }

  const appRoot = await resolveAppRoot(targetDir);
  console.log(`[InstallApp Debug] Resolved appRoot: ${appRoot}`);
  
  // Enhanced validation of extracted app contents with better error handling
  const hasArtisan = await fse.pathExists(path.join(appRoot, 'artisan')).catch(() => false);
  const hasComposerJson = await fse.pathExists(path.join(appRoot, 'composer.json')).catch(() => false);
  const hasAppDir = await fse.pathExists(path.join(appRoot, 'app')).catch(() => false);
  const hasConfigDir = await fse.pathExists(path.join(appRoot, 'config')).catch(() => false);
  
  console.log(`[InstallApp Debug] Validation results:`);
  console.log(`[InstallApp Debug] - hasArtisan: ${hasArtisan}`);
  console.log(`[InstallApp Debug] - hasComposerJson: ${hasComposerJson}`);
  console.log(`[InstallApp Debug] - hasAppDir: ${hasAppDir}`);
  console.log(`[InstallApp Debug] - hasConfigDir: ${hasConfigDir}`);
  
  // More flexible validation - allow Laravel project even if some files are missing
  const isValidLaravelApp = hasArtisan || (hasComposerJson && (hasAppDir || hasConfigDir));
  
  if (!isValidLaravelApp) {
    // Try to find Laravel in subdirectories one more time before failing
    emit(progress, { stage: 'extract', message: 'Laravel project structure not found in root, searching subdirectories...' });
    
    const subdirs = await fse.readdir(appRoot, { withFileTypes: true })
      .then(entries => entries.filter(e => e.isDirectory() && !e.name.startsWith('.')))
      .catch(() => []);
    
    let foundLaravelIn = null;
    for (const subdir of subdirs) {
      const subdirPath = path.join(appRoot, subdir.name);
      const subdirHasArtisan = await fse.pathExists(path.join(subdirPath, 'artisan')).catch(() => false);
      const subdirHasComposer = await fse.pathExists(path.join(subdirPath, 'composer.json')).catch(() => false);
      
      if (subdirHasArtisan || subdirHasComposer) {
        foundLaravelIn = subdirPath;
        console.log(`[InstallApp Debug] Found Laravel in subdirectory: ${foundLaravelIn}`);
        break;
      }
    }
    
    if (foundLaravelIn) {
      // Update appRoot to the subdirectory containing Laravel
      const newAppRoot = foundLaravelIn;
      emit(progress, { stage: 'extract', message: `Laravel found in subdirectory: ${path.basename(newAppRoot)}` });
      
      // Move Laravel files to the parent directory
      try {
        const tempDir = path.join(targetDir, '_temp_laravel');
        await fse.move(newAppRoot, tempDir);
        await fse.emptyDir(targetDir);
        await fse.move(tempDir, targetDir);
        
        emit(progress, { stage: 'extract', message: 'Laravel files moved to app root' });
      } catch (moveError) {
        console.error(`[InstallApp Error] Failed to move Laravel files: ${moveError.message}`);
        emit(progress, { stage: 'error', message: `Failed to reorganize Laravel files: ${moveError.message}` });
        throw new Error('Failed to reorganize Laravel application structure');
      }
    } else {
      emit(progress, { stage: 'error', message: `Laravel application not found in ${appRoot}. Ensure your zip contains a Laravel project with artisan file or composer.json.` });
      throw new Error('Invalid Laravel application archive - no Laravel structure found');
    }
  } else {
    emit(progress, { stage: 'extract', message: 'Laravel application structure validated successfully' });
  }

  // Force regenerate appRoot after potential directory restructuring
  const finalAppRoot = await resolveAppRoot(targetDir);
  console.log(`[InstallApp Debug] Final appRoot: ${finalAppRoot}`);

  // Ensure a valid Laravel APP_KEY
  const providedKey = options.appKey || '';
  const isValidLaravelKey = (key) => {
    try {
      if (!key) return false;
      if (key.startsWith('base64:')) {
        const raw = Buffer.from(key.slice(7), 'base64');
        return raw.length === 32 || raw.length === 16;
      }
      return key.length === 32 || key.length === 16;
    } catch (_) { return false; }
  };
  const generatedKey = 'base64:' + crypto.randomBytes(32).toString('base64');
  const finalAppKey = isValidLaravelKey(providedKey) ? providedKey : generatedKey;
  
  // Check and update ports before creating .env
  const { webPort, pgPort } = await checkAndUpdatePorts(options, finalAppRoot, progress);
  
  const envData = {
    APP_NAME: options.appName || 'Yualan App',
    APP_ENV: options.appEnv || 'local',
    APP_KEY: finalAppKey,
    APP_DEBUG: String(options.appDebug ?? 'true'),
    APP_URL: `http://localhost:${webPort}`,
    DB_CONNECTION: options.dbConnection || 'pgsql',
    DB_HOST: options.dbHost || '127.0.0.1',
    DB_PORT: pgPort,
    DB_DATABASE: options.pgDatabase || 'yualan',
    DB_USERNAME: options.pgUser || 'yualan',
    DB_PASSWORD: options.pgPassword || 'yualan',
  LOG_CHANNEL: options.logChannel || 'stack',
  LOG_DEPRECATIONS_CHANNEL: options.logDeprecationsChannel || 'null',
  LOG_LEVEL: options.logLevel || 'debug',
  BROADCAST_DRIVER: options.broadcastDriver || 'log',
  FILESYSTEM_DISK: options.filesystemDisk || 'local',
  QUEUE_CONNECTION: options.queueConnection || 'sync',
  SESSION_DRIVER: options.sessionDriver || 'file',
  SESSION_LIFETIME: options.sessionLifetime || 120,
  };
  const envTpl = path.join(templatesBase, 'env', 'laravel.env.hbs');
  if (await fse.pathExists(envTpl)) {
    const envOut = renderTemplate(envTpl, envData);
    await fse.writeFile(path.join(finalAppRoot, '.env'), envOut, 'utf8');
    emit(progress, { stage: 'env', message: '.env file created successfully' });
  } else {
    emit(progress, { stage: 'env', message: 'Laravel .env template not found, using manual creation' });
    // Manually create .env if template doesn't exist
    const envContent = Object.entries(envData).map(([key, value]) => `${key}=${value}`).join('\n');
    await fse.writeFile(path.join(finalAppRoot, '.env'), envContent, 'utf8');
  }
  await ensureEnvSafety(finalAppRoot);
  // If .env exists with an invalid or missing APP_KEY, fix it now
  try {
    const envFile = path.join(finalAppRoot, '.env');
    if (await fse.pathExists(envFile)) {
      let txt = await fse.readFile(envFile, 'utf8');
      const m = txt.match(/^APP_KEY=(.*)$/m);
      const curr = m ? m[1].trim() : '';
      const needs = !isValidLaravelKey(curr);
      if (needs) {
        const newKey = 'base64:' + crypto.randomBytes(32).toString('base64');
        if (m) txt = txt.replace(/^APP_KEY=.*$/m, `APP_KEY=${newKey}`);
        else txt += (txt.endsWith('\n') ? '' : '\n') + `APP_KEY=${newKey}\n`;
        await fse.writeFile(envFile, txt, 'utf8');
        emit(progress, { stage: 'env', message: 'APP_KEY updated in .env file' });
      }
    }
  } catch (_) {
    console.log('[InstallApp Debug] Failed to fix APP_KEY in .env file');
  }

  // Start a temporary PostgreSQL for installation (so migrations can run), then stop it at the end
  const roots = await resolveRoots({ phpDir, apacheDir: path.join(stackDir, 'apache'), nodeDir, pgDir: path.join(stackDir, 'postgres') });
  console.log(`[InstallApp Debug] Resolved roots:`, {
    phpRoot: roots.phpRoot,
    nodeRoot: roots.nodeRoot,
    pgRoot: roots.pgRoot,
    apacheRoot: roots.apacheRoot
  });
  const env = makeEnvFromRoots(process.env, roots);
  let startedPg = false;
  let pgCtlPath = null;
  let pgDataDir = null;
  try {
    // Prepare data dir
    const pgRoot = roots.pgRoot || path.join(stackDir, 'postgres');
    pgDataDir = roots.pgRoot ? path.join(roots.pgRoot, 'data') : path.join(pgRoot, 'data');
    await fse.ensureDir(pgDataDir);
    
    // Init if needed and ensure pg_hba
    const pgVersionFile = path.join(pgDataDir, 'PG_VERSION');
    if (!(await fse.pathExists(pgVersionFile))) {
      emit(progress, { stage: 'postgres', message: 'Initializing PostgreSQL data directory (app install)...' });
      await runInitdb(pgRoot, pgDataDir, env, progress);
    }
    await writePgHba(pgDataDir, progress);
    // Start
    pgCtlPath = await findBinary(path.join(roots.pgRoot || pgRoot, 'bin'), ['pg_ctl.exe', 'pg_ctl']);
    if (!pgCtlPath) throw new Error('pg_ctl not found');
    const serverLog = path.join(roots.pgRoot || pgRoot, 'logs', 'server.log');
    await fse.ensureDir(path.dirname(serverLog));
    const startArgs = ['start', '-w', '-t', '60', '-D', pgDataDir, '-l', serverLog, '-o', `-c port=${pgPort} -c listen_addresses=127.0.0.1`];
    const startRes = await runCommand(pgCtlPath, startArgs, { env, progress, stage: 'postgres', logPrefix: 'pg_ctl start (install app)', timeoutMs: 70000, quiet: true });
    // Even if start returns non-zero, proceed if the server is already ready on that port
    const ready = await waitForPostgres(roots.pgRoot || pgRoot, pgPort, env, progress, { retries: 60, delayMs: 1000 });
    if (!ready) {
      const logs = await readBestPgLogs(pgDataDir, path.dirname(serverLog));
      emit(progress, { stage: 'postgres', log: `PostgreSQL failed to become ready for app install. Logs:\n${logs}` });
      throw new Error('PostgreSQL not ready for app install');
    }
    startedPg = (startRes.code === 0);
  } catch (e) {
    emit(progress, { stage: 'warn', message: `Skipping temporary Postgres start for install: ${e.message}` });
  }

  // Enhanced Composer and npm installation with better error handling
  const phpExe = await findBinary(roots.phpRoot || phpDir, ['php.exe', 'php']);
  const composerPhar = path.join(roots.phpRoot || phpDir, 'composer.phar');
  
  console.log(`[InstallApp Debug] PHP search details:`);
  console.log(`[InstallApp Debug] - roots.phpRoot: ${roots.phpRoot}`);
  console.log(`[InstallApp Debug] - phpDir: ${phpDir}`);
  console.log(`[InstallApp Debug] - Search path: ${roots.phpRoot || phpDir}`);
  console.log(`[InstallApp Debug] - phpDir exists: ${await fse.pathExists(phpDir).catch(() => false)}`);
  if (roots.phpRoot) {
    console.log(`[InstallApp Debug] - phpRoot exists: ${await fse.pathExists(roots.phpRoot).catch(() => false)}`);
  }
  console.log(`[InstallApp Debug] PHP exe: ${phpExe}`);
  console.log(`[InstallApp Debug] Composer phar: ${composerPhar}`);
  console.log(`[InstallApp Debug] PHP exe exists: ${phpExe && await fse.pathExists(phpExe).catch(() => false)}`);
  console.log(`[InstallApp Debug] Composer phar exists: ${await fse.pathExists(composerPhar).catch(() => false)}`);
  
  // Re-validate composer.json exists in final location
  const finalComposerJson = path.join(finalAppRoot, 'composer.json');
  const hasComposerJsonFinal = await fse.pathExists(finalComposerJson).catch(() => false);
  console.log(`[InstallApp Debug] Final composer.json exists: ${hasComposerJsonFinal}`);
  
  if (phpExe && await fse.pathExists(composerPhar).catch(() => false) && hasComposerJsonFinal) {
    emit(progress, { stage: 'composer', message: 'Running composer install...' });
    console.log(`[InstallApp Debug] Running composer install in: ${finalAppRoot}`);
    
    try {
      const composerResult = await runCommand(phpExe, [composerPhar, 'install', '--no-ansi', '--no-interaction', '--optimize-autoloader'], { 
        cwd: finalAppRoot, 
        env, 
        progress, 
        stage: 'composer', 
        logPrefix: 'composer install',
        timeoutMs: 300000 // 5 minutes timeout
      });
      
      if (composerResult.code !== 0) {
        emit(progress, { stage: 'composer', message: `Composer install failed with code ${composerResult.code}, trying with --no-dev...` });
        
        // Retry with --no-dev flag
        const retryResult = await runCommand(phpExe, [composerPhar, 'install', '--no-ansi', '--no-interaction', '--no-dev'], { 
          cwd: finalAppRoot, 
          env, 
          progress, 
          stage: 'composer', 
          logPrefix: 'composer install (no-dev)',
          timeoutMs: 300000
        });
        
        if (retryResult.code !== 0) {
          emit(progress, { stage: 'composer', message: `Composer install failed. This may affect the application but installation will continue.` });
        } else {
          emit(progress, { stage: 'composer', message: 'Composer install completed (production dependencies only)' });
        }
      } else {
        emit(progress, { stage: 'composer', message: 'Composer install completed successfully' });
      }
    } catch (error) {
      console.error(`[InstallApp Error] Composer install error: ${error.message}`);
      emit(progress, { stage: 'composer', message: `Composer install error: ${error.message}` });
    }
  } else {
    let missingComponents = [];
    if (!phpExe) missingComponents.push('PHP executable');
    if (!(await fse.pathExists(composerPhar).catch(() => false))) missingComponents.push('composer.phar');
    if (!hasComposerJsonFinal) missingComponents.push('composer.json');
    
    emit(progress, { stage: 'composer', message: `Skipping composer install - missing: ${missingComponents.join(', ')}` });
    console.log(`[InstallApp Debug] Skipping composer - missing: ${missingComponents.join(', ')}`);
  }
  
  // Ensure app key is generated with better error handling
  const finalArtisan = path.join(finalAppRoot, 'artisan');
  if (phpExe && await fse.pathExists(finalArtisan).catch(() => false)) {
    emit(progress, { stage: 'laravel', message: 'Generating APP_KEY (php artisan key:generate)...' });
    console.log(`[InstallApp Debug] Running artisan key:generate in: ${finalAppRoot}`);
    
    try {
      const keyGenResult = await runCommand(phpExe, [finalArtisan, 'key:generate', '--force'], { 
        cwd: finalAppRoot, 
        env, 
        progress, 
        stage: 'laravel', 
        logPrefix: 'artisan key:generate',
        timeoutMs: 30000
      });
      
      if (keyGenResult.code !== 0) {
        emit(progress, { stage: 'laravel', message: 'Artisan key:generate failed, but continuing installation...' });
      } else {
        emit(progress, { stage: 'laravel', message: 'APP_KEY generated successfully' });
      }
    } catch (error) {
      console.error(`[InstallApp Error] Key generation error: ${error.message}`);
      emit(progress, { stage: 'laravel', message: `Key generation error: ${error.message}` });
    }
  } else {
    emit(progress, { stage: 'laravel', message: 'Skipping key generation - PHP or artisan not available' });
    console.log(`[InstallApp Debug] Skipping key generation - PHP: ${!!phpExe}, Artisan: ${await fse.pathExists(finalArtisan).catch(() => false)}`);
  }
  try {
    const hasPkg = await fse.pathExists(path.join(finalAppRoot, 'package.json'));
    console.log(`[InstallApp Debug] Has package.json: ${hasPkg}`);
    
    if (hasPkg) {
      emit(progress, { stage: 'npm', message: 'Preparing npm environment...' });
      
      // Get the best available package manager
      const packageManager = await getBestPackageManager(roots.nodeRoot || nodeDir, env, progress);
      
      if (packageManager) {
        emit(progress, { stage: 'npm', message: `Using ${packageManager.strategy} package manager` });
        
        // Install dependencies
        const installCmd = packageManager.strategy === 'yarn' ? ['install'] : 
                          packageManager.strategy === 'pnpm' ? ['install'] : 
                          [...packageManager.prefix, 'install', '--no-audit', '--no-fund'];
        
        emit(progress, { stage: 'npm', message: 'Installing npm packages...' });
        console.log(`[InstallApp Debug] Running npm install in: ${finalAppRoot}`);
        
        const installResult = await runCommand(packageManager.cmd, installCmd, { 
          cwd: finalAppRoot, 
          env: packageManager.strategy === 'bundled' ? 
                { ...env, PATH: (roots.nodeRoot || nodeDir) + path.delimiter + env.PATH } : env, 
          progress, stage: 'npm', logPrefix: `${packageManager.strategy} install`,
          timeoutMs: 300000 // 5 minutes timeout
        });
        
        if (installResult.code !== 0) {
          emit(progress, { stage: 'npm', message: `Package install failed with ${packageManager.strategy}, exit code: ${installResult.code}` });
        } else {
          emit(progress, { stage: 'npm', message: 'npm packages installed successfully' });
        }
        
        // Build frontend if build script exists
        try {
          const pkg = JSON.parse(await fse.readFile(path.join(finalAppRoot, 'package.json'), 'utf8'));
          if (pkg?.scripts?.build) {
            emit(progress, { stage: 'npm', message: `Building frontend (${packageManager.strategy} run build)...` });
            console.log(`[InstallApp Debug] Running npm build in: ${finalAppRoot}`);
            
            const buildCmd = packageManager.strategy === 'yarn' ? ['build'] : 
                            packageManager.strategy === 'pnpm' ? ['run', 'build'] :
                            [...packageManager.prefix, 'run', 'build'];
            
            const buildResult = await runCommand(packageManager.cmd, buildCmd, { 
              cwd: finalAppRoot, 
              env: packageManager.strategy === 'bundled' ? 
                    { ...env, PATH: (roots.nodeRoot || nodeDir) + path.delimiter + env.PATH } : env,
              progress, stage: 'npm', logPrefix: `${packageManager.strategy} run build`,
              timeoutMs: 300000 // 5 minutes timeout
            });
            
            if (buildResult.code !== 0) {
              emit(progress, { stage: 'npm', message: `Build failed with ${packageManager.strategy}, exit code: ${buildResult.code}` });
            } else {
              emit(progress, { stage: 'npm', message: 'Frontend build completed successfully' });
            }
          } else {
            emit(progress, { stage: 'npm', message: 'No build script found in package.json' });
          }
        } catch (e) {
          emit(progress, { stage: 'npm', message: `Build step failed: ${e.message}` });
        }
      } else {
        emit(progress, { stage: 'npm', message: 'No working package manager found. Skipping npm operations.' });
        console.log(`[InstallApp Debug] No package manager available`);
      }
    }
  } catch (e) {
    emit(progress, { stage: 'npm', message: `npm operations failed: ${e.message}` });
    console.error(`[InstallApp Error] npm operations error: ${e.message}`);
  }

  // Migrate/seed with better error handling
  if (phpExe && await fse.pathExists(finalArtisan).catch(() => false)) {
    emit(progress, { stage: 'laravel', message: 'Running database migrations...' });
    console.log(`[InstallApp Debug] Running migrations in: ${finalAppRoot}`);
    
    try {
      const migrateResult = await runCommand(phpExe, [finalArtisan, 'migrate', '--force'], { 
        cwd: finalAppRoot, 
        env, 
        progress, 
        stage: 'laravel', 
        logPrefix: 'artisan migrate',
        timeoutMs: 120000 // 2 minutes timeout
      });
      
      if (migrateResult.code !== 0) {
        emit(progress, { stage: 'laravel', message: 'Database migration failed but installation will continue' });
      } else {
        emit(progress, { stage: 'laravel', message: 'Database migrations completed successfully' });
      }
    } catch (error) {
      console.error(`[InstallApp Error] Migration error: ${error.message}`);
      emit(progress, { stage: 'laravel', message: `Migration error: ${error.message}` });
    }
    
    // Run seeding
    emit(progress, { stage: 'laravel', message: 'Seeding database...' });
    console.log(`[InstallApp Debug] Running database seeding in: ${finalAppRoot}`);
    
    try {
      const seedResult = await runCommand(phpExe, [finalArtisan, 'db:seed', '--force'], { 
        cwd: finalAppRoot, 
        env, 
        progress, 
        stage: 'laravel', 
        logPrefix: 'artisan db:seed',
        timeoutMs: 120000 // 2 minutes timeout
      });
      
      if (seedResult.code !== 0) {
        emit(progress, { stage: 'laravel', message: 'Database seeding failed (this may be normal if no seeders exist)' });
      } else {
        emit(progress, { stage: 'laravel', message: 'Database seeding completed successfully' });
      }
    } catch (error) {
      console.error(`[InstallApp Error] Seeding error: ${error.message}`);
      emit(progress, { stage: 'laravel', message: `Seeding error: ${error.message}` });
    }
  } else {
    emit(progress, { stage: 'laravel', message: 'Skipping migrations and seeding - PHP or artisan not available' });
    console.log(`[InstallApp Debug] Skipping migrations - PHP: ${!!phpExe}, Artisan: ${await fse.pathExists(finalArtisan).catch(() => false)}`);
  }

  // If versioned, mark current
  if (version) {
    await fse.ensureDir(appDir);
    await fse.writeJson(path.join(appDir, 'current.json'), { current: version, updatedAt: new Date().toISOString() }, { spaces: 2 });
  }
  emit(progress, { stage: 'install-app', message: 'Application installed.' });
  // Stop temporary Postgres if we started it
  try {
    if (startedPg && pgCtlPath && pgDataDir) {
      await runCommand(pgCtlPath, ['stop', '-D', pgDataDir, '-m', 'fast', '-t', '60'], { env, progress, stage: 'postgres', logPrefix: 'pg_ctl stop (install app)', quiet: true });
    }
  } catch (_) {}
  return { ok: true };
}

// Start Laravel scheduler (php artisan yualan:check-pending-transactions every minute)
async function startScheduler(phpExe, appRoot, env, progress) {
  // Check if scheduler is already running
  if (processes.scheduler && processes.scheduler.interval) {
    emit(progress, { stage: 'scheduler', message: 'Scheduler is already running' });
    return true;
  }

  emit(progress, { stage: 'scheduler', message: 'Starting Laravel scheduler (runs every minute with visible output)...' });
  
  const artisanPath = path.join(appRoot, 'artisan');
  if (!phpExe || !(await fse.pathExists(artisanPath))) {
    emit(progress, { stage: 'warn', message: 'PHP or artisan not found; skipping scheduler.' });
    return false;
  }

  let runCount = 0;

  // Function to run yualan:check-pending-transactions command
  const runSchedule = async () => {
    try {
      runCount++;
      const now = new Date().toLocaleTimeString();
      emit(progress, { stage: 'scheduler', message: `[${now}] Running scheduled tasks (run #${runCount})...` });
      
      const scheduleResult = await runCommand(phpExe, [artisanPath, 'yualan:check-pending-transactions'], {
        cwd: appRoot,
        env,
        progress,
        stage: 'scheduler',
        logPrefix: 'artisan yualan:check-pending-transactions',
        timeoutMs: 30000,
        quiet: false // Keep output visible for scheduler
      });

      const timeStamp = new Date().toLocaleTimeString();
      if (scheduleResult.code === 0) {
        // Show the actual output from yualan:check-pending-transactions
        const output = scheduleResult.stdout || '';
        if (output.trim()) {
          emit(progress, { stage: 'scheduler', message: `[${timeStamp}] ${output.trim()}` });
        } else {
          emit(progress, { stage: 'scheduler', message: `[${timeStamp}] No scheduled tasks to run (run #${runCount} completed)` });
        }
      } else {
        emit(progress, { stage: 'scheduler', message: `[${timeStamp}] Schedule run #${runCount} completed with exit code: ${scheduleResult.code}` });
        if (scheduleResult.stderr) {
          emit(progress, { stage: 'scheduler', message: `[${timeStamp}] Error: ${scheduleResult.stderr}` });
        }
      }
    } catch (error) {
      const timeStamp = new Date().toLocaleTimeString();
      emit(progress, { stage: 'scheduler', message: `[${timeStamp}] Scheduler error (run #${runCount}): ${error.message}` });
    }
  };

  // Run yualan:check-pending-transactions immediately
  await runSchedule();

  // Set up interval to run every minute (60000ms)
  const schedulerInterval = setInterval(runSchedule, 60000);
  
  // Store the interval reference so we can clear it later
  processes.scheduler = {
    interval: schedulerInterval,
    type: 'scheduler',
    runCount: () => runCount
  };

  emit(progress, { stage: 'scheduler', message: 'Laravel scheduler is now running every minute with visible output' });
  return true;
}

// Start only the services (PostgreSQL + Laravel) with smart port management
async function startServices(progress, options = {}) {
  emit(progress, { stage: 'start', message: 'Starting services...' });
  const installDir = options.installDir;
  if (!installDir) throw new Error('installDir is required');
  const appDir = path.join(installDir, 'app');
  const stackDir = path.join(installDir, 'stack');
  const pgDir = path.join(stackDir, 'postgres');
  const roots = await resolveRoots({ phpDir: path.join(stackDir, 'php'), apacheDir: path.join(stackDir, 'apache'), nodeDir: path.join(stackDir, 'node'), pgDir });

  // Resolve app root (use version marker if exists)
  let appRoot = await resolveAppRoot(appDir);
  try {
    const marker = await fse.readJson(path.join(appDir, 'current.json')).catch(() => null);
    if (marker?.current) {
      const candidate = path.join(appDir, 'versions', String(marker.current));
      if (await fse.pathExists(candidate)) appRoot = await resolveAppRoot(candidate);
    }
  } catch (_) {}

  const env = makeEnvFromRoots(process.env, roots);
  await ensureEnvSafety(appRoot);

  // Check and update ports - this will update UI and .env if needed
  const { webPort, pgPort, portsChanged } = await checkAndUpdatePorts(options, appRoot, progress);
  
  if (portsChanged) {
    // Wait a moment for UI to update
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Start Postgres with the determined port
  const pgDataDir = roots.pgRoot ? path.join(roots.pgRoot, 'data') : path.join(pgDir, 'data');
  await fse.ensureDir(pgDataDir);
  const pgVersionFile = path.join(pgDataDir, 'PG_VERSION');
  if (!(await fse.pathExists(pgVersionFile))) {
    emit(progress, { stage: 'postgres', message: 'Initializing PostgreSQL data directory...' });
    await runInitdb(roots.pgRoot || pgDir, pgDataDir, env, progress);
    await writePgHba(pgDataDir, progress);
  }
  await writePgHba(pgDataDir, progress);
  const pgCtl = await findBinary(path.join(roots.pgRoot || pgDir, 'bin'), ['pg_ctl.exe', 'pg_ctl']);
  if (!pgCtl) throw new Error('pg_ctl not found');
  await fse.ensureDir(path.join(roots.pgRoot || pgDir, 'logs'));
  const serverLog = path.join(roots.pgRoot || pgDir, 'logs', 'server.log');
  const startArgs = ['start', '-w', '-t', '60', '-D', pgDataDir, '-l', serverLog, '-o', `-c port=${pgPort} -c listen_addresses=127.0.0.1`];
  emit(progress, { stage: 'postgres', message: `Starting PostgreSQL on port ${pgPort}...` });
  const startRes = await runCommand(pgCtl, startArgs, { env, progress, stage: 'postgres', logPrefix: 'pg_ctl start', timeoutMs: 70000, quiet: true });
  if (startRes.code !== 0) {
    const logs = await readBestPgLogs(pgDataDir, path.dirname(serverLog));
    emit(progress, { stage: 'postgres', log: `pg_ctl start failed. Logs:\n${logs}` });
    throw new Error('PostgreSQL failed to start');
  }
  const ok = await waitForPostgres(roots.pgRoot || pgDir, pgPort, env, progress, { retries: 90, delayMs: 1000 });
  if (!ok) {
    const logs = await readBestPgLogs(pgDataDir, path.dirname(serverLog));
    emit(progress, { stage: 'postgres', log: `PostgreSQL did not become ready. Logs:\n${logs}` });
    throw new Error('PostgreSQL not ready');
  }
  emit(progress, { stage: 'postgres', message: `PostgreSQL is ready on port ${pgPort}.` });

  // Build frontend (npm run build) before serving, if available
  try {
    const hasPkg = await fse.pathExists(path.join(appRoot, 'package.json'));
    if (hasPkg) {
      emit(progress, { stage: 'npm', message: 'Preparing to build frontend...' });
      
      // Get the best available package manager
      const packageManager = await getBestPackageManager(roots.nodeRoot || path.join(stackDir, 'node'), env, progress);
      
      if (packageManager) {
        emit(progress, { stage: 'npm', message: `Building frontend with ${packageManager.strategy}...` });
        
        const buildCmd = packageManager.strategy === 'yarn' ? ['build'] : 
                        packageManager.strategy === 'pnpm' ? ['run', 'build'] :
                        [...packageManager.prefix, 'run', 'build'];
        
        const buildResult = await runCommand(packageManager.cmd, buildCmd, { 
          cwd: appRoot, 
          env: packageManager.strategy === 'bundled' ? 
                { ...env, PATH: (roots.nodeRoot || path.join(stackDir, 'node')) + path.delimiter + env.PATH } : env,
          progress, stage: 'npm', logPrefix: `${packageManager.strategy} run build` 
        });
        
        if (buildResult.code !== 0) {
          emit(progress, { stage: 'npm', message: `Build failed with ${packageManager.strategy}, but continuing...` });
        }
      } else {
        emit(progress, { stage: 'npm', message: 'No package manager found; skipping build.' });
      }
    }
  } catch (e) {
    emit(progress, { stage: 'npm', message: `Frontend build failed: ${e.message}` });
  }

  // Start Laravel app with php artisan serve using the determined port
  const phpExe = await findBinary(roots.phpRoot || path.join(stackDir, 'php'), ['php.exe', 'php']);
  const artisanPath = path.join(appRoot, 'artisan');
  
  if (!phpExe || !(await fse.pathExists(artisanPath))) {
    emit(progress, { stage: 'warn', message: 'PHP or artisan not found; skipping app serve.' });
    emit(progress, { stage: 'debug', message: `PHP exe: ${phpExe}, Artisan: ${artisanPath}` });
  } else {
    emit(progress, { stage: 'serve', message: `Starting Laravel server in background on port ${webPort}...` });
    emit(progress, { stage: 'debug', message: `Using PHP: ${phpExe}` });
    emit(progress, { stage: 'debug', message: `App root: ${appRoot}` });
    
    try { if (processes.laravel && processes.laravel.pid) { treeKill(processes.laravel.pid); } } catch (_) {}
    
    // Start Laravel server silently in background
    const serveProc = spawn(phpExe, [artisanPath, 'serve', '--host', '127.0.0.1', '--port', String(webPort)], { 
      env, 
      stdio: ['ignore', 'ignore', 'ignore'], // All stdio ignored for silent background operation
      detached: false,
      cwd: appRoot
    });
    
    serveProc.on('close', (code) => {
      const msg = `Laravel server exited with code ${code}`;
      emit(progress, { stage: 'serve', message: msg });
      console.log(`[Laravel] ${msg}`);
      processes.laravel = null;
      
      // Stop scheduler when Laravel stops
      if (processes.scheduler && processes.scheduler.interval) {
        clearInterval(processes.scheduler.interval);
        processes.scheduler = null;
        emit(progress, { stage: 'scheduler', message: 'Scheduler stopped (Laravel server stopped)' });
        console.log('[Scheduler] Stopped due to Laravel server exit');
      }
    });
    
    serveProc.on('error', (err) => {
      const msg = `Laravel server error: ${err.message}`;
      emit(progress, { stage: 'serve', message: msg });
      console.log(`[Laravel] ${msg}`);
      processes.laravel = null;
      
      // Stop scheduler when Laravel errors
      if (processes.scheduler && processes.scheduler.interval) {
        clearInterval(processes.scheduler.interval);
        processes.scheduler = null;
        emit(progress, { stage: 'scheduler', message: 'Scheduler stopped (Laravel server error)' });
        console.log('[Scheduler] Stopped due to Laravel server error');
      }
    });
    
    processes.laravel = serveProc;
    
    // Give Laravel a moment to start up, then start scheduler
    setTimeout(async () => {
      emit(progress, { stage: 'serve', message: `Laravel server running silently in background on http://127.0.0.1:${webPort}` });
      console.log(`[Laravel] Server running silently at http://127.0.0.1:${webPort}`);
      
      // Start the scheduler after Laravel is ready
      try {
        await startScheduler(phpExe, appRoot, env, progress);
      } catch (error) {
        emit(progress, { stage: 'scheduler', message: `Failed to start scheduler: ${error.message}` });
        console.log(`[Scheduler] Failed to start: ${error.message}`);
      }
    }, 2000);
  }
  const appUrl = `http://localhost:${webPort}`;
  emit(progress, { stage: 'done', message: `Services started. PostgreSQL on port ${pgPort}, Laravel server running silently on port ${webPort}, Scheduler showing output every minute.` });
  emit(progress, { stage: 'url', url: appUrl });
  return { ok: true };
}

async function stop(options = {}) {
  const installDir = options.installDir;
  const stackDir = path.join(installDir, 'stack');
  const pgDir = path.join(stackDir, 'postgres');
  const roots = await resolveRoots({ phpDir: path.join(stackDir, 'php'), apacheDir: path.join(stackDir, 'apache'), nodeDir: path.join(stackDir, 'node'), pgDir });
  const env = makeEnvFromRoots(process.env, roots);

  console.log('Stopping all services...');

  // Stop Laravel scheduler (if running)
  try {
    if (processes.scheduler && processes.scheduler.interval) {
      console.log('Stopping Laravel scheduler...');
      clearInterval(processes.scheduler.interval);
    }
  } catch (e) {
    console.log(`Error stopping scheduler: ${e.message}`);
  }
  processes.scheduler = null;

  // Stop Laravel serve (tracked)
  try {
    if (processes.laravel && processes.laravel.pid) {
      console.log(`Stopping Laravel server process (PID: ${processes.laravel.pid})`);
      treeKill(processes.laravel.pid);
    }
  } catch (e) {
    console.log(`Error stopping Laravel process: ${e.message}`);
  }
  processes.laravel = null;

  // Stop Postgres
  try {
    const pgCtl = await findBinary(path.join(roots.pgRoot || pgDir, 'bin'), ['pg_ctl.exe', 'pg_ctl']);
    if (pgCtl) {
      const pgDataDir = path.join(roots.pgRoot || pgDir, 'data');
      console.log(`Stopping PostgreSQL using pg_ctl...`);
      await runCommand(pgCtl, ['stop', '-D', pgDataDir, '-m', 'fast', '-t', '60'], { env, stage: 'postgres', logPrefix: 'pg_ctl stop' });
    }
  } catch (e) {
    console.log(`Error stopping PostgreSQL: ${e.message}`);
  }
  processes.postgres = null;

  // Force kill specific ports if provided
  const webPort = Number(options?.webPort) || 8080;
  const pgPort = Number(options?.pgPort) || 5432;
  
  console.log(`Force killing processes on ports ${webPort} (Laravel) and ${pgPort} (PostgreSQL)...`);
  await killPortProcess(webPort, () => {});
  await killPortProcess(pgPort, () => {});

  // Aggressively kill all postgres.exe processes system-wide
  try {
    if (process.platform === 'win32') {
      console.log('Killing all postgres.exe processes...');
      await runCommand('taskkill', ['/F', '/T', '/IM', 'postgres.exe'], { env, stage: 'postgres', logPrefix: 'taskkill postgres', quiet: true });
    } else {
      console.log('Killing all postgres processes...');
      await runCommand('pkill', ['-f', 'postgres'], { env, stage: 'postgres', logPrefix: 'pkill postgres', quiet: true });
    }
  } catch (_) {}

  // Kill any php artisan serve processes system-wide
  try {
    if (process.platform === 'win32') {
      console.log('Killing all php artisan serve processes...');
      const ps = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*artisan serve*' -or $_.CommandLine -like '*php*artisan*serve*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
      await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env, stage: 'serve', logPrefix: 'kill artisan serve', quiet: true });
    } else {
      console.log('Killing all artisan serve processes...');
      await runCommand('pkill', ['-f', 'artisan serve'], { env, stage: 'serve', logPrefix: 'pkill artisan serve', quiet: true });
    }
  } catch (_) {}
  
  console.log('All services stopped.');
  return { ok: true };
}

async function resetDb(options = {}, progress) {
  emit(progress, { stage: 'postgres', message: 'Resetting PostgreSQL data directory...' });
  const installDir = options.installDir;
  if (!installDir) throw new Error('installDir is required');
  const stackDir = path.join(installDir, 'stack');
  const pgDir = path.join(stackDir, 'postgres');
  const roots = await resolveRoots({ phpDir: path.join(stackDir, 'php'), apacheDir: path.join(stackDir, 'apache'), nodeDir: path.join(stackDir, 'node'), pgDir });
  const env = makeEnvFromRoots(process.env, roots);
  const port = options.pgPort || 5432;
  const pgDataDir = path.join(roots.pgRoot || pgDir, 'data');

  // Stop if running
  try {
    const pgCtl = await findBinary(path.join(roots.pgRoot || pgDir, 'bin'), ['pg_ctl.exe', 'pg_ctl']);
    if (pgCtl) await runCommand(pgCtl, ['stop', '-D', pgDataDir, '-m', 'fast', '-t', '60'], { env, stage: 'postgres', logPrefix: 'pg_ctl stop' });
  } catch (_) {}

  await fse.remove(pgDataDir).catch(() => {});
  await fse.ensureDir(pgDataDir);
  await runInitdb(roots.pgRoot || pgDir, pgDataDir, env, progress);
  await writePgHba(pgDataDir, progress);

  // Start & wait
  const pgCtl2 = await findBinary(path.join(roots.pgRoot || pgDir, 'bin'), ['pg_ctl.exe', 'pg_ctl']);
  await fse.ensureDir(path.join(roots.pgRoot || pgDir, 'logs'));
  const serverLog = path.join(roots.pgRoot || pgDir, 'logs', 'server.log');
  const startArgs = ['start', '-w', '-t', '60', '-D', pgDataDir, '-l', serverLog, '-o', `-c port=${port} -c listen_addresses=127.0.0.1`];
  await runCommand(pgCtl2, startArgs, { env, progress, stage: 'postgres', logPrefix: 'pg_ctl start', timeoutMs: 70000, quiet: true });
  const ok = await waitForPostgres(roots.pgRoot || pgDir, port, env, progress, { retries: 90, delayMs: 1000 });
  if (!ok) {
    const logs = await readBestPgLogs(pgDataDir, path.dirname(serverLog));
    emit(progress, { stage: 'postgres', log: `PostgreSQL did not become ready after reset. Logs:\n${logs}` });
    throw new Error('PostgreSQL not ready after reset');
  }

  // Recreate role/db/privs
  const dbUser = options.pgUser || 'yualan';
  const dbPass = options.pgPassword || 'yualan';
  const dbName = options.pgDatabase || 'yualan';
  await ensureRoleDb(roots.pgRoot || pgDir, port, { user: dbUser, password: dbPass, database: dbName }, env, progress);
  await ensureDbPrivileges(roots.pgRoot || pgDir, port, { user: dbUser, database: dbName }, env, progress);
  emit(progress, { stage: 'postgres', message: 'Database reset complete.' });
  return { ok: true };
}

// Check if an installation directory contains valid installation components
async function checkExistingInstallation(installDir) {
  try {
    // Check for essential stack components
    const stackPath = path.join(installDir, 'stack');
    const phpPath = path.join(stackPath, 'php');
    const nodePath = path.join(stackPath, 'node');
    const pgPath = path.join(stackPath, 'pgsql');
    
    // Check if stack directory and core components exist
    const hasStack = await fse.pathExists(stackPath);
    const hasPhp = await fse.pathExists(phpPath);
    const hasNode = await fse.pathExists(nodePath);
    const hasPg = await fse.pathExists(pgPath);
    
    // Check for app directory
    const appPath = path.join(installDir, 'app');
    const hasApp = await fse.pathExists(appPath);
    
    // Check for .env file in app directory
    let hasEnv = false;
    if (hasApp) {
      try {
        const appRoot = await resolveAppRoot(appPath);
        const envFile = path.join(appRoot, '.env');
        hasEnv = await fse.pathExists(envFile);
      } catch (_) {}
    }
    
    // Consider installation valid if it has:
    // 1. Stack components (PHP, Node, PostgreSQL) - indicates server setup completed
    // 2. App directory with .env - indicates app installation completed
    const hasServerStack = hasStack && (hasPhp || hasNode || hasPg);
    const hasAppInstallation = hasApp && hasEnv;
    
    return {
      hasValidInstallation: hasServerStack && hasAppInstallation,
      hasServerStack,
      hasAppInstallation,
      components: {
        stack: hasStack,
        php: hasPhp,
        node: hasNode,
        postgresql: hasPg,
        app: hasApp,
        env: hasEnv
      }
    };
  } catch (err) {
    return {
      hasValidInstallation: false,
      hasServerStack: false,
      hasAppInstallation: false,
      components: {}
    };
  }
}

async function cleanupPorts() {
  console.log('Force cleanup: Killing all Laravel serve and PostgreSQL processes...');
  
  try {
    if (process.platform === 'win32') {
      // Kill all postgres.exe processes
      console.log('Killing all postgres.exe processes...');
      await runCommand('taskkill', ['/F', '/T', '/IM', 'postgres.exe'], { quiet: true });
      
      // Kill all php processes that might be running artisan serve
      console.log('Killing all PHP processes...');
      await runCommand('taskkill', ['/F', '/T', '/IM', 'php.exe'], { quiet: true });
      
      // Kill processes by port - common Laravel and PostgreSQL ports
      const commonPorts = [8080, 8000, 3000, 5432, 5433];
      for (const port of commonPorts) {
        try {
          await killPortProcess(port, () => {});
          console.log(`Killed processes on port ${port}`);
        } catch (_) {}
      }
      
      // Use PowerShell to kill any remaining artisan serve processes
      console.log('Killing artisan serve processes via PowerShell...');
      const ps = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*artisan serve*' -or $_.CommandLine -like '*php*artisan*serve*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
      await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { quiet: true });
      
    } else {
      // Unix/Linux/macOS
      console.log('Killing all postgres processes...');
      await runCommand('pkill', ['-f', 'postgres'], { quiet: true });
      
      console.log('Killing all artisan serve processes...');
      await runCommand('pkill', ['-f', 'artisan serve'], { quiet: true });
      
      console.log('Killing all php processes...');
      await runCommand('pkill', ['-f', 'php'], { quiet: true });
    }
  } catch (e) {
    console.log(`Cleanup warning: ${e.message}`);
  }
  
  // Reset our tracked processes
  if (processes.scheduler && processes.scheduler.interval) {
    clearInterval(processes.scheduler.interval);
  }
  processes.postgres = null;
  processes.laravel = null;
  processes.queue = null;
  processes.scheduler = null;
  
  console.log('Force cleanup completed.');
  return { ok: true };
}

module.exports = {
  // New API
  setupServer,
  installApp,
  startServices,
  readExistingEnv,
  checkExistingInstallation,
  // Backward-compatible exports
  install,
  start,
  stop,
  resetDb,
  cleanupPorts,
};
