/**
 * RuddhaaConnect ERP - Theme Module
 * Loads branding/theme settings from portal_config and applies them
 * as CSS variables. Single source of truth — do not re-implement this
 * inline in individual pages.
 */

(function () {
    'use strict';

    function applyTheme(data) {
        if (!data) return;
        if (data.primary_color)
            document.documentElement.style.setProperty('--primary-color', data.primary_color);
        if (data.secondary_color)
            document.documentElement.style.setProperty('--secondary-color', data.secondary_color);
        if (data.background_color)
            document.documentElement.style.setProperty('--background-color', data.background_color);
        if (data.font_family)
            document.documentElement.style.setProperty('--font-family', data.font_family);
    }

    // Apply any cached theme immediately (covers the brief window before
    // the DB round-trip resolves, so the page doesn't flash default colors).
    (function applyCachedThemeEarly() {
        try {
            const cached = localStorage.getItem('portalTheme');
            if (cached) applyTheme(JSON.parse(cached));
        } catch (e) { /* ignore malformed cache */ }
    })();

    /**
     * Fetch portal_config, apply it as CSS variables, update the
     * company name / logo elements if present on the page, and cache
     * it to localStorage for next time.
     *
     * FIX (theme not saving): this used to always call
     * db.from('portal_config').select('*')... directly against
     * Supabase, bypassing the backend entirely. That read resolves
     * outside the tenant's schema (search_path is only set per-request
     * on the Express backend, not on the browser's raw Supabase
     * client), so it could return a different/stale/empty row than the
     * one Settings just saved — then immediately overwrite the
     * correct, just-cached localStorage value with that wrong data on
     * every page load. A save would visibly apply, then silently
     * "undo" itself on the next navigation.
     *
     * Now: once an employee is logged in (an rc_token exists), this
     * goes through window.Api -> GET /api/settings/branding, the same
     * tenant-scoped backend fix applied in js/shell.js. The direct
     * Supabase read is kept ONLY as the pre-login fallback (e.g.
     * business-login.html, index.html render before any token exists,
     * so there is no authenticated tenant context to ask the backend
     * for yet) — unchanged from before for that specific case.
     *
     * @param {Object} [options]
     * @param {string} [options.titleSuffix] - appended to document.title as "Company - <suffix>"
     * @param {string} [options.companyNameElId] - id of element to receive the company name (default "companyName")
     * @param {string} [options.companyLogoElId] - id of element (an <img>) to receive the logo (default "companyLogo")
     * @returns {Promise<Object|null>} the branding/theme data, or null on failure
     */
    async function load(options) {
        options = options || {};
        const titleSuffix = options.titleSuffix || '';
        const nameElId = options.companyNameElId || 'companyName';
        const logoElId = options.companyLogoElId || 'companyLogo';

        const hasSession = !!localStorage.getItem('rc_token');

        try {
            let data;
            if (hasSession && window.Api) {
                data = await window.Api.get('/settings/branding');
            } else {
                const db = window.db;
                if (!db) return null;
                const result = await db.from('portal_config').select('*').limit(1).maybeSingle();
                data = result && result.data;
            }
            if (!data) return null;

            applyTheme(data);

            const nameEl = document.getElementById(nameElId);
            if (data.company_name) {
                if (nameEl) nameEl.textContent = data.company_name;
                document.title = titleSuffix ? (data.company_name + ' - ' + titleSuffix) : data.company_name;
            }

            const logoEl = document.getElementById(logoElId);
            if (logoEl) {
                if (data.logo_path && data.logo_path.trim()) {
                    logoEl.src = data.logo_path.trim();
                    logoEl.onload = function () { logoEl.style.display = 'block'; };
                    logoEl.onerror = function () { logoEl.style.display = 'none'; };
                } else {
                    logoEl.style.display = 'none';
                }
            }

            localStorage.setItem('portalTheme', JSON.stringify(data));
            return data;
        } catch (err) {
            console.log('Theme load error:', err);
            return null;
        }
    }

    window.Theme = {
        load: load,
        applyTheme: applyTheme
    };
})();
