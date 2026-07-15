// FIX: an external audit correctly found that only one page
// (customer-requests.html) had a real escapeHtml() function; every
// other page either had none, or — worse — only neutralized the
// single-quote that would break out of an inline onclick='...'
// attribute (via JSON.stringify(row).replace(/'/g,"&#39;")), which
// does nothing to stop <, >, ", or & from being rendered as real HTML
// when the same field is shown as visible cell text elsewhere on the
// same row. Any customer/vendor/item name (or any other free-text
// field a person can set) containing something like
// <img src=x onerror=alert(1)> would execute as real HTML the moment
// it rendered in a table — a genuine stored-XSS path, not a
// theoretical one, since customer/vendor names are exactly the kind
// of field a customer-facing form or a copy-pasted import would set.
//
// One shared function, used everywhere text from the database is
// interpolated into an innerHTML template string as visible content.
window.escapeHtml = function (value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};
