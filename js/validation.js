/**
 * RuddhaaConnect ERP - Validation Module
 * Form and input validation
 */

(function() {
    'use strict';

    function sanitizeInput(input) {
        if (!input) return '';
        return input.toString().trim().replace(/[<>]/g, '');
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

    function validateEmail(email) {
        const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return regex.test(email);
    }

    function validatePhone(phone) {
        const regex = /^\d{10}$/;
        return regex.test(phone.replace(/\D/g, ''));
    }

    function validateNumber(num) {
        return !isNaN(parseFloat(num)) && isFinite(num);
    }

    function validateRequired(value) {
        return value && value.toString().trim() !== '';
    }

    function validateMinLength(value, min) {
        return value && value.toString().length >= min;
    }

    function validateMaxLength(value, max) {
        return !value || value.toString().length <= max;
    }

    function validatePattern(value, pattern) {
        return new RegExp(pattern).test(value);
    }

    function validateField(field) {
        const value = field.value;
        const required = field.hasAttribute('required');
        const email = field.type === 'email';
        const minLength = field.getAttribute('minlength');
        const maxLength = field.getAttribute('maxlength');
        const pattern = field.getAttribute('pattern');

        let isValid = true;
        let error = '';

        if (required && !validateRequired(value)) {
            isValid = false;
            error = 'This field is required';
        } else if (email && value && !validateEmail(value)) {
            isValid = false;
            error = 'Please enter a valid email';
        } else if (minLength && value && !validateMinLength(value, minLength)) {
            isValid = false;
            error = `Minimum ${minLength} characters required`;
        } else if (maxLength && value && !validateMaxLength(value, maxLength)) {
            isValid = false;
            error = `Maximum ${maxLength} characters allowed`;
        } else if (pattern && value && !validatePattern(value, pattern)) {
            isValid = false;
            error = 'Invalid format';
        }

        updateFieldState(field, isValid, error);
        return isValid;
    }

    function validateForm(form) {
        const fields = form.querySelectorAll('input, textarea, select');
        let allValid = true;

        fields.forEach(field => {
            if (!validateField(field)) {
                allValid = false;
            }
        });

        return allValid;
    }

    function updateFieldState(field, isValid, error) {
        field.classList.toggle('is-invalid', !isValid);
        field.classList.toggle('is-valid', isValid);

        const feedback = field.nextElementSibling;
        if (feedback && feedback.classList.contains('invalid-feedback')) {
            feedback.textContent = error;
            feedback.style.display = isValid ? 'none' : 'block';
        }
    }

    function setupFormValidation(form) {
        const fields = form.querySelectorAll('input, textarea, select');
        
        fields.forEach(field => {
            field.addEventListener('blur', () => validateField(field));
            field.addEventListener('change', () => validateField(field));
        });

        form.addEventListener('submit', (e) => {
            if (!validateForm(form)) {
                e.preventDefault();
                Toast.error('Please fix the errors in the form');
            }
        });
    }

    // Export functions
    window.Validation = {
        sanitize: sanitizeInput,
        escape: escapeHtml,
        email: validateEmail,
        phone: validatePhone,
        number: validateNumber,
        required: validateRequired,
        minLength: validateMinLength,
        maxLength: validateMaxLength,
        pattern: validatePattern,
        field: validateField,
        form: validateForm,
        setupForm: setupFormValidation
    };
})();
