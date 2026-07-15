/**
 * RuddhaaConnect ERP - Supabase Client
 * Centralized database initialization
 */

(function() {
    'use strict';

    const SUPABASE_URL = 'https://ceutauofwiohvxzsqude.supabase.co';
    const SUPABASE_KEY = 'sb_publishable_cECTRlGyMD_6kT2qfpWCuA_5l8O08du';

    let _client = null;

    function getClient() {
        if (!_client) {
            if (typeof window.supabase === 'undefined') {
                console.error('Supabase library not loaded');
                return null;
            }
            _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        }
        return _client;
    }

    function getAuth() {
        return getClient()?.auth;
    }

    function query(table) {
        const client = getClient();
        if (!client) return null;
        return client.from(table);
    }

    // Export global db object
    if (!window.db) {
        window.db = getClient();
    }

    // Export functions
    window.Supabase = {
        getClient: getClient,
        getAuth: getAuth,
        query: query
    };
})();
