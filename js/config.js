/**
 * RuddhaaConnect Accounting V1 — frontend environment configuration.
 *
 * This is the ONE place that needs to change between environments
 * (local dev, SAT, production). Every other file reads
 * window.RUDDHAA_API_BASE_URL instead of hardcoding a host.
 *
 * IMPORTANT: this is a plain static site with no build step — there
 * is no bundler or CI process here to inject an environment variable
 * at build time. The value below must be edited directly in this
 * file before each deploy (or replaced by a small script/sed step in
 * whatever CI process publishes this site) — it will not pick up a
 * Netlify environment variable on its own the way a bundled frontend
 * (Vite/webpack/etc.) would.
 *
 * The backend is now a Netlify Function (see backend's netlify.toml),
 * not a standalone Express server. If this frontend and the backend
 * are deployed as the SAME Netlify site, set this to the relative
 * path '/api' (same-origin, no host needed). If they are deployed as
 * TWO separate Netlify sites (as built and tested in this project),
 * set this to that backend site's full URL, e.g.
 * 'https://ruddhaa-accounting-api.netlify.app/api'.
 */
window.RUDDHAA_API_BASE_URL = window.RUDDHAA_API_BASE_URL || '/api';
