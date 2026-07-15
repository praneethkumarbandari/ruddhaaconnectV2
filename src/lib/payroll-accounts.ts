import type { PgClient } from "../db/pool.ts";

export class AccountMappingNotFoundError extends Error {
  constructor(mappingKey: string, context?: string) {
    super(`No account mapping configured for '${mappingKey}'${context ? ` (${context})` : ""}. Configure one via POST /api/payroll/account-mappings before processing payroll.`);
    this.name = "AccountMappingNotFoundError";
  }
}

/**
 * Resolves a posting role (mappingKey) to a real account_code,
 * checking a component-specific or statutory-rule-specific override
 * first, falling back to the mapping_key's default (component_id and
 * statutory_rule_id both null) if no override exists. This is the
 * ONE function that reads payroll_account_mappings — every posting
 * decision in lib/payroll-accounting.ts goes through this, so "how is
 * X mapped" always has one answer, not one per call site.
 */
export async function resolveAccountCode(
  client: PgClient,
  mappingKey: string,
  overrides: { componentId?: number | null; statutoryRuleId?: number | null } = {},
): Promise<string> {
  if (overrides.componentId) {
    const { rows } = await client.query(
      `select account_code from payroll_account_mappings where mapping_key = $1 and component_id = $2`,
      [mappingKey, overrides.componentId],
    );
    if (rows.length > 0) return rows[0].account_code;
  }
  if (overrides.statutoryRuleId) {
    const { rows } = await client.query(
      `select account_code from payroll_account_mappings where mapping_key = $1 and statutory_rule_id = $2`,
      [mappingKey, overrides.statutoryRuleId],
    );
    if (rows.length > 0) return rows[0].account_code;
  }
  const { rows: defaultRows } = await client.query(
    `select account_code from payroll_account_mappings where mapping_key = $1 and component_id is null and statutory_rule_id is null`,
    [mappingKey],
  );
  if (defaultRows.length === 0) {
    throw new AccountMappingNotFoundError(mappingKey, overrides.componentId ? `component ${overrides.componentId}` : overrides.statutoryRuleId ? `statutory rule ${overrides.statutoryRuleId}` : undefined);
  }
  return defaultRows[0].account_code;
}
