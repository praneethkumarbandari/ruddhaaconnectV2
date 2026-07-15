/**
 * RuddhaaConnect Accounting V1 — Authentication Module
 * Session management backed by Accounting V1's real /api/auth/login
 * endpoint (POST { username, password } -> { token, user }).
 *
 * Accounting V1 has no /api/auth/me endpoint (confirmed by reading
 * src/routes/auth.ts — only POST /login exists), so unlike the
 * original version of this file, checkAuth() cannot round-trip the
 * token against the server to confirm it's still valid. It checks for
 * the token's presence only; a genuinely expired/invalid token will
 * still be caught the moment any real API call 401s, since
 * api-client.js already clears the session and redirects on 401 —
 * this just means an expired session is caught on the first real
 * request rather than at page load. Worth adding a real /auth/me
 * endpoint later if a page-load-time check becomes important; not
 * added here since that would be a backend change beyond what this
 * integration pass is scoped to do.
 */
(function () {
    'use strict';

    function getEmployee() {
        return JSON.parse(localStorage.getItem('rc_user') || 'null');
    }

    function getToken() {
        return localStorage.getItem('rc_token');
    }

    function isAuthenticated() {
        return !!getToken();
    }

    function redirectToLogin() {
        const currentPath = window.location.pathname;
        if (!currentPath.includes('login') && !currentPath.includes('about') && !currentPath.includes('contact')) {
            window.top.location.href = '/login.html';
        }
    }

    function checkAuth() {
        if (!isAuthenticated()) {
            redirectToLogin();
            return null;
        }
        return getEmployee();
    }

    async function login(username, password) {
        const result = await window.Api.post('/auth/login', { username, password });
        localStorage.setItem('rc_token', result.token);
        localStorage.setItem('rc_user', JSON.stringify(result.user));
        // Legacy key — some shared nav/theme JS still reads this
        // directly instead of going through Auth.getEmployee().
        localStorage.setItem('loggedEmployee', JSON.stringify(result.user));
        return result.user;
    }

    function logout() {
        localStorage.removeItem('rc_token');
        localStorage.removeItem('rc_user');
        localStorage.removeItem('loggedEmployee');
        localStorage.removeItem('portalTheme');
        window.top.location.href = '/login.html';
    }

    window.Auth = {
        checkAuth: checkAuth,
        login: login,
        logout: logout,
        getEmployee: getEmployee,
        getToken: getToken,
        isAuthenticated: isAuthenticated,
    };
})();
