-- Fuel / maintenance (range 700–799): an uploaded fuel bill or maintenance invoice belongs to ONE live
-- log. The services check this before linking a file, but two concurrent requests could both pass that
-- check; these partial unique indexes make the rule hold under concurrency (23505 → 409 CONFLICT via
-- registerConstraintError in the fuel and maintenance modules). Soft-deleted logs release their file.
create unique index fuel_logs_bill_file_uq
  on fuel_logs (school_id, bill_file_id)
  where bill_file_id is not null and deleted_at is null;

create unique index maintenance_logs_invoice_file_uq
  on maintenance_logs (school_id, invoice_file_id)
  where invoice_file_id is not null and deleted_at is null;
