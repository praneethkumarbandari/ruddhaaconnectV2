/**
 * MULTI-TENANCY — ISOLATION REGRESSION TEST
 * ================================================
 *
 * Seeds two tenants with deliberately overlapping data (both create a
 * customer with the exact same name) and asserts tenant A's queries
 * never return tenant B's rows, through the REAL HTTP request path —
 * real login, real JWT with a real tenantId, real middleware, real
 * RLS policy — not a direct lib-level check that could pass for
 * reasons unrelated to whether the actual mechanism works end to end.
 *
 * ================================================================
 * HONEST CAVEAT, stated plainly rather than implied by a passing test:
 *
 * This test can only DEFINITIVELY prove isolation once
 * FORCE ROW LEVEL SECURITY is enabled (schema-multitenancy-enforce.sql
 * — the final step of the staged rollout, applied only after all 46
 * routes are migrated). Until then:
 *
 *   - Postgres's own default behavior is that a table's OWNING role
 *     bypasses RLS entirely, even with ENABLE ROW LEVEL SECURITY
 *     already set — FORCE is specifically what makes RLS apply to the
 *     owner too.
 *   - Whether this test's PASS result before that point means anything
 *     depends entirely on whether this deployment's DATABASE_URL
 *     connects as the table-owning role (in which case isolation is
 *     NOT actually enforced yet, and a pass here would be
 *     coincidental — e.g., both tenants' data simply doesn't
 *     numerically collide by accident) or a separate, restricted role
 *     (in which case RLS may already be genuinely active even without
 *     FORCE). This codebase does not know which is true for any given
 *     deployment, and this test cannot determine that on its own.
 *
 * Run this test BOTH before and after enabling FORCE ROW LEVEL
 * SECURITY. A pass before FORCE is a good sign but not proof. A pass
 * AFTER FORCE is the real proof — and a FAILURE at that point means
 * isolation is not actually working and must not be treated as
 * production-ready regardless of anything else in this codebase.
 * ================================================================
 *
 * Run with: npx tsx test/multitenancy-isolation-regression.ts
 * Requires schema-multitenancy.sql applied (tenant_id columns +
 * policies exist), and — for a truly meaningful result — ideally
 * schema-multitenancy-enforce.sql (FORCE) applied too.
 */

import bcrypt from "bcryptjs";
import { pool } from "../src/db/pool.ts";
import { handler } from "../netlify/functions/api.ts";

type Result = { name: string; pass: boolean; detail?: string };
const results: Result[] = [];
const RUN = Date.now();

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, pass: false, detail: msg });
    console.log(`FAIL  ${name}\n      -> ${msg}`);
  }
}
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function buildEvent(opts: { method: string; path: string; token?: string; body?: unknown }) {
  return {
    httpMethod: opts.method,
    path: "/.netlify/functions/api" + opts.path,
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    body: opts.body ? JSON.stringify(opts.body) : null,
    isBase64Encoded: false,
    requestContext: { requestId: "mt-test-" + Date.now(), identity: { sourceIp: "127.0.0.1" } },
  };
}
async function call(opts: { method: string; path: string; token?: string; body?: unknown }) {
  const resp: any = await handler(buildEvent(opts), {});
  return { status: resp.statusCode, body: resp.body ? JSON.parse(resp.body) : null };
}

async function createTenantWithAdmin(tenantCode: string, username: string, password: string) {
  const { rows: tenantRows } = await pool.query(
    `insert into tenants (tenant_code, tenant_name) values ($1, $2)
     on conflict (tenant_code) do update set tenant_name = excluded.tenant_name
     returning id`,
    [tenantCode, `Isolation Test Tenant ${tenantCode}`],
  );
  const tenantId = tenantRows[0].id;

  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query(
    `insert into employees (username, employee_name, password_hash, role, tenant_id)
     values ($1, $2, $3, 'admin', $4)
     on conflict (username) do update set password_hash = excluded.password_hash, tenant_id = excluded.tenant_id`,
    [username, `Isolation Test Admin (${tenantCode})`, passwordHash, tenantId],
  );

  return tenantId;
}

async function loginAs(username: string, password: string): Promise<string> {
  const resp = await call({ method: "POST", path: "/auth/login", body: { username, password } });
  assert(resp.status === 200, `login for ${username} should succeed, got ${resp.status}: ${JSON.stringify(resp.body)}`);
  return resp.body.token;
}

