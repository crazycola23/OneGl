-- OneGl — ensure the application role can use every object in its own database.
--
-- The retrieval and page-evidence tables in 0006/0007 were created by the superuser on
-- this deployment, so the application role (which owns the database but not those
-- tables) could not read them.
--
-- This is idempotent and also sets default privileges so tables created by future
-- migrations run as `onegl` are readable without a second pass.

DO $$
DECLARE target_role text := 'onegl';
DECLARE schema_name text := 'public';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
    RAISE NOTICE 'role % does not exist, skipping grant', target_role;
    RETURN;
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', schema_name, target_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', schema_name, target_role);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', schema_name, target_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', schema_name, target_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I', schema_name, target_role);
END
$$;