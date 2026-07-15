import type { PgClient } from "../db/pool.ts";

/**
 * Statutory calculation engine. Deliberately has no knowledge of PF,
 * ESI, PT, or any specific country's scheme by name — it only knows
 * how to evaluate a `statutory_rules` row's `calculation_type`
 * against a wage base. Which rules exist, at what rates, is entirely
 * data (seeded/configured by HR), never a code branch per country.
 */

export type StatutoryRule = {
  id: number;
  ruleCode: string;
  ruleName: string;
  calculationType: "percentage" | "fixed" | "slab";
  wageBasis: "basic" | "gross";
  rate: number | null;
  fixedAmount: number | null;
  wageCeiling: number | null;
  // FIX: distinct from wageCeiling. wageCeiling caps the AMOUNT a
  // rate is calculated against (e.g. PF only calculates its 12% on
  // the first Rs.15,000 of basic, even if actual basic is higher).
  // eligibilityCeiling is a different question entirely: whether the
  // rule applies AT ALL. ESI is not "calculated on wages capped at
  // Rs.21,000" -- it simply does not apply to anyone earning above
  // that, at any percentage, on any base. Before this field existed,
  // there was no way to express that second kind of rule, so ESI
  // would have been silently deducted from every employee regardless
  // of wage, not just the ones actually eligible for it.
  eligibilityCeiling: number | null;
  employeeSharePercentage: number;
  employerSharePercentage: number;
};

export type StatutoryResult = {
  ruleId: number;
  ruleCode: string;
  totalAmount: number;
  employeeShare: number;
  employerShare: number;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function getActiveStatutoryRules(client: PgClient, asOfDate: string): Promise<StatutoryRule[]> {
  const { rows } = await client.query(
    `select * from statutory_rules where is_active = true and effective_from <= $1 order by rule_code`,
    [asOfDate],
  );
  return rows.map((r) => ({
    id: r.id, ruleCode: r.rule_code, ruleName: r.rule_name, calculationType: r.calculation_type, wageBasis: r.wage_basis,
    rate: r.rate != null ? Number(r.rate) : null, fixedAmount: r.fixed_amount != null ? Number(r.fixed_amount) : null,
    wageCeiling: r.wage_ceiling != null ? Number(r.wage_ceiling) : null,
    eligibilityCeiling: r.eligibility_ceiling != null ? Number(r.eligibility_ceiling) : null,
    employeeSharePercentage: Number(r.employee_share_percentage), employerSharePercentage: Number(r.employer_share_percentage),
  }));
}

async function getSlabAmount(client: PgClient, ruleId: number, wageBase: number): Promise<number> {
  const { rows } = await client.query(
    `select slab_from, slab_to, rate from statutory_rule_slabs where statutory_rule_id = $1 order by slab_from`,
    [ruleId],
  );
  let total = 0;
  for (const slab of rows) {
    const from = Number(slab.slab_from);
    const to = slab.slab_to != null ? Number(slab.slab_to) : Infinity;
    if (wageBase <= from) continue;
    const taxableInSlab = Math.min(wageBase, to) - from;
    if (taxableInSlab <= 0) continue;
    total += taxableInSlab * (Number(slab.rate) / 100);
  }
  return round2(total);
}

/**
 * Evaluates one rule against basic/gross wages, returning the total
 * amount plus its employee/employer split. `wageCeiling` (when set)
 * caps the BASE the percentage/slab is computed on — e.g. PF is
 * commonly capped at a wage ceiling even for higher earners, a real,
 * common statutory pattern this makes configurable rather than
 * hardcoded.
 */
export async function evaluateStatutoryRule(
  client: PgClient,
  rule: StatutoryRule,
  wages: { basic: number; gross: number },
): Promise<StatutoryResult> {
  const rawBase = rule.wageBasis === "basic" ? wages.basic : wages.gross;

  // FIX: this check did not exist before. wageCeiling capping the
  // calculation base is correct for rules like PF (still applies
  // above the ceiling, just calculated on a capped amount) — but a
  // rule with an eligibilityCeiling is a different kind of rule
  // entirely: it does not apply AT ALL above that wage, on any base.
  // Confirmed live-equivalent case: ESI on an employee earning above
  // Rs.21,000 would previously still have had ESI calculated (just
  // uncapped, since ESI has no wageCeiling) — a real, incorrect
  // deduction for every employee above the eligibility line.
  if (rule.eligibilityCeiling != null && rawBase > rule.eligibilityCeiling) {
    return { ruleId: rule.id, ruleCode: rule.ruleCode, totalAmount: 0, employeeShare: 0, employerShare: 0 };
  }

  const base = rule.wageCeiling != null ? Math.min(rawBase, rule.wageCeiling) : rawBase;

  let totalAmount = 0;
  if (rule.calculationType === "percentage") {
    totalAmount = round2(base * ((rule.rate ?? 0) / 100));
  } else if (rule.calculationType === "fixed") {
    totalAmount = round2(rule.fixedAmount ?? 0);
  } else {
    totalAmount = await getSlabAmount(client, rule.id, base);
  }

  const employeeShare = round2(totalAmount * (rule.employeeSharePercentage / 100));
  const employerShare = round2(totalAmount * (rule.employerSharePercentage / 100));

  return { ruleId: rule.id, ruleCode: rule.ruleCode, totalAmount, employeeShare, employerShare };
}
