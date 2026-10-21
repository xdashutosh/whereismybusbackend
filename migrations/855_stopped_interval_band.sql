-- Tracking (lane B range 850–899): BP §9.1 "Stopped interval 60–120 s, value from config (default
-- 90 s)". The school override (and the platform default) accepted 30–300 s; the API now validates
-- 60–120 (packages/shared PLATFORM_SETTING_SCHEMAS / schoolSettingsBody). Existing values are clamped
-- into the band first, then the check constraint is tightened.
update school_settings
   set location_stopped_interval_s = least(greatest(location_stopped_interval_s, 60), 120)
 where location_stopped_interval_s is not null
   and location_stopped_interval_s not between 60 and 120;

alter table school_settings drop constraint if exists school_settings_location_stopped_interval_s_check;
alter table school_settings add constraint school_settings_location_stopped_interval_s_check
  check (location_stopped_interval_s is null or location_stopped_interval_s between 60 and 120);

update platform_settings
   set value = to_jsonb(least(greatest(round((value #>> '{}')::numeric)::int, 60), 120)), updated_at = now()
 where key = 'location.stopped_interval_s'
   and jsonb_typeof(value) = 'number'
   and (value #>> '{}')::numeric not between 60 and 120;
