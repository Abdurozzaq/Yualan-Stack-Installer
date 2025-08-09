# Yualan Stack Installer

Electron-based portable stack installer for Laravel + Inertia + Vue + PostgreSQL on Windows.

What you get:
- Portable PHP + Apache
- Portable Node.js
- Portable PostgreSQL
- Your Laravel app (Inertia + Vue)
- One GUI to install, start/stop, open app
 - One GUI with clear actions: Setup Server, Install App, Start Services

## Project layout
- `src/main` Electron main process, installer logic
- `src/renderer` Simple UI
- `templates` Handlebars templates for .env and configs
- `payloads` Place zipped binaries here (or provide URLs)

## Prepare payloads
Two ways:

1) Local zips (recommended for offline installs). Put these files in the project or pick them via the UI:
	- `payloads/php/php.zip` → Portable PHP for Windows (include php.exe; composer.phar optional — the app will auto-download if missing)
	- `payloads/apache/apache.zip` → Apache httpd for Windows (must include `bin/httpd.exe`)
	- `payloads/node/node.zip` → Node.js for Windows x64 (must include `node.exe` and `npm.cmd`)
	- `payloads/postgres/postgres.zip` → PostgreSQL Windows binaries (must include `bin/pg_ctl.exe` and `bin/psql.exe`)
	- `payloads/app/app.zip` → Your Laravel app source (contains `artisan`, `composer.json`, `package.json`, etc.)

	The app UI has “Pick” buttons to select these zips if you prefer not to place them under `payloads/`.

2) URLs (optional). You can extend the UI to pass URLs so the installer downloads them. The code supports this via options but the default UI does not expose URL fields yet.

Alternatively, provide URLs in the code or UI to download at install time.

## Development
### Actions overview
- Setup Server: Installs the base stack (PHP, Apache, Composer, Node.js, NPM, PostgreSQL) and provisions the database and user.
- Install App: Installs your application code (supports multiple/dynamic versions and multiple zip sources) and runs composer/npm/build/migrations.
- Start Services: Starts only PostgreSQL and Apache for the currently installed app.

1) Install dependencies
```bash
npm install
```

2) Run the app
```bash
npm start
```

3) (Optional) Auto-download common payloads
```bash
# Downloads Node, PHP, composer.phar by default
# Optionally set URLs to also fetch Apache and PostgreSQL
# APACHE_ZIP_URL and POSTGRES_ZIP_URL must be direct zip links
APACHE_ZIP_URL="https://example.com/apache-win64.zip" \
POSTGRES_ZIP_URL="https://example.com/postgresql-win64.zip" \
npm run fetch
```

## Build portable exe
```bash
npm run build
```

## Notes
- This is a scaffold. You need to supply actual binaries and adjust template(s) for PHP integration with Apache (e.g., mod_php or PHP-CGI via fcgid). On Windows, httpd + php-cgi is a common approach.
- Ensure .env values match your PostgreSQL auth settings.
- For production-like usage, consider generating APP_KEY before first start and writing it to `.env`.
 - If you see `pg_ctl.exe not found`, make sure your Postgres zip has `bin/pg_ctl.exe` within the first few directory levels. The app searches recursively (depth 4).
 - Composer: If `composer.phar` isn’t in your PHP zip, the app tries to download it during Start.
