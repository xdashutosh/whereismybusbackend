-- Reports / lists (lane B range 850–899): locale-aware sorting of human-entered names, independent of
-- the database's default collation.
--
-- The hosted Neon databases are created with the builtin C.UTF-8 collation, which sorts by code point:
-- 'Bus 10' < 'Zara Khan' < 'aarav sharma' < 'bus 2' < 'Éva'. A local en_US.UTF-8 cluster sorts the same
-- values case- and accent-insensitively first ('aarav sharma' < 'Bus 10' < 'bus 2' < 'Éva' < 'Zara Khan'),
-- so on Neon a student or staff member typed in lower case landed after every capitalised name, often on
-- a later page. Every list sort (parseSort whitelists, ORDER BY full_name / code, json_agg … order by)
-- orders by these columns, so giving the COLUMNS an explicit ICU collation fixes all of them at once and
-- makes the order identical on every host (Neon, local, CI).
--
-- Columns changed: application base-table text / varchar columns that still use the database default collation and
-- either look like a display name (…name, …title, …code, …label, optionally with _snapshot) or are in the
-- explicit list below (other human-entered values the panels sort or search on). citext (emails,
-- usernames) is left alone: it already compares case-insensitively.
--
-- The ICU collation is deterministic, so equality, unique constraints and LIKE / ILIKE behave exactly as
-- before; affected indexes are rebuilt by ALTER COLUMN. Because every changed column uses the SAME
-- collation and anything else keeps the (weaker) default collation, expressions that mix columns never
-- hit a collation conflict. tests/qa/collation.test.ts guards this rule for columns added later.
do $$
declare
  v_coll text;
  r record;
begin
  select collname into v_coll
    from pg_collation
   where collname in ('en-US-x-icu', 'und-x-icu') and collprovider = 'i'
     and collnamespace = 'pg_catalog'::regnamespace
   order by collname = 'en-US-x-icu' desc
   limit 1;
  if v_coll is null then
    raise notice '850_icu_name_collation: no ICU collation available on this server — names keep the database collation';
    return;
  end if;

  for r in
    select c.relname, a.attname, format_type(a.atttypid, a.atttypmod) as coltype
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
     where c.relnamespace = 'public'::regnamespace
       and c.relkind in ('r', 'p') and not c.relispartition
       and not exists (select 1 from pg_depend d   -- never extension-owned tables (PostGIS spatial_ref_sys)
                        where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
       and a.attnum > 0 and not a.attisdropped
       and a.atttypid in ('text'::regtype, 'varchar'::regtype, 'bpchar'::regtype)
       and a.attcollation = 'pg_catalog."default"'::regcollation
       and (a.attname ~ '(^|_)(name|title|code|label)(_snapshot)?$'
            or (c.relname || '.' || a.attname) = any (array[
                 'students.section', 'students.admission_no', 'students.roll_no',
                 'buses.registration_no', 'buses.make_model', 'trips.bus_registration_snapshot',
                 'schools.city', 'schools.state', 'stops.landmark',
                 'fuel_logs.station', 'maintenance_logs.vendor', 'maintenance_logs.service_type',
                 'bus_documents.issuer', 'bus_documents.doc_number',
                 'staff_documents.issuer', 'staff_documents.doc_number']))
     order by c.relname, a.attnum
  loop
    execute format('alter table %I alter column %I type %s collate %I', r.relname, r.attname, r.coltype, v_coll);
  end loop;
end
$$;
