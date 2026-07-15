/**
 * RuddhaaConnect ERP - Navigation Module
 * Sidebar and menu management
 */

(function() {
    'use strict';

    function setupNavigation() {
        // NOTE: Sidebar-toggle and group-toggle (accordion) clicks are already
        // wired up inline on each page (toggleGroup(this) / #sidebarToggle
        // listener defined in each page's own <script>). Attaching a second,
        // competing listener here caused every click to toggle the "open"/
        // "collapsed" class on then immediately back off, so menus appeared
        // completely unresponsive. We only handle things pages don't already
        // handle themselves: closing the mobile sidebar on nav-link clicks,
        // and highlighting + auto-expanding the active page in the sidebar.
        setupNavItems();
        highlightCurrentPage();
    }

    function setupNavItems() {
        const items = document.querySelectorAll('.nav-item');
        items.forEach(item => {
            item.addEventListener('click', handleNavClick);
        });
    }

    function toggleSidebar() {
        const sidebar = document.querySelector('.sidebar');
        const main = document.querySelector('.main');
        if (!sidebar) return;
        
        sidebar.classList.toggle('collapsed');
        if (main) main.classList.toggle('expanded');
    }

    function closeSidebarMobile() {
        const sidebar = document.querySelector('.sidebar');
        const overlay = document.querySelector('.sidebar-overlay');
        if (sidebar) sidebar.classList.remove('mobile-open');
        if (overlay) overlay.classList.remove('active');
    }

    function openSidebarMobile() {
        const sidebar = document.querySelector('.sidebar');
        const overlay = document.querySelector('.sidebar-overlay');
        if (sidebar) sidebar.classList.add('mobile-open');
        if (overlay) overlay.classList.add('active');
    }

    function handleNavClick(event) {
        const href = event.target.href || event.target.closest('a')?.href;
        if (href) {
            closeSidebarMobile();
        }
    }

    function handleGroupToggle(event) {
        event.stopPropagation();
        const toggle = event.currentTarget;
        const sub = toggle.nextElementSibling;
        
        if (sub && sub.classList.contains('nav-sub')) {
            toggle.classList.toggle('open');
            sub.classList.toggle('open');
        }
    }

    function highlightCurrentPage() {
        const currentPath = window.location.pathname;
        const navItems = document.querySelectorAll('.nav-item');

        navItems.forEach(item => {
            const href = item.href || item.getAttribute('href');
            const isActive = href && currentPath.includes(href.split('/').pop());

            if (isActive) {
                item.classList.add('active');

                // If this item lives inside a collapsible group (.nav-sub),
                // expand that group and mark its toggle as open so the
                // active page is visible instead of hidden in a closed menu.
                const sub = item.closest('.nav-sub');
                if (sub) {
                    sub.classList.add('open');
                    const toggle = sub.previousElementSibling;
                    if (toggle && toggle.classList.contains('nav-group-toggle')) {
                        toggle.classList.add('open');
                    }
                }
            } else {
                item.classList.remove('active');
            }
        });
    }

    // Initialize on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupNavigation);
    } else {
        setupNavigation();
    }

    // Export functions
    window.Navigation = {
        setup: setupNavigation,
        toggleSidebar: toggleSidebar,
        closeMobile: closeSidebarMobile,
        openMobile: openSidebarMobile,
        highlight: highlightCurrentPage
    };
})();
