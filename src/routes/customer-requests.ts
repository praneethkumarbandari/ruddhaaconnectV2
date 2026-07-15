import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";
import { listCustomerRequests, updateCustomerRequestStatus, CustomerRequestNotFoundError } from "../lib/customer-requests.ts";
import { query } from "../db/pool.ts";

const router = Router();
router.use(requirePermission("customer-requests.view"));

router.get("/", asyncHandler(async (_req: Request, res: Response) => {
  const rows = await listCustomerRequests();
  return res.status(200).json(rows);
}));

// FIX: topbar notification badge needs a real count, not a fake number
// — one query instead of fetching the full list just to count it.
router.get("/pending-count", asyncHandler(async (_req: Request, res: Response) => {
  const { rows } = await query(`select count(*)::int as count from customer_requests where status = 'Open'`);
  return res.status(200).json({ count: rows[0].count });
}));

router.patch("/:id", requirePermission("customer-requests.manage"), asyncHandler(async (req: Request, res: Response) => {
  const { status } = req.body ?? {};
  if (!status || !["Open", "In Progress", "Closed"].includes(status)) {
    return res.status(400).json({ error: "status must be one of: Open, In Progress, Closed." });
  }
  try {
    const request = await updateCustomerRequestStatus(Number(req.params.id), status, req.user?.userId ?? null);
    return res.status(200).json(request);
  } catch (err) {
    if (err instanceof CustomerRequestNotFoundError) return res.status(404).json({ error: err.message });
    throw err;
  }
}));

export default router;
