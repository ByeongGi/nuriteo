ALTER TABLE projects
    ADD COLUMN template_id text NOT NULL DEFAULT 'vite-react',
    ADD CONSTRAINT projects_template_id_check
        CHECK (template_id IN ('vite-react', 'next-app'));

COMMENT ON COLUMN projects.template_id IS
    'Immutable starter template selected when the project is created.';

CREATE OR REPLACE FUNCTION enforce_project_template_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.template_id IS DISTINCT FROM OLD.template_id THEN
        RAISE EXCEPTION 'project template is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'projects_template_immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER projects_template_immutable
    BEFORE UPDATE OF template_id ON projects
    FOR EACH ROW
    EXECUTE FUNCTION enforce_project_template_immutable();
