import { handler } from "../netlify/functions/api.ts";

/**
 * This does NOT use the Netlify CLI or any Netlify infrastructure —
 * both require network access to netlify.com/api.netlify.com, which
 * this environment cannot reach. Instead, it invokes the exported
 * `handler` function directly with hand-built Lambda/Netlify-style
 * event objects, exactly as Netlify's own runtime would call it. This
 * proves the adapter logic itself (path rewriting, header handling,
 * JSON and multipart body reconstruction, response shape) against a
 * real, live database — it does not prove Netlify's own bundler will
 * successfully package this function, which is a separate, disclosed,
 * unverified step (see the deployment report).
 */

function buildEvent(opts: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer | null;
  isBase64Encoded?: boolean;
  queryStringParameters?: Record<string, string>;
}) {
  return {
    httpMethod: opts.method,
    path: opts.path,
    headers: opts.headers ?? {},
    multiValueHeaders: {},
    queryStringParameters: opts.queryStringParameters ?? null,
    multiValueQueryStringParameters: null,
    body: opts.body == null ? null : (Buffer.isBuffer(opts.body) ? opts.body.toString("base64") : opts.body),
    isBase64Encoded: Buffer.isBuffer(opts.body) ? true : (opts.isBase64Encoded ?? false),
    requestContext: { requestId: "test-" + Date.now(), identity: { sourceIp: "127.0.0.1" } },
  };
}

async function main() {
  let failed = 0;
  function ok(name: string, cond: boolean, detail?: string) {
    if (cond) {
      console.log(`PASS  ${name}`);
    } else {
      failed++;
      console.log(`FAIL  ${name}${detail ? " -> " + detail : ""}`);
    }
  }

  // 1. Health check — no auth required
  const healthEvent = buildEvent({ method: "GET", path: "/.netlify/functions/api/health" });
  const healthResp: any = await handler(healthEvent, {});
  ok("Netlify Function: health check reachable and returns 200", healthResp.statusCode === 200, JSON.stringify(healthResp));

  // 2. Login
  const loginEvent = buildEvent({
    method: "POST",
    path: "/.netlify/functions/api/auth/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: process.env.SEED_USERNAME, password: process.env.SEED_PASSWORD }),
  });
  const loginResp: any = await handler(loginEvent, {});
  ok("Netlify Function: login succeeds through the adapter", loginResp.statusCode === 200, JSON.stringify(loginResp));
  const loginBody = JSON.parse(loginResp.body);
  const token = loginBody.token;
  ok("Netlify Function: login response includes a real JWT", typeof token === "string" && token.length > 20);

  // 3. Authenticated GET — proves auth middleware and path rewrite both work
  const coaEvent = buildEvent({
    method: "GET",
    path: "/.netlify/functions/api/chart-of-accounts",
    headers: { authorization: `Bearer ${token}` },
  });
  const coaResp: any = await handler(coaEvent, {});
  ok("Netlify Function: authenticated GET /chart-of-accounts succeeds", coaResp.statusCode === 200, JSON.stringify(coaResp).slice(0, 300));
  const coaBody = JSON.parse(coaResp.body);
  ok("Netlify Function: chart of accounts returns the real seeded accounts (14 rows)", Array.isArray(coaBody) && coaBody.length === 14, `got ${coaBody.length} rows`);

  // 4. Unauthenticated request to a protected route is correctly rejected
  const unauthEvent = buildEvent({ method: "GET", path: "/.netlify/functions/api/chart-of-accounts" });
  const unauthResp: any = await handler(unauthEvent, {});
  ok("Netlify Function: protected route without a token is rejected (401)", unauthResp.statusCode === 401, JSON.stringify(unauthResp));

  // 5. Multipart file upload — the hard case: binary body reconstruction + multer + busboy through the adapter
  const csvContent = "Txn Date,Particulars,Withdrawal Amt,Deposit Amt,Closing Balance,Chq/Ref No\n04/07/2026,Netlify function test row,,999.00,1000.00,NFREF001\n";
  const boundary = "----NetlifyTestBoundary";
  const multipartBody =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="statement.csv"\r\n` +
    `Content-Type: text/csv\r\n\r\n` +
    `${csvContent}\r\n` +
    `--${boundary}--\r\n`;
  const uploadEvent = buildEvent({
    method: "POST",
    path: "/.netlify/functions/api/bank-import/preview",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.from(multipartBody, "utf8"),
  });
  const uploadResp: any = await handler(uploadEvent, {});
  ok("Netlify Function: multipart file upload through the adapter reaches multer/busboy correctly", uploadResp.statusCode === 200, JSON.stringify(uploadResp).slice(0, 400));
  if (uploadResp.statusCode === 200) {
    const uploadBody = JSON.parse(uploadResp.body);
    ok("Netlify Function: uploaded CSV headers were correctly parsed through the binary-reconstructed body", uploadBody.headers && uploadBody.headers.length === 6, JSON.stringify(uploadBody.headers));
    ok("Netlify Function: auto-detected mapping identified all required fields", uploadBody.mappingComplete === true, JSON.stringify(uploadBody.suggestedMapping));
  }

  console.log("\n" + "=".repeat(60));
  console.log(failed === 0 ? "ALL NETLIFY FUNCTION ADAPTER TESTS PASSED" : `${failed} FAILURE(S)`);
  console.log("=".repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
