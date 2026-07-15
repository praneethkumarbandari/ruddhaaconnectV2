import serverlessHttp from "serverless-http";
import { app } from "../../src/app.ts";

/**
 * Netlify Function adapter for the Accounting V1.1 backend.
 *
 * This file contains zero accounting logic, zero routing logic, and
 * zero middleware. It exists purely to let the existing, unmodified
 * Express app (src/app.ts) run inside a Netlify Function instead of
 * a long-running Node process. Every route, every piece of auth,
 * validation, and error handling is exactly what it was before this
 * migration — this file only bridges the Lambda-style invocation
 * model to the Express request/response model.
 *
 * Path handling: Netlify invokes this function at
 * /.netlify/functions/api/<rest>, but every route in app.ts is
 * mounted under /api/<rest> (unchanged, and must stay unchanged —
 * the frontend and every existing route registration assumes this).
 * netlify.toml rewrites public requests from /api/* to this function,
 * and the one line below restores the /api/* path the Express app
 * actually expects before handing the request to it.
 */
const expressHandler = serverlessHttp(app);

export const handler = async (event: any, context: any) => {
  const rewrittenEvent = {
    ...event,
    path: event.path.replace(/^\/\.netlify\/functions\/api/, "/api"),
  };
  return expressHandler(rewrittenEvent, context);
};
