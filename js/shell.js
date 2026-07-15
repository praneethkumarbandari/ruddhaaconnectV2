/**
 * shell.js — Ruddhaa ERP Single Shell (Stabilized)
 *
 * Responsibilities:
 *   1. Auth gate (redirect to business-login.html if not logged in)
 *   2. Fetch and inject components/topbar.html and components/sidebar.html
 *   3. Apply theme from localStorage / Supabase portal_config
 *   4. Wire sidebar toggle, group accordion, mobile overlay
 *   5. Highlight the active sidebar item for the current page
 *   6. Point the content iframe at content/<page>.html
 *   7. Conditionally load Lucky — ONLY if window.LUCKY_ENABLED is true
 *
 * Each real page (e.g. /invoices.html) sets
 *   window.__RUDDHAA_CONTENT_PAGE__ = 'invoices.html';
 * before this script runs, and otherwise IS the shell — there is no
 * redirect hop to a shared shell.html URL. This keeps the address bar,
 * bookmarks, browser refresh, and browser back/forward all behaving
 * exactly like a normal multi-page site, because they ARE a normal
 * multi-page site — the shared parts are only the sidebar/topbar
 * markup (fetched from components/) and this script, not the URL.
 *
 * No business logic. No backend calls other than portal_config for theme.
 * Preserves every existing content/*.html page unchanged.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* 1. Auth gate                                                         */
  /* ------------------------------------------------------------------ */
  var stored = localStorage.getItem('loggedEmployee');
  var emp = null;
  try { emp = stored ? JSON.parse(stored) : null; } catch (e) {}
  if (!emp || !emp.id) {
    window.location.replace('/business-login.html');
    return; // stop — redirect in flight
  }

  /* ------------------------------------------------------------------ */
  /* 2. Which content page does this shell instance show?                */
  /*    Set by the page itself via window.__RUDDHAA_CONTENT_PAGE__.      */
  /*    Falls back to ?p= for direct testing of layouts/shell.html, and  */
  /*    finally to the dashboard so nothing ever loads blank.            */
  /* ------------------------------------------------------------------ */
  function getContentPage() {
    if (window.__RUDDHAA_CONTENT_PAGE__ && /^[\w\-]+\.html$/.test(window.__RUDDHAA_CONTENT_PAGE__)) {
      return window.__RUDDHAA_CONTENT_PAGE__;
    }
    var params = new URLSearchParams(window.location.search);
    var p = params.get('p');
    if (p && /^[\w\-]+\.html$/.test(p)) return p;
    return 'business-dashboard.html';
  }

  var contentPage = getContentPage();

  /* ------------------------------------------------------------------ */
  /* 3. Sub-pages that aren't in the sidebar themselves highlight their  */
  /*    obvious parent list page. Deliberately conservative — pages with */
  /*    no clear single parent (e.g. settings-adjacent utility pages)    */
  /*    are left with no forced highlight rather than guessed.           */
  /* ------------------------------------------------------------------ */
  var PAGE_PARENT = {
    'invoices-create.html': 'invoices.html',
    'purchase-invoices-create.html': 'purchase-invoices.html',
    'pm-project-workspace.html': 'pm-projects.html'
  };

  /* ------------------------------------------------------------------ */
  /* 4. Component fetch helper                                            */
  /* ------------------------------------------------------------------ */
  function fetchHTML(url, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) cb(null, xhr.responseText);
      else cb(new Error('HTTP ' + xhr.status + ' loading ' + url));
    };
    xhr.onerror = function () { cb(new Error('Network error loading ' + url)); };
    xhr.send();
  }

  /* ------------------------------------------------------------------ */
  /* 5. Insert topbar then sidebar, then wire everything                 */
  /* ------------------------------------------------------------------ */
  fetchHTML('/components/topbar.html', function (err, html) {
    var mount = document.getElementById('topbarMount');
    if (mount) mount.innerHTML = err ? '' : html;
    if (err) console.error('[shell] ' + err.message);
    wireTopbar();

    fetchHTML('/components/sidebar.html', function (err2, html2) {
      var smount = document.getElementById('sidebarMount');
      if (smount) smount.innerHTML = err2 ? '' : html2;
      if (err2) console.error('[shell] ' + err2.message);
      wireSidebar();
      applyModuleFiltering();
      setIframeSrc();
      loadTheme();
      maybeLoadLucky();
    });
  });

  /* ------------------------------------------------------------------ */
  /* 5b. Permission-based module filtering                                */
  /*     Hides sidebar entries the logged-in employee's role doesn't     */
  /*     actually grant — see js/module-access.js for the exact scope    */
  /*     of what is and isn't really enforced today.                     */
  /* ------------------------------------------------------------------ */
  function applyModuleFiltering() {
    if (!window.ModuleAccess) return; // script failed to load — fail open, show everything
    window.ModuleAccess.load().then(function () {
      document.querySelectorAll('[data-module]').forEach(function (el) {
        var modules = el.getAttribute('data-module').split(',').map(function (m) { return m.trim(); });
        var allowed = window.ModuleAccess.hasAnyModule(modules);
        if (!allowed) {
          // Group toggles hide themselves AND their .nav-sub sibling;
          // individual .nav-item links just hide themselves.
          el.style.display = 'none';
          if (el.classList.contains('nav-group-toggle') && el.nextElementSibling) {
            el.nextElementSibling.style.display = 'none';
          }
        }
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* 6. Topbar wiring                                                     */
  /* ------------------------------------------------------------------ */
  function wireTopbar() {
    var nameEl = document.getElementById('employeeName');
    var metaEl = document.getElementById('employeeMeta');
    if (nameEl) nameEl.textContent = emp.employeeName || emp.username || 'Employee';
    if (metaEl) metaEl.textContent = (emp.department && emp.department.trim()) ? emp.department : 'Business Portal';

    var toggleBtn = document.getElementById('sidebarToggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', function () {
        var sidebar = document.getElementById('sidebar');
        var mainArea = document.getElementById('mainArea');
        var overlay = document.getElementById('sidebarOverlay');
        if (!sidebar) return;
        if (window.innerWidth <= 900) {
          sidebar.classList.toggle('mobile-open');
          if (overlay) overlay.classList.toggle('active');
        } else {
          sidebar.classList.toggle('collapsed');
          if (mainArea) mainArea.classList.toggle('expanded');
        }
      });
    }

    wireModuleSwitcher();
    wireUniversalSearch();
    wireQuickNew();
    wireNotifications();
    wireProfileMenu();
  }

  /* ------------------------------------------------------------------ */
  /* 7b. Module switcher — replaces a company switcher (doesn't apply    */
  /*     here, one login = one business), filtered the same way the     */
  /*     sidebar is: only modules the employee's role actually grants.   */
  /* ------------------------------------------------------------------ */
  var MODULE_SWITCHER_ITEMS = [
    { label: 'Dashboard', href: '/business-dashboard.html', modules: [] },
    { label: 'Masters', href: '/customers.html', modules: ['customers', 'vendors'] },
    { label: 'Accounting', href: '/invoices.html', modules: ['chart-of-accounts', 'journal-entries', 'bank-accounts', 'sales-invoices', 'purchase-invoices', 'payments', 'receipts', 'contra', 'costing', 'reports'] },
    { label: 'Inventory', href: '/inventory.html', modules: ['inventory'] },
    { label: 'HR', href: '/employees.html', modules: ['hr', 'employees', 'attendance', 'leave', 'payroll'] },
    { label: 'Project Management', href: '/pm-dashboard.html', modules: ['projects'] },
  ];

  function wireModuleSwitcher() {
    var mount = document.getElementById('moduleSwitcherMount');
    if (!mount) return;
    mount.innerHTML =
      '<button class="module-switcher-btn" id="moduleSwitcherBtn">' +
      '<i class="fa-solid fa-grip"></i> Modules <i class="fa-solid fa-chevron-down" style="font-size:10px;"></i></button>' +
      '<div class="module-switcher-list" id="moduleSwitcherList"></div>';

    var btn = document.getElementById('moduleSwitcherBtn');
    var list = document.getElementById('moduleSwitcherList');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      closeAllTopbarDropdowns(list);
      list.classList.toggle('open');
    });

    if (!window.ModuleAccess) { list.innerHTML = '<div class="dropdown-empty">Unavailable</div>'; return; }
    window.ModuleAccess.load().then(function () {
      var visible = MODULE_SWITCHER_ITEMS.filter(function (item) {
        return item.modules.length === 0 || window.ModuleAccess.hasAnyModule(item.modules);
      });
      list.innerHTML = visible.map(function (item) {
        return '<a href="' + item.href + '" target="_top">' + item.label + '</a>';
      }).join('');
    });
  }

  /* ------------------------------------------------------------------ */
  /* 7b-2. Universal Search — type-ahead across every major master and   */
  /*       transaction type, calling GET /api/search?q=... (see          */
  /*       src/routes/search.ts). Plus a small static list of report/    */
  /*       settings pages matched client-side, since those aren't        */
  /*       database records a search query could ever find.              */
  /* ------------------------------------------------------------------ */
  var STATIC_SEARCH_DESTINATIONS = [
    { type: 'Report', label: 'General Ledger', url: '/general-ledger.html' },
    { type: 'Report', label: 'Trial Balance', url: '/trial-balance.html' },
    { type: 'Report', label: 'Profit & Loss', url: '/profit-loss.html' },
    { type: 'Report', label: 'Balance Sheet', url: '/balance-sheet.html' },
    { type: 'Report', label: 'Cash Flow Report', url: '/cash-flow-report.html' },
    { type: 'Report', label: 'Day Book', url: '/daybook.html' },
    { type: 'Report', label: 'Outstanding', url: '/outstanding.html' },
    { type: 'Settings', label: 'Settings', url: '/settings.html' },
    { type: 'Settings', label: 'Roles & Permissions', url: '/permissions.html' },
    { type: 'Settings', label: 'Chart of Accounts', url: '/chart-of-accounts.html' },
    { type: 'Settings', label: 'HR Masters', url: '/hr-masters.html' },
  ];

  function wireUniversalSearch() {
    var mount = document.getElementById('universalSearchMount');
    if (!mount) return;
    mount.innerHTML =
      '<div class="universal-search">' +
      '<i class="fa-solid fa-magnifying-glass search-icon"></i>' +
      '<input type="text" id="universalSearchInput" placeholder="Search customers, invoices, ledgers, employees…" autocomplete="off">' +
      '<div class="universal-search-results" id="universalSearchResults"></div>' +
      '</div>';

    var input = document.getElementById('universalSearchInput');
    var results = document.getElementById('universalSearchResults');
    var debounceTimer = null;

    function renderResults(items) {
      if (!items.length) {
        results.innerHTML = '<div class="dropdown-empty">No matches</div>';
        results.classList.add('open');
        return;
      }
      results.innerHTML = items.map(function (item) {
        var sub = item.sublabel ? ' <span class="us-sublabel">' + escapeHtmlSafe(item.sublabel) + '</span>' : '';
        return '<a href="javascript:void(0)" class="us-result" data-url="' + item.url + '">' +
          '<span class="us-type">' + escapeHtmlSafe(item.type) + '</span>' +
          '<span class="us-label">' + escapeHtmlSafe(item.label) + '</span>' + sub +
          '</a>';
      }).join('');
      results.classList.add('open');
      Array.prototype.forEach.call(results.querySelectorAll('.us-result'), function (el) {
        el.addEventListener('click', function () {
          window.top.location.href = el.getAttribute('data-url');
        });
      });
    }

    function escapeHtmlSafe(s) {
      return window.escapeHtml ? window.escapeHtml(s) : String(s || '');
    }

    input.addEventListener('input', function () {
      var q = input.value.trim();
      clearTimeout(debounceTimer);
      if (q.length < 2) { results.classList.remove('open'); results.innerHTML = ''; return; }
      debounceTimer = setTimeout(function () {
        var staticMatches = STATIC_SEARCH_DESTINATIONS.filter(function (d) {
          return d.label.toLowerCase().indexOf(q.toLowerCase()) !== -1;
        });
        window.Api.get('/search?q=' + encodeURIComponent(q))
          .then(function (dataMatches) {
            renderResults(staticMatches.concat(dataMatches || []).slice(0, 20));
          })
          .catch(function () {
            renderResults(staticMatches); // static shortcuts still work even if the data search call fails
          });
      }, 250);
    });

    document.addEventListener('click', function (e) {
      if (!e.target.closest('.universal-search')) { results.classList.remove('open'); }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 7c. Quick "+ New" — direct links to the most common create actions. */
  /*     Kept to real, working destinations only — no auto-opening      */
  /*     modals on pages that weren't built for a query-param trigger.   */
  /* ------------------------------------------------------------------ */
  var QUICK_NEW_ITEMS = [
    { label: 'Invoice', href: '/invoices-create.html', modules: ['sales-invoices', 'purchase-invoices'] },
    { label: 'Customer', href: '/customers.html', modules: ['customers'] },
    { label: 'Vendor', href: '/vendors.html', modules: ['vendors'] },
    { label: 'Journal Entry', href: '/journal-entries.html', modules: ['journal-entries'] },
  ];

  function wireQuickNew() {
    var mount = document.getElementById('quickNewMount');
    if (!mount) return;
    mount.innerHTML =
      '<button class="quick-new-btn" id="quickNewBtn"><i class="fa-solid fa-plus"></i> New</button>' +
      '<div class="quick-new-list" id="quickNewList"></div>';

    var btn = document.getElementById('quickNewBtn');
    var list = document.getElementById('quickNewList');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      closeAllTopbarDropdowns(list);
      list.classList.toggle('open');
    });

    if (!window.ModuleAccess) { list.innerHTML = '<div class="dropdown-empty">Unavailable</div>'; return; }
    window.ModuleAccess.load().then(function () {
      var visible = QUICK_NEW_ITEMS.filter(function (item) {
        return item.modules.length === 0 || window.ModuleAccess.hasAnyModule(item.modules);
      });
      list.innerHTML = visible.map(function (item) {
        return '<a href="' + item.href + '" target="_top">' + item.label + '</a>';
      }).join('');
    });
  }

  /* ------------------------------------------------------------------ */
  /* 7d. Notifications — real counts (pending customer requests,        */
  /*     unmapped bank transactions), not placeholder numbers. Each     */
  /*     count is only fetched if the employee can actually see that    */
  /*     module, same rule the sidebar itself follows.                  */
  /* ------------------------------------------------------------------ */
  function wireNotifications() {
    var mount = document.getElementById('notifBellMount');
    if (!mount) return;
    mount.innerHTML =
      '<button class="notif-bell-btn" id="notifBellBtn"><i class="fa-solid fa-bell"></i><span class="notif-badge" id="notifBadge" style="display:none;">0</span></button>' +
      '<div class="notif-list" id="notifList"><div class="dropdown-empty">Loading…</div></div>';

    var btn = document.getElementById('notifBellBtn');
    var list = document.getElementById('notifList');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      closeAllTopbarDropdowns(list);
      list.classList.toggle('open');
    });

    if (!window.Api || !window.ModuleAccess) { list.innerHTML = '<div class="dropdown-empty">Unavailable</div>'; return; }

    window.ModuleAccess.load().then(function () {
      var checks = [];
      if (window.ModuleAccess.hasModule('crm')) {
        checks.push(
          window.Api.get('/customer-requests/pending-count')
            .then(function (r) { return { label: 'Pending customer requests', count: r.count, href: '/customer-requests.html' }; })
            .catch(function () { return null; })
        );
      }
      // Bank & Cash sits under Accounting, which has no permission gate
      // today — always fetchable, same as the sidebar link itself.
      checks.push(
        window.Api.get('/bank-accounts/unmapped-count')
          .then(function (r) { return { label: 'Unmapped bank transactions', count: r.count, href: '/bank-transactions.html' }; })
          .catch(function () { return null; })
      );

      Promise.all(checks).then(function (results) {
        var real = results.filter(function (r) { return r && r.count > 0; });
        var total = real.reduce(function (sum, r) { return sum + r.count; }, 0);
        var badge = document.getElementById('notifBadge');
        if (total > 0) { badge.textContent = total > 99 ? '99+' : String(total); badge.style.display = 'inline-flex'; }
        list.innerHTML = real.length
          ? real.map(function (r) { return '<a href="' + r.href + '" target="_top">' + r.label + ' <b>' + r.count + '</b></a>'; }).join('')
          : '<div class="dropdown-empty">Nothing pending</div>';
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* 7e. Profile dropdown — wraps the employee-info block that already   */
  /*     existed, just collapsed behind a click instead of always shown. */
  /* ------------------------------------------------------------------ */
  function wireProfileMenu() {
    var mount = document.getElementById('profileMenuMount');
    if (!mount) return;
    mount.classList.add('profile-menu-collapsed');
    var trigger = document.createElement('div');
    trigger.className = 'profile-menu-trigger';
    trigger.innerHTML = '<i class="fa-solid fa-circle-user"></i> <i class="fa-solid fa-chevron-down" style="font-size:10px;"></i>';
    mount.insertBefore(trigger, mount.firstChild);
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      closeAllTopbarDropdowns(mount);
      mount.classList.toggle('open');
    });

    var viewProfileLink = document.createElement('a');
    viewProfileLink.href = '/profile.html';
    viewProfileLink.target = '_top';
    viewProfileLink.className = 'profile-menu-view-link';
    viewProfileLink.innerHTML = '<i class="fa-solid fa-user-gear"></i> My Profile &amp; Password';
    var logoutBtn = mount.querySelector('.logout-btn');
    if (logoutBtn) mount.insertBefore(viewProfileLink, logoutBtn);
  }

  function closeAllTopbarDropdowns(except) {
    ['moduleSwitcherList', 'quickNewList', 'notifList'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el !== except) el.classList.remove('open');
    });
    var profile = document.getElementById('profileMenuMount');
    if (profile && profile !== except) profile.classList.remove('open');
  }

  document.addEventListener('click', function () { closeAllTopbarDropdowns(null); });

  /* ------------------------------------------------------------------ */
  /* 7. Sidebar wiring                                                    */
  /* ------------------------------------------------------------------ */
  function wireSidebar() {
    // Dropdown headers use the inline onclick="toggleGroup(this)" already
    // written in components/sidebar.html — do NOT also attach a click
    // listener here. Both firing on the same click open and immediately
    // re-close the dropdown in the same instant, which looked like the
    // dropdowns simply didn't work at all.
    document.querySelectorAll('.nav-item').forEach(function (item) {
      item.addEventListener('click', function () { closeSidebar(); });
    });
    highlightActivePage();
  }

  function toggleGroup(el) {
    var sub = el.nextElementSibling;
    var isOpen = sub && sub.classList.contains('open');
    document.querySelectorAll('.nav-group-toggle').forEach(function (t) { t.classList.remove('open'); });
    document.querySelectorAll('.nav-sub').forEach(function (s) { s.classList.remove('open'); });
    if (!isOpen && sub && sub.classList.contains('nav-sub')) {
      el.classList.add('open');
      sub.classList.add('open');
    }
  }
  window.toggleGroup = toggleGroup; // keep inline onclick compatibility

  function closeSidebar() {
    var sidebar = document.getElementById('sidebar');
    var overlay = document.getElementById('sidebarOverlay');
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (overlay) overlay.classList.remove('active');
  }
  window.closeSidebar = closeSidebar;

  window.addEventListener('resize', function () {
    if (window.innerWidth > 900) closeSidebar();
  });

  function highlightActivePage() {
    document.querySelectorAll('.nav-item').forEach(function (item) { item.classList.remove('active'); });
    var page = PAGE_PARENT[contentPage] || contentPage;
    var matched = null;
    document.querySelectorAll('.nav-item[data-page]').forEach(function (item) {
      if (item.getAttribute('data-page') === page) matched = item;
    });
    if (matched) {
      matched.classList.add('active');
      var sub = matched.closest('.nav-sub');
      if (sub) {
        sub.classList.add('open');
        var toggle = sub.previousElementSibling;
        if (toggle && toggle.classList.contains('nav-group-toggle')) toggle.classList.add('open');
      }
    }
    // No match (e.g. a settings-adjacent utility page not in the frozen
    // nav) is expected and fine — no forced highlight rather than a guess.
  }

  /* ------------------------------------------------------------------ */
  /* 8. Content iframe                                                    */
  /* ------------------------------------------------------------------ */
  function setIframeSrc() {
    var frame = document.getElementById('contentFrame');
    if (!frame) return;
    var src = '/content/' + contentPage;
    if (window.location.hash) src += window.location.hash;
    frame.src = src;
    frame.addEventListener('load', function () {
      try {
        var iTitle = frame.contentDocument && frame.contentDocument.title;
        if (iTitle) document.title = iTitle;
      } catch (e) { /* cross-origin guard, harmless if it ever applies */ }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 9. Theme loading                                                     */
  /* ------------------------------------------------------------------ */
  function applyTheme(data) {
    if (!data) return;
    // FIX: this only ever applied 4 of the ~11 theme properties
    // (primary/secondary/background/font) — card_color, text_color,
    // heading_color, menu_color, menu_text_color were silently never
    // updated by a live fetch, only by theme-boot.js's cached-from-
    // localStorage application on the NEXT page load. If the database
    // had a newer value than what was cached, this page wouldn't
    // reflect it until a second reload. Now applies everything
    // consistently, matching theme-boot.js's own list exactly.
    if (data.primary_color)    document.documentElement.style.setProperty('--primary-color', data.primary_color);
    if (data.secondary_color)  document.documentElement.style.setProperty('--secondary-color', data.secondary_color);
    if (data.background_color) document.documentElement.style.setProperty('--background-color', data.background_color);
    if (data.font_family)      document.documentElement.style.setProperty('--font-family', data.font_family);
    if (data.text_color)       document.documentElement.style.setProperty('--text-color', data.text_color);
    if (data.heading_color)    document.documentElement.style.setProperty('--heading-color', data.heading_color);
    if (data.card_color)       document.documentElement.style.setProperty('--card-color', hexToRgbaLocal(data.card_color, 0.55));
    if (data.menu_color)       document.documentElement.style.setProperty('--menu-color', data.menu_color);
    if (data.menu_text_color)  document.documentElement.style.setProperty('--menu-text-color', data.menu_text_color);
    if (data.kpi_title_color)   document.documentElement.style.setProperty('--kpi-title-color', data.kpi_title_color);
    if (data.kpi_content_color) document.documentElement.style.setProperty('--kpi-content-color', data.kpi_content_color);
  }

  // Same hex-to-rgba conversion theme-boot.js uses for card_color's
  // glass effect — duplicated here (not imported) since this file has
  // no module system and theme-boot.js runs as a separate, standalone
  // inline script.
  function hexToRgbaLocal(hex, alpha) {
    if (!hex) return hex;
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    var r = parseInt(h.substring(0,2), 16), g = parseInt(h.substring(2,4), 16), b = parseInt(h.substring(4,6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return hex;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  function loadTheme() {
    try {
      var cached = localStorage.getItem('portalTheme');
      if (cached) applyTheme(JSON.parse(cached));
    } catch (e) {}

    // FIX (theme not saving): this used to call
    // db.from('portal_config').select('*')... directly against Supabase,
    // bypassing the backend entirely. That query resolves outside the
    // tenant's schema (search_path is set per-request on the Express
    // backend, not on the browser's raw Supabase client), so it could
    // return a different/stale/empty row than the one Settings just
    // saved — then immediately overwrite the correct, just-cached
    // localStorage value with that wrong data, every single page load.
    // A save would visibly apply, then silently "undo" itself on the
    // next navigation. Using window.Api (the tenant-scoped backend)
    // instead of window.db (raw Supabase) fixes this at the source.
    if (!window.Api) return;
    window.Api.get('/settings/branding').then(function (data) {
      if (!data) return;
      applyTheme(data);
      var nameEl = document.getElementById('companyName');
      if (data.company_name) {
        if (nameEl) nameEl.textContent = data.company_name;
        document.title = data.company_name + ' - RuddhaConnect';
      }
      var logoEl = document.getElementById('companyLogo');
      if (logoEl) {
        if (data.logo_path && data.logo_path.trim()) {
          logoEl.src = data.logo_path.trim();
          logoEl.onload = function () { logoEl.style.display = 'block'; };
          logoEl.onerror = function () { logoEl.style.display = 'none'; };
        } else {
          logoEl.style.display = 'none';
        }
      }
      localStorage.setItem('portalTheme', JSON.stringify(data));
    }).catch(function (err) { console.log('[shell] theme load error:', err); });
  }

  /* ------------------------------------------------------------------ */
  /* 10. Lucky — strictly gated behind the feature flag.                  */
  /*     When window.LUCKY_ENABLED is not true, NOTHING in this          */
  /*     function runs: no fetch, no DOM injection, no CSS, no JS.       */
  /*     Lucky has zero footprint in the page unless explicitly enabled. */
  /* ------------------------------------------------------------------ */
  function maybeLoadLucky() {
    if (window.LUCKY_ENABLED !== true) return;

    fetchHTML('/components/lucky/lucky-panel.html', function (err, html) {
      if (err) { console.error('[shell] ' + err.message); return; }

      var mount = document.createElement('div');
      mount.id = 'luckyMount';
      mount.innerHTML = html;
      document.body.appendChild(mount);

      var cssLink = document.createElement('link');
      cssLink.rel = 'stylesheet';
      cssLink.href = '/css/lucky/lucky.css';
      document.head.appendChild(cssLink);

      var svcScript = document.createElement('script');
      svcScript.src = '/services/lucky/lucky-service.js';
      document.body.appendChild(svcScript);

      var panelScript = document.createElement('script');
      panelScript.src = '/js/lucky/lucky-panel.js';
      document.body.appendChild(panelScript);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 11. Public API                                                       */
  /* ------------------------------------------------------------------ */
  function logout() {
    localStorage.removeItem('rc_token');
    localStorage.removeItem('rc_user');
    localStorage.removeItem('loggedEmployee');
    localStorage.removeItem('portalTheme');
    window.location.replace('/business-login.html');
  }

  window.Shell = {
    logout: logout,
    highlight: highlightActivePage,
    toggleGroup: toggleGroup,
    closeSidebar: closeSidebar
  };

})();
