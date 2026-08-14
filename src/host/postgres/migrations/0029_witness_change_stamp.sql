-- Who last changed the cloud witness, and when.
--
-- `hx.set_cloud_witness` is SECURITY DEFINER and granted to the daemon's write
-- role, and that role's DSN is also what a leaked roles.json hands out. The
-- routine cannot tell the two apart. It can record the change, so turning
-- outbound session-id disclosure back on for an operator who switched it off
-- stops being invisible.
ALTER TABLE "hx"."audit_settings" ADD COLUMN IF NOT EXISTS "changed_at" timestamptz;
ALTER TABLE "hx"."audit_settings" ADD COLUMN IF NOT EXISTS "changed_by" text;
