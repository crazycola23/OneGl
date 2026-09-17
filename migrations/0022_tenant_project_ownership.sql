-- Service project bindings are ownership records, not movable aliases.
-- A project may update its customer-facing display/external id inside the same tenant,
-- but ownership must never be reassigned to a different tenant.

CREATE OR REPLACE FUNCTION onegl_reject_project_tenant_rebind() RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'service project ownership is immutable for project %', OLD.project_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS service_project_binding_owner_immutable ON service_project_bindings;
CREATE TRIGGER service_project_binding_owner_immutable
BEFORE UPDATE OF tenant_id ON service_project_bindings
FOR EACH ROW
EXECUTE FUNCTION onegl_reject_project_tenant_rebind();

DO $$
DECLARE target_role text := 'onegl';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION onegl_reject_project_tenant_rebind() TO %I', target_role);
  END IF;
END
$$;
