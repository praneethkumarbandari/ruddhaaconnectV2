import { Router, type Request, type Response } from "express";
import { listLedgers } from "../lib/ledgers.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";

const router = Router();

// Same gate as /chart-of-accounts — this is a superset view of the
// same data (plus customers/vendors/bank accounts, which their own
// respective permissions already govern for editing), not a new
// category of sensitive data on its own.
router.use(requirePermission("chart-of-accounts.view"));

router.get("/", asyncHandler(async (_req: Request, res: Response) => {
  return res.status(200).json(await listLedgers());
}));

export default router;
