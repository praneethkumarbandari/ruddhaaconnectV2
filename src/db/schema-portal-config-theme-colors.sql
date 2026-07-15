-- ============================================================
-- PORTAL_CONFIG — the theme colors nobody ever migrated
-- ============================================================
-- content/settings.html's saveSettings() and js/shell.js's applyTheme()
-- have always read/written text_color, heading_color, card_color,
-- menu_color, and menu_text_color on portal_config — but no migration
-- file in this repo, including schema-portal-config-fix.sql (which
-- was written specifically to fix "Settings can't save"), ever added
-- them. Since PATCH /settings does one single UPDATE covering every
-- field sent at once, these 5 missing columns silently broke EVERY
-- Settings save, not just the theme fields — one missing column in
-- the SET clause fails the whole statement.
-- ============================================================

alter table portal_config add column if not exists text_color      text;
alter table portal_config add column if not exists heading_color   text;
alter table portal_config add column if not exists card_color      text;
alter table portal_config add column if not exists menu_color      text;
alter table portal_config add column if not exists menu_text_color text;
