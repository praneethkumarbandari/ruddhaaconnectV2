/**
 * RuddhaaConnect ERP - Application Bootstrap
 * Core application initialization
 */

(function() {
    'use strict';

    // Application version
    const APP_VERSION = '2.0.0';
    
    // Initialize on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeApp);
    } else {
        initializeApp();
    }

    function initializeApp() {
        // 1. Initialize theme
        initializeTheme();
        
        // 2. Initialize authentication
        initializeAuth();
        
        // 3. Initialize navigation (if sidebar exists)
        if (document.querySelector('.sidebar')) {
            initializeNavigation();
        }
        
        // 4. Set up global error handler
        window.addEventListener('error', handleGlobalError);
        
        // 5. Initialize components
        initializeComponents();
        
        console.log(`RuddhaaConnect ERP v${APP_VERSION} initialized`);
    }

    function initializeTheme() {
        try {
            const cached = localStorage.getItem('portalTheme');
            if (cached) {
                const theme = JSON.parse(cached);
                if (theme.primary_color) {
                    document.documentElement.style.setProperty('--primary-color', theme.primary_color);
                }
                if (theme.secondary_color) {
                    document.documentElement.style.setProperty('--secondary-color', theme.secondary_color);
                }
                if (theme.background_color) {
                    document.documentElement.style.setProperty('--background-color', theme.background_color);
                }
                if (theme.font_family) {
                    document.documentElement.style.setProperty('--font-family', theme.font_family);
                }
            }
        } catch (e) {
            console.warn('Theme initialization failed', e);
        }
    }

    function initializeAuth() {
        // Auth will be initialized by auth.js when loaded
        const emp = JSON.parse(localStorage.getItem('loggedEmployee') || 'null');
        const rcUser = JSON.parse(localStorage.getItem('rc_user') || 'null');
        if (!emp && !rcUser && !isPublicPage()) {
            redirectToLogin();
        }
    }

    function initializeNavigation() {
        // Navigation will be initialized by navigation.js when loaded
    }

    function initializeComponents() {
        // Set up modal close handlers
        const modalCloseButtons = document.querySelectorAll('[data-modal-close]');
        modalCloseButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const modal = e.target.closest('[data-modal]');
                if (modal) {
                    modal.classList.remove('active');
                }
            });
        });
    }

    function handleGlobalError(event) {
        console.error('Global error:', event.error);
        // Don't stop propagation - let browser handle it
    }

    function isPublicPage() {
        const pathname = window.location.pathname;
        if (pathname === '/' || pathname === '') return true;
        return /\/(login|business-login|customer-login|about|contact|index)\.html/.test(pathname);
    }

    function redirectToLogin() {
        if (window.location.pathname !== '/business-login.html') {
            window.location.href = '/business-login.html';
        }
    }

    // Export for testing
    window.App = {
        version: APP_VERSION,
        init: initializeApp
    };
})();
