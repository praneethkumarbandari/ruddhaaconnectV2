/**
 * RuddhaaConnect ERP - Modal Module
 * Modal dialog management
 */

(function() {
    'use strict';

    function openModal(modalId) {
        const modal = document.getElementById(modalId) || document.querySelector(`[data-modal="${modalId}"]`);
        if (!modal) {
            console.warn(`Modal not found: ${modalId}`);
            return;
        }
        
        const overlay = modal.closest('.modal-overlay');
        if (overlay) {
            overlay.classList.add('active');
            overlay.style.display = 'flex';
        } else {
            modal.classList.add('active');
            modal.style.display = 'block';
        }
    }

    function closeModal(modalId) {
        const modal = document.getElementById(modalId) || document.querySelector(`[data-modal="${modalId}"]`);
        if (!modal) return;
        
        const overlay = modal.closest('.modal-overlay');
        if (overlay) {
            overlay.classList.remove('active');
            overlay.style.display = 'none';
        } else {
            modal.classList.remove('active');
            modal.style.display = 'none';
        }
    }

    function closeAllModals() {
        const overlays = document.querySelectorAll('.modal-overlay');
        overlays.forEach(overlay => {
            overlay.classList.remove('active');
            overlay.style.display = 'none';
        });
    }

    function confirmDialog(title, message, onConfirm, onCancel) {
        // Create simple confirm dialog
        if (window.confirm(message)) {
            if (onConfirm) onConfirm();
        } else {
            if (onCancel) onCancel();
        }
    }

    // Auto-bind modal close buttons
    function setupModalHandlers() {
        const modalCloses = document.querySelectorAll('[data-modal-close]');
        modalCloses.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const modal = e.target.closest('.modal-overlay') || e.target.closest('[data-modal]');
                if (modal) {
                    modal.classList.remove('active');
                    modal.style.display = 'none';
                }
            });
        });

        // Overlay click closes modal
        const overlays = document.querySelectorAll('.modal-overlay');
        overlays.forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    overlay.classList.remove('active');
                    overlay.style.display = 'none';
                }
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupModalHandlers);
    } else {
        setupModalHandlers();
    }

    // Export functions
    window.Modal = {
        open: openModal,
        close: closeModal,
        closeAll: closeAllModals,
        confirm: confirmDialog
    };
})();
