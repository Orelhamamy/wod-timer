import { defineConfig, loadEnv } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = process.cwd();
const PUBLIC_DIR = resolve(ROOT, 'public');

// Only this endpoint shape may pass through the proxy.
const ALLOWED_API_PATH = /^\/api\/gemini\/v1beta\/models\/[\w.-]+:generateContent$/;

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

/**
 * Builds dist/sw.js from src/sw.js, injecting the list of hashed build assets
 * so the app shell can be precached and opened offline.
 */
function serviceWorkerPlugin() {
  return {
    name: 'wod-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const hash = createHash('sha256');
      const publicFiles = listFiles(PUBLIC_DIR).map((file) => {
        hash.update(readFileSync(file));
        return relative(PUBLIC_DIR, file).split('\\').join('/');
      });
      const bundleFiles = Object.keys(bundle)
        .filter((f) => !f.endsWith('.map'));
      bundleFiles.forEach((f) => hash.update(f));

      // Paths are relative to sw.js, so the app works at / or under a subpath.
      const precache = [...new Set(['./', 'index.html', ...bundleFiles, ...publicFiles])];
      const source = readFileSync(resolve(ROOT, 'src/sw.js'), 'utf8')
        .replace('__SW_VERSION__', hash.digest('hex').slice(0, 12))
        .replace('__PRECACHE_MANIFEST__', JSON.stringify(precache, null, 2));

      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig(({ mode }) => {
  // '' prefix = load every variable from .env, not only VITE_* ones.
  const env = loadEnv(mode, ROOT, '');
  const apiKey = env.VITE_GEMINI_API_KEY || env.GEMINI_API_KEY;

  if (!apiKey) {
    console.warn('\n[wod-timer] VITE_GEMINI_API_KEY is not set. Copy .env.example to .env.\n');
  }

  // The key is added here, server side. Client code calls /api/gemini/... and never sees it.
  const proxy = {
    '/api/gemini': {
      target: 'https://generativelanguage.googleapis.com',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api\/gemini/, ''),
      headers: { 'x-goog-api-key': apiKey ?? '' },
      bypass(req) {
        const path = req.url.split('?')[0];
        if (req.method !== 'POST' || !ALLOWED_API_PATH.test(path)) return false; // -> 404
      },
    },
  };

  // Tailscale Serve forwards https://<machine>.<tailnet>.ts.net to localhost.
  const allowedHosts = ['.ts.net'];

  return {
    // Relative URLs: the same build runs on the zbook, GitHub Pages (/repo/) or Cloudflare Pages.
    base: './',
    plugins: [serviceWorkerPlugin()],
    server: { host: '127.0.0.1', port: 5173, proxy, allowedHosts },
    preview: { host: '127.0.0.1', port: 4173, proxy, allowedHosts },
    build: { target: 'es2020' },
  };
});
