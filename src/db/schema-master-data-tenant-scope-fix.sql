-- FIX: systematic sweep, found while building the tenant-onboarding
-- endpoint. schema-multitenancy.sql added tenant_id to every table but
-- never touched any single-column `unique` constraint that predated
-- it. Every one of these is a master-data "code" or "name" that every
-- business naturally wants to define with the same common values —
-- Chart of Accounts codes (1000, 1100, 4000...), department codes
-- (HR, SALES...), a project code format (PRJ-001...), an employee
-- username (admin)... All of these would silently collide the moment
-- a SECOND tenant tried to create the same code/name a first tenant
-- already has. Not hypothetical: standard Chart of Accounts codes are
-- seeded identically for every tenant by design, so this was
-- guaranteed to break on the very next tenant onboarded.
--
-- Uses real constraint introspection (finds the actual unique
-- constraint covering exactly one column, by name, from pg_constraint)
-- rather than guessing Postgres's default naming convention — a wrong
-- guessed name would fail silently (DROP CONSTRAINT IF EXISTS just
-- no-ops) and leave the bug in place with no error to notice.

do $$
declare
  fix record;
  cons record;
begin
  for fix in
    select * from (values
      ('chart_of_accounts', 'account_code'),
      ('employees', 'username'),
      ('employees', 'email'),
      ('inventory', 'code'),
      ('project_categories', 'name'),
      ('projects', 'project_code'),
      ('employee_master', 'employee_code'),
      ('attendance_statuses', 'status_code'),
      ('branches', 'branch_code'),
      ('cost_centers', 'cost_center_code'),
      ('departments', 'department_code'),
      ('designations', 'designation_code'),
      ('employment_types', 'employment_type_code'),
      ('leave_types', 'leave_type_code'),
      ('salary_components', 'component_code'),
      ('salary_structures', 'structure_code'),
      ('shifts', 'shift_code'),
      ('attendance_mapping_templates', 'template_name'),
      ('attendance_policies', 'policy_code'),
      ('approval_hierarchies', 'hierarchy_code'),
      ('mapping_templates', 'template_name')
    ) as t(table_name, column_name)
  loop
    -- Find the actual unique constraint covering exactly this one column
    for cons in
      select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      where rel.relname = fix.table_name
        and con.contype = 'u'
        and con.conkey = (
          select array_agg(attnum order by attnum)
          from pg_attribute
          where attrelid = rel.oid and attname = fix.column_name
        )
    loop
      execute format('alter table %I drop constraint %I', fix.table_name, cons.conname);
    end loop;

    execute format(
      'alter table %I add constraint %I unique (tenant_id, %I)',
      fix.table_name,
      fix.table_name || '_tenant_' || fix.column_name || '_key',
      fix.column_name
    );
  end loop;
end $$;
