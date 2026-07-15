-- Two more per-business theme colors, alongside the existing card
-- color: the KPI dashboard card's title (label) text color and its
-- main value/content text color, independently configurable rather
-- than only inheriting the generic heading/text colors.
alter table portal_config add column if not exists kpi_title_color text;
alter table portal_config add column if not exists kpi_content_color text;
