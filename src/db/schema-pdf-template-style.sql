-- Lets a business pick which of the 3 built-in print/PDF template
-- styles (classic / modern / minimal) their Invoices, Receipts, and
-- Payments print as by default. Defaults to 'classic' so existing
-- businesses get a sensible look with no action required.
alter table portal_config add column if not exists pdf_template_style text not null default 'classic';
