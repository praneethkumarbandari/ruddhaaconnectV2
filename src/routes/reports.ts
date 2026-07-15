import { Router, type Request, type Response } from "express";
import {
  generalLedger,
  generalLedgerBatch,
  trialBalance,
  profitAndLoss,
  balanceSheet,
  partyLedger,
  customerOutstanding,
  vendorOutstanding,
  dayBook,
  gstReport,
} from "../lib/reports.ts";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";

const CASH_ACCOUNT_CODE = "1000";
const BANK_ACCOUNT_CODE = "1100";

const router = Router();
router.use(requirePermission("reports.view"));

router.get("/ledger", asyncHandler(async (req: Request, res: Response) => {
  const { accountCode, fromDate, toDate } = req.query as Record<string, string>;
  if (!accountCode || !fromDate || !toDate) {
    return res.status(400).json({ error: "accountCode, fromDate, and toDate are required." });
  }
  return res.status(200).json(await generalLedger(accountCode, fromDate, toDate));
}));

/**
 * FIX (performance/scalability): the batched replacement for "load
 * every ledger's movement" — see generalLedgerBatch()'s own comment
 * in lib/reports.ts. One request, a fixed small number of queries,
 * instead of one request per ledger.
 */
router.get("/general-ledger-batch", asyncHandler(async (req: Request, res: Response) => {
  const { fromDate, toDate } = req.query as Record<string, string>;
  if (!fromDate || !toDate) {
    return res.status(400).json({ error: "fromDate and toDate are required." });
  }
  return res.status(200).json(await generalLedgerBatch(fromDate, toDate));
}));

router.get("/trial-balance", asyncHandler(async (req: Request, res: Response) => {
  const asOfDate = (req.query.asOfDate as string) ?? new Date().toISOString().slice(0, 10);
  return res.status(200).json(await trialBalance(asOfDate));
}));

router.get("/profit-and-loss", asyncHandler(async (req: Request, res: Response) => {
  const { fromDate, toDate } = req.query as Record<string, string>;
  if (!fromDate || !toDate) {
    return res.status(400).json({ error: "fromDate and toDate are required." });
  }
  return res.status(200).json(await profitAndLoss(fromDate, toDate));
}));

router.get("/balance-sheet", asyncHandler(async (req: Request, res: Response) => {
  const asOfDate = (req.query.asOfDate as string) ?? new Date().toISOString().slice(0, 10);
  return res.status(200).json(await balanceSheet(asOfDate));
}));

router.get("/customer-ledger", asyncHandler(async (req: Request, res: Response) => {
  const { customerId, fromDate, toDate } = req.query as Record<string, string>;
  if (!customerId || !fromDate || !toDate) {
    return res.status(400).json({ error: "customerId, fromDate, and toDate are required." });
  }
  return res.status(200).json(await partyLedger("customer", Number(customerId), fromDate, toDate));
}));

router.get("/vendor-ledger", asyncHandler(async (req: Request, res: Response) => {
  const { vendorId, fromDate, toDate } = req.query as Record<string, string>;
  if (!vendorId || !fromDate || !toDate) {
    return res.status(400).json({ error: "vendorId, fromDate, and toDate are required." });
  }
  return res.status(200).json(await partyLedger("vendor", Number(vendorId), fromDate, toDate));
}));

// Cash book / bank book are literally the general ledger for the
// system Cash / Bank accounts — reusing generalLedger() rather than
// a separate implementation, since that's exactly what they are.
router.get("/cash-book", asyncHandler(async (req: Request, res: Response) => {
  const { fromDate, toDate } = req.query as Record<string, string>;
  if (!fromDate || !toDate) return res.status(400).json({ error: "fromDate and toDate are required." });
  return res.status(200).json(await generalLedger(CASH_ACCOUNT_CODE, fromDate, toDate));
}));

router.get("/bank-book", asyncHandler(async (req: Request, res: Response) => {
  const { fromDate, toDate } = req.query as Record<string, string>;
  if (!fromDate || !toDate) return res.status(400).json({ error: "fromDate and toDate are required." });
  return res.status(200).json(await generalLedger(BANK_ACCOUNT_CODE, fromDate, toDate));
}));

router.get("/day-book", asyncHandler(async (req: Request, res: Response) => {
  const { fromDate, toDate } = req.query as Record<string, string>;
  if (!fromDate || !toDate) return res.status(400).json({ error: "fromDate and toDate are required." });
  return res.status(200).json(await dayBook(fromDate, toDate));
}));

router.get("/gst", asyncHandler(async (req: Request, res: Response) => {
  const { fromDate, toDate } = req.query as Record<string, string>;
  if (!fromDate || !toDate) return res.status(400).json({ error: "fromDate and toDate are required." });
  return res.status(200).json(await gstReport(fromDate, toDate));
}));

router.get("/customer-outstanding", asyncHandler(async (_req: Request, res: Response) => {
  return res.status(200).json(await customerOutstanding());
}));

router.get("/vendor-outstanding", asyncHandler(async (_req: Request, res: Response) => {
  return res.status(200).json(await vendorOutstanding());
}));

export default router;
