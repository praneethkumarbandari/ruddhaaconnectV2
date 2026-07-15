-- Real, persisted notification channel preferences. Note the honest
-- scope: these columns let a business save which channels they want
-- enabled — no code anywhere actually SENDS an email/SMS/WhatsApp
-- message yet. That integration (a provider like SendGrid/Twilio, plus
-- deciding which events trigger a notification) is separate, real
-- backend work still to come. This migration only makes the
-- preference itself genuinely save and persist, instead of a toggle
-- that goes nowhere.
alter table portal_config add column if not exists notify_email_enabled boolean not null default true;
alter table portal_config add column if not exists notify_sms_enabled boolean not null default false;
alter table portal_config add column if not exists notify_whatsapp_enabled boolean not null default false;
