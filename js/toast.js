/**
 * RuddhaaConnect ERP - Toast Notification Module
 * Toast message management
 */

(function() {
    'use strict';

    const TOAST_TIMEOUT = 4000;

    function showToast(message, type = 'info', duration = TOAST_TIMEOUT) {
        const container = getOrCreateContainer();
        
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <span class="toast-icon">${getIcon(type)}</span>
            <span class="toast-message">${escapeHtml(message)}</span>
            <button class="toast-close" aria-label="Close">&times;</button>
        `;

        const closeBtn = toast.querySelector('.toast-close');
        closeBtn.addEventListener('click', () => removeToast(toast));

        container.appendChild(toast);

        if (duration > 0) {
            setTimeout(() => removeToast(toast), duration);
        }

        return toast;
    }

    function showSuccess(message, duration = TOAST_TIMEOUT) {
        return showToast(message, 'success', duration);
    }

    function showError(message, duration = TOAST_TIMEOUT) {
        return showToast(message, 'error', duration);
    }

    function showWarning(message, duration = TOAST_TIMEOUT) {
        return showToast(message, 'warning', duration);
    }

    function showInfo(message, duration = TOAST_TIMEOUT) {
        return showToast(message, 'info', duration);
    }

    function removeToast(toast) {
        toast.style.animation = 'toastSlideOut 0.3s ease-in forwards';
        setTimeout(() => toast.remove(), 300);
    }

    function getOrCreateContainer() {
        let container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }
        return container;
    }

    function getIcon(type) {
        const icons = {
            success: '✓',
            error: '✕',
            warning: '⚠',
            info: 'ℹ'
        };
        return icons[type] || '•';
    }

    function escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    // Export functions
    window.Toast = {
        show: showToast,
        success: showSuccess,
        error: showError,
        warning: showWarning,
        info: showInfo
    };
})();
