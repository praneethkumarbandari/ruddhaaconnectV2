/**
 * RuddhaaConnect Accounting V1 — API Client
 *
 * Talks to the standalone Accounting V1 Express backend (see
 * config.js for the base URL — NOT the same-origin Netlify Function
 * used by the rest of the RuddhaaConnect stack, since Accounting V1
 * is a separate, standalone server). Every wired page calls
 * window.Api.* instead of talking to Supabase directly.
 */
(function () {
    'use strict';

    const BASE_URL = window.RUDDHAA_API_BASE_URL;

    function getToken() {
        return localStorage.getItem('rc_token');
    }

    function clearSession() {
        localStorage.removeItem('rc_token');
        localStorage.removeItem('rc_user');
        localStorage.removeItem('loggedEmployee');
    }

    async function request(path, options = {}) {
        const token = getToken();
        const headers = {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
            ...(options.headers || {}),
        };

        let response;
        try {
            response = await fetch(BASE_URL + path, { ...options, headers });
        } catch (networkErr) {
            throw new Error('Network error: could not reach the server.');
        }

        if (response.status === 401) {
            // Token missing/expired/invalid — the session is no longer
            // valid server-side, so don't let the page keep acting on
            // stale localStorage data.
            clearSession();
            if (!window.location.pathname.includes('login')) {
                window.location.href = '/login.html';
            }
            throw new Error('Session expired. Please log in again.');
        }

        let body = null;
        const text = await response.text();
        if (text) {
            try {
                body = JSON.parse(text);
            } catch {
                body = text;
            }
        }

        if (!response.ok) {
            const message = (body && body.error) || response.statusText || 'Request failed';
            const err = new Error(message);
            err.status = response.status;
            err.body = body;
            throw err;
        }

        return body;
    }

    window.Api = {
        get: (path) => request(path, { method: 'GET' }),
        post: (path, data) => request(path, { method: 'POST', body: JSON.stringify(data) }),
        patch: (path, data) => request(path, { method: 'PATCH', body: JSON.stringify(data) }),
        put: (path, data) => request(path, { method: 'PUT', body: JSON.stringify(data) }),
        delete: (path) => request(path, { method: 'DELETE' }),
        // FIX: request() above always parses the response as JSON/text,
        // which would corrupt a binary response like a PDF. Used for
        // Invoice/Receipt/Payment PDF downloads — fetches the same way
        // (with the auth token attached) but treats the body as a blob
        // and triggers a real browser download instead.
        downloadFile: async (path, suggestedFilename) => {
            const token = getToken();
            const headers = token ? { Authorization: 'Bearer ' + token } : {};
            let response;
            try {
                response = await fetch(BASE_URL + path, { method: 'GET', headers });
            } catch (networkErr) {
                throw new Error('Network error: could not reach the server.');
            }
            if (!response.ok) {
                let message = response.statusText || 'Download failed';
                try { const body = await response.json(); if (body && body.error) message = body.error; } catch {}
                throw new Error(message);
            }
            const blob = await response.blob();
            const disposition = response.headers.get('Content-Disposition') || '';
            const match = disposition.match(/filename="([^"]+)"/);
            const filename = suggestedFilename || (match && match[1]) || 'download.pdf';
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(url);
        },
    };
})();
