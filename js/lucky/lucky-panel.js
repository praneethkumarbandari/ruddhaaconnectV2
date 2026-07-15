/**
 * Lucky panel wiring. Only loaded (dynamically, via shell.js) when
 * window.LUCKY_ENABLED === true. Defines window.Lucky.toggle() for
 * the button/panel markup in components/lucky/lucky-panel.html.
 */
(function () {
    'use strict';

    function toggle() {
        var panel = document.getElementById('luckyPanel');
        if (panel) panel.classList.toggle('open');
    }

    window.Lucky = {
        toggle: toggle
    };
})();
