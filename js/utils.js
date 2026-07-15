/**
 * RuddhaaConnect ERP - Utility Functions
 * Common helper functions
 */

(function() {
    'use strict';

    function formatCurrency(num) {
        if (!num && num !== 0) return '—';
        const parsed = parseFloat(num);
        return parsed.toLocaleString('en-IN', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }

    function formatDate(date) {
        if (!date) return '—';
        const d = new Date(date);
        return d.toLocaleDateString('en-IN');
    }

    function formatTime(time) {
        if (!time) return '—';
        const parts = time.split(':');
        if (parts.length < 2) return time;
        return `${parts[0]}:${parts[1]}`;
    }

    function formatDateTime(datetime) {
        if (!datetime) return '—';
        return `${formatDate(datetime)} ${formatTime(datetime)}`;
    }

    function capitalizeFirst(str) {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    function throttle(func, limit) {
        let inThrottle;
        return function(...args) {
            if (!inThrottle) {
                func.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }

    function getQueryParam(name) {
        const params = new URLSearchParams(window.location.search);
        return params.get(name);
    }

    function setQueryParam(name, value) {
        const params = new URLSearchParams(window.location.search);
        params.set(name, value);
        window.history.replaceState({}, '', `${window.location.pathname}?${params}`);
    }

    // Export functions
    window.Utils = {
        fmt: formatCurrency,
        formatCurrency: formatCurrency,
        formatDate: formatDate,
        formatTime: formatTime,
        formatDateTime: formatDateTime,
        capitalize: capitalizeFirst,
        debounce: debounce,
        throttle: throttle,
        getQueryParam: getQueryParam,
        setQueryParam: setQueryParam
    };
})();
