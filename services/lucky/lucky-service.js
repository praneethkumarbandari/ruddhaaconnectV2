/**
 * Lucky service layer — placeholder.
 *
 * This is where future calls to a Lucky backend/AI endpoint will
 * live, kept separate from the UI wiring in js/lucky/lucky-panel.js
 * so the eventual real implementation doesn't need to touch panel
 * markup or toggle logic. Only loaded when window.LUCKY_ENABLED is
 * true (see js/shell.js).
 */
(function () {
    'use strict';

    async function sendMessage(message) {
        // Placeholder — no backend wired up yet.
        return { reply: 'Lucky is not yet available in this build.' };
    }

    window.LuckyService = {
        sendMessage: sendMessage
    };
})();
