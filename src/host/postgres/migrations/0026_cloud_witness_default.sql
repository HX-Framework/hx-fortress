-- D6: "audit.cloudWitness toggle default ON (sent ids are already cloud-known)".
--
-- The column shipped `DEFAULT false` with no row seeded, so `readCloudWitness`
-- returned false out of the box and the audit never asked let.ai at all. With
-- the witness off, a session missing from the bucket cannot be told apart from
-- benign legacy, so a new operator's first compliance reading is a permanent
-- failure caused by a default rather than by their data.
--
-- Guarded, so an operator who deliberately switched it OFF keeps that choice:
-- this seeds a row only where none exists.
INSERT INTO "hx"."audit_settings" ("cloud_witness")
SELECT true
 WHERE NOT EXISTS (SELECT 1 FROM "hx"."audit_settings");
