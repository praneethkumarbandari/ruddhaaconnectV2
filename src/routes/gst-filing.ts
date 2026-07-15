import { Router, type Request, type Response } from "express";
import multer from "multer";
import { asyncHandler } from "../lib/async-handler.ts";
import { requirePermission } from "../middleware/permission.ts";
import { gstr3bSummary, gstHsnSummary, gstInvoiceWiseDetail, gstAdvancesReceived, reconcileGstr2b } from "../lib/gst-filing.ts";

const ALLOWED_GST_EXTENSIONS = /\.(csv|xlsx|xls|json)$/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_GST_EXTENSIONS.test(file.originalname)) {
      return cb(new Error("Only .csv, .xlsx, .xls, or .json files are accepted."));
    }
    cb(null, true);
  },
});

const router = Router();
router.use(requirePermission("reports.view"));

function requireDateRange(req: Request, res: Response): { fromDate: string; toDate: string } | null {
  const { fromDate, toDate } = req.query as Record<string, string>;
  if (!fromDate || !toDate) {
    res.status(400).json({ error: "fromDate and toDate are required." });
    return null;
  }
  return { fromDate, toDate };
}

router.get("/gstr3b", asyncHandler(async (req: Request, res: Response) => {
  const range = requireDateRange(req, res);
  if (!range) return;
  return res.status(200).json(await gstr3bSummary(range.fromDate, range.toDate));
}));

router.get("/hsn-summary", asyncHandler(async (req: Request, res: Response) => {
  const range = requireDateRange(req, res);
  if (!range) return;
  return res.status(200).json(await gstHsnSummary(range.fromDate, range.toDate));
}));

router.get("/invoice-wise", asyncHandler(async (req: Request, res: Response) => {
  const range = requireDateRange(req, res);
  if (!range) return;
  return res.status(200).json(await gstInvoiceWiseDetail(range.fromDate, range.toDate));
}));

router.get("/advances", asyncHandler(async (req: Request, res: Response) => {
  const range = requireDateRange(req, res);
  if (!range) return;
  return res.status(200).json(await gstAdvancesReceived(range.fromDate, range.toDate));
}));

router.post("/reconcile-2b", upload.single("file"), asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: "A file is required (field name: file)." });
  try {
    const result = await reconcileGstr2b(req.file.buffer, req.file.originalname);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
}));

export default router;