async function main() {
  const tenantA = await createTenantWithAdmin(`ISO_A_${RUN}`, `iso_admin_a_${RUN}`, "Test1234!");
  const tenantB = await createTenantWithAdmin(`ISO_B_${RUN}`, `iso_admin_b_${RUN}`, "Test1234!");

  const tokenA = await loginAs(`iso_admin_a_${RUN}`, "Test1234!");
  const tokenB = await loginAs(`iso_admin_b_${RUN}`, "Test1234!");

  await check("login tokens carry the correct, distinct tenantId for each tenant", async () => {
    // Decode without verifying signature -- we just need the payload
    // shape, and we trust our own just-issued token here.
    const decode = (token: string) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    const payloadA = decode(tokenA);
    const payloadB = decode(tokenB);
    assert(payloadA.tenantId === tenantA, `expected token A's tenantId to be ${tenantA}, got ${payloadA.tenantId}`);
    assert(payloadB.tenantId === tenantB, `expected token B's tenantId to be ${tenantB}, got ${payloadB.tenantId}`);
    assert(payloadA.tenantId !== payloadB.tenantId, "expected the two tenants to have different ids");
  });

  // Deliberately identical customer name in both tenants -- this is
  // the whole point: overlapping data must not become confused.
  const sharedCustomerName = `Isolation Test Customer ${RUN}`;
  let customerIdA: number, customerIdB: number;

  await check("tenant A can create a customer", async () => {
    const resp = await call({ method: "POST", path: "/customers", token: tokenA, body: { customerName: sharedCustomerName } });
    assert(resp.status === 201, `expected 201, got ${resp.status}: ${JSON.stringify(resp.body)}`);
    customerIdA = resp.body.id;
  });

  await check("tenant B can create a customer with the exact same name", async () => {
    const resp = await call({ method: "POST", path: "/customers", token: tokenB, body: { customerName: sharedCustomerName } });
    assert(resp.status === 201, `expected 201, got ${resp.status}: ${JSON.stringify(resp.body)}`);
    customerIdB = resp.body.id;
    assert(customerIdB !== customerIdA!, "expected two genuinely distinct rows, not the same one reused");
  });

  await check("tenant A's customer list includes ITS OWN customer", async () => {
    const resp = await call({ method: "GET", path: "/customers", token: tokenA });
    assert(resp.status === 200, `expected 200, got ${resp.status}`);
    assert(resp.body.some((c: any) => c.id === customerIdA), "expected tenant A's own customer to appear in its own list");
  });

  await check("*** THE ACTUAL ISOLATION CHECK *** tenant A's customer list does NOT include tenant B's customer", async () => {
    const resp = await call({ method: "GET", path: "/customers", token: tokenA });
    assert(resp.status === 200, `expected 200, got ${resp.status}`);
    const leaked = resp.body.find((c: any) => c.id === customerIdB);
    assert(!leaked, `TENANT ISOLATION FAILURE: tenant A's customer list included tenant B's customer (id ${customerIdB}). This is a real data leak, not a test artifact.`);
  });

  await check("*** THE ACTUAL ISOLATION CHECK (reverse direction) *** tenant B's customer list does NOT include tenant A's customer", async () => {
    const resp = await call({ method: "GET", path: "/customers", token: tokenB });
    assert(resp.status === 200, `expected 200, got ${resp.status}`);
    const leaked = resp.body.find((c: any) => c.id === customerIdA);
    assert(!leaked, `TENANT ISOLATION FAILURE: tenant B's customer list included tenant A's customer (id ${customerIdA}). This is a real data leak, not a test artifact.`);
  });

  await check("tenant A cannot fetch tenant B's customer directly by id", async () => {
    const resp = await call({ method: "GET", path: `/customers/${customerIdB}`, token: tokenA });
    // Either a 404 (row genuinely invisible under RLS) or an empty/
    // not-found-shaped body is an acceptable "isolated" outcome here
    // — what's NOT acceptable is 200 with tenant B's real data in it.
    if (resp.status === 200) {
      assert(!resp.body || resp.body.id !== customerIdB, `TENANT ISOLATION FAILURE: tenant A fetched tenant B's customer (id ${customerIdB}) directly by id.`);
    }
  });

  const failed = results.filter((r) => !r.pass);
  console.log("\n" + "=".repeat(60));
  console.log(`Total: ${results.length}   Passed: ${results.length - failed.length}   Failed: ${failed.length}`);
  console.log("=".repeat(60));
  console.log("\nReminder: a pass here is only DEFINITIVE proof of isolation");
  console.log("if FORCE ROW LEVEL SECURITY has already been applied. See this");
  console.log("file's own header comment for why a pass before that point may");
  console.log("not mean what it appears to mean.");
  await pool.end();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
