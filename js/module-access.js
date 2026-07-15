// FIX: the sidebar and topbar used to show every module to every
// employee regardless of role — an Administrator and a brand-new
// data-entry hire saw an identical menu. This is the one shared place
// that knows what an employee can actually do, so the sidebar/topbar
// don't each re-implement their own copy of this logic.
//
// See GATED_MODULES below for the real, verified list of what the
// backend actually enforces (checked every route file, not a sample).
// Only Outstanding, Day Book, General Ledger, Trial Balance, P&L,
// Balance Sheet, and Numbering & Prefixes remain genuinely ungated —
// hiding those based on permissions would be cosmetic only, since the
// backend doesn't check for them either way. Everything else in
// GATED_MODULES is real, backend-enforced access control.
window.ModuleAccess = (function () {
  var _loaded = false;
  var _isSuperAdmin = false;
  var _grantedModules = {}; // { moduleName: true }

  // FIX: an earlier pass only checked a handful of route files and
  // concluded "Accounting has no backend permission checks" — wrong,
  // and corrected here after checking every route file properly.
  // Chart of Accounts, Journal Entry, Bank Accounts/Import, Sales &
  // Purchase Invoices, Financial Years, Credit/Debit Notes, Reports,
  // and Audit Log all DO have real router.use(requirePermission(...))
  // gates. What's genuinely still ungated: Outstanding, Day Book,
  // General Ledger, Trial Balance, Profit & Loss, Balance Sheet,
  // Numbering & Prefixes — these are read-only summary views built on
  // top of already-gated data, with no permission check of their own.
  var GATED_MODULES = [
    'crm', 'customers', 'vendors', 'hr', 'attendance', 'leave', 'payroll',
    'employees', 'projects', 'costing', 'contra', 'payments', 'receipts',
    'reports', 'inventory', 'admin', 'chart-of-accounts', 'sales-invoices',
    'purchase-invoices', 'journal-entries', 'financial-years',
    'bank-accounts', 'bank-import', 'credit-notes', 'debit-notes',
    'project-categories', 'audit-log', 'customer-requests',
  ];

  async function load() {
    if (_loaded) return;
    try {
      var [me, catalog] = await Promise.all([
        window.Api.get('/roles/me'),
        window.Api.get('/permissions'),
      ]);
      var myPerms = me.permissions || [];
      if (myPerms.indexOf('*') !== -1) {
        _isSuperAdmin = true;
      } else {
        var myPermSet = {};
        myPerms.forEach(function (code) { myPermSet[code] = true; });
        (catalog || []).forEach(function (p) {
          if (myPermSet[p.permission_code]) _grantedModules[p.module] = true;
        });
      }
    } catch (e) {
      // Fail open to "show everything" rather than silently locking
      // someone out of navigation entirely because of a transient
      // network error — the backend's own permission checks are the
      // real gate; this is only ever a navigation convenience on top.
      _isSuperAdmin = true;
    }
    _loaded = true;
  }

  function hasModule(moduleName) {
    if (GATED_MODULES.indexOf(moduleName) === -1) return true; // ungated module: always visible
    if (_isSuperAdmin) return true;
    return !!_grantedModules[moduleName];
  }

  function hasAnyModule(moduleNames) {
    return moduleNames.some(hasModule);
  }

  return { load: load, hasModule: hasModule, hasAnyModule: hasAnyModule, GATED_MODULES: GATED_MODULES };
})();
