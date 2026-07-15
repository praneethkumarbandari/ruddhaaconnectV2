import type { Response } from "express";
import {
  UnbalancedEntryError, InsufficientLinesError, UnknownAccountError,
  JournalEntryNotFoundError, JournalEntryNotPostedError, JournalEntryAlreadyReversedError,
} from "./posting-engine.ts";
import { FinancialYearClosedError, PeriodLockedError, NoFinancialYearError } from "./fy.ts";
import { InvoiceNotFoundError, InvoiceNotDraftError, InvoiceNotPostedError, InvoiceHasAllocationsError } from "./sales.ts";
import { PurchaseNotFoundError, PurchaseNotDraftError, PurchaseNotPostedError, PurchaseHasAllocationsError } from "./purchases.ts";
import { ReceiptNotFoundError, ReceiptNotDraftError, ReceiptNotPostedError, ReceiptHasAllocationsError, ReceiptAllocationNotFoundError, OverAllocationError as ReceiptOverAllocationError, AllocationInvoiceNotFoundError, AllocationInvoiceNotPostedError, AllocationExceedsOutstandingError as ReceiptAllocationExceedsOutstandingError } from "./receipts.ts";
import { PaymentNotFoundError, PaymentNotDraftError, PaymentNotPostedError, PaymentHasAllocationsError, PaymentAllocationNotFoundError, OverAllocationError as PaymentOverAllocationError, AllocationPurchaseNotFoundError, AllocationPurchaseNotPostedError, AllocationExceedsOutstandingError as PaymentAllocationExceedsOutstandingError } from "./payments.ts";
import { ProjectNotFoundError, DuplicateProjectCodeError, InvalidStatusTransitionError } from "./projects.ts";
import { TemplateNotFoundError, StandardTemplateImmutableError } from "./project-templates.ts";
import {
  NodeNotFoundError, ProjectHasNoTemplateError, InvalidLevelForTemplateError,
  InvalidParentError, InvalidStatusForTemplateError, NodeHasChildrenError,
} from "./project-hierarchy.ts";
import { MemberAlreadyAssignedError, MemberNotFoundError } from "./project-members.ts";
import { BudgetVersionNotFoundError, AnotherVersionApprovedError, BudgetVersionNotDraftError, InvalidBudgetLineError, BudgetVersionNumberConflictError } from "./project-budget.ts";
import { MilestoneNotFoundError, TaskNotFoundError, MilestoneWrongProjectError } from "./project-tasks.ts";
import { DocumentNotFoundError } from "./project-documents.ts";
import { NoteNotFoundError, NoteNotDraftError, NoteNotPostedError } from "./notes.ts";
import { SameAccountError, InvalidContraAccountError } from "./contra.ts";
import {
  EmployeeNotFoundError,
  SelfManagerError,
  CircularReportingError,
  ReportingManagerNotFoundError,
  ExitDateRequiredError,
  InvalidMasterReferenceError,
  InvalidStatusTransitionError as EmployeeInvalidStatusTransitionError,
} from "./employees.ts";
import {
  LeaveRequestNotFoundError,
  LeaveNotPendingError,
  LeaveNotCancellableError,
  NotEntitledLeaveApproverError,
  OverlappingLeaveError,
  InvalidHalfDayRequestError,
  MaxConsecutiveLeaveExceededError,
  LeaveNotAllowedDuringProbationError,
  LeaveRestrictedDuringNoticeError,
  PastDateLeaveError,
  EmptyLeaveRangeError,
} from "./leave.ts";
import { InsufficientLeaveBalanceError, LeavePolicyNotFoundError } from "./leave-balance.ts";
import { AttendanceLockedError } from "./attendance-locks.ts";
import { AttendanceOutsideEmploymentError } from "./attendance.ts";
import { HierarchyNotFoundError, NoReportingManagerError } from "./approvals.ts";

// Errors ending in "NotFound" -> 404. Every other class in this list
// is a deliberate business-rule rejection -> 422, with its message
// shown to the caller (these are all known-safe to display — no
// internal detail, no schema info, no raw DB error text). Anything
// NOT in this list is treated as unexpected and rethrown so it hits
// the generic 500 handler with no message leaked — same discipline
// established in Phase 1's journal-entries.ts, just centralized here
// so Phase 2's routes don't each reimplement the same catch logic.
const NOT_FOUND_ERRORS = [
  InvoiceNotFoundError,
  PurchaseNotFoundError,
  ReceiptNotFoundError,
  PaymentNotFoundError,
  ReceiptAllocationNotFoundError,
  PaymentAllocationNotFoundError,
  NoteNotFoundError,
  AllocationInvoiceNotFoundError,
  AllocationPurchaseNotFoundError,
  ProjectNotFoundError,
  MemberNotFoundError,
  BudgetVersionNotFoundError,
  MilestoneNotFoundError,
  TaskNotFoundError,
  DocumentNotFoundError,
  EmployeeNotFoundError,
  LeaveRequestNotFoundError,
  LeavePolicyNotFoundError,
  HierarchyNotFoundError,
  TemplateNotFoundError,
  NodeNotFoundError,
];

const BUSINESS_RULE_ERRORS = [
  UnbalancedEntryError,
  InsufficientLinesError,
  UnknownAccountError,
  JournalEntryNotFoundError,
  JournalEntryNotPostedError,
  JournalEntryAlreadyReversedError,
  FinancialYearClosedError,
  PeriodLockedError,
  NoFinancialYearError,
  InvoiceNotDraftError,
  InvoiceNotPostedError,
  InvoiceHasAllocationsError,
  PurchaseNotDraftError,
  PurchaseNotPostedError,
  PurchaseHasAllocationsError,
  ReceiptNotDraftError,
  ReceiptNotPostedError,
  ReceiptHasAllocationsError,
  ReceiptOverAllocationError,
  ReceiptAllocationExceedsOutstandingError,
  AllocationInvoiceNotPostedError,
  PaymentNotDraftError,
  PaymentNotPostedError,
  PaymentHasAllocationsError,
  PaymentOverAllocationError,
  PaymentAllocationExceedsOutstandingError,
  AllocationPurchaseNotPostedError,
  NoteNotDraftError,
  NoteNotPostedError,
  SameAccountError,
  InvalidContraAccountError,
  DuplicateProjectCodeError,
  InvalidStatusTransitionError,
  MemberAlreadyAssignedError,
  AnotherVersionApprovedError,
  BudgetVersionNotDraftError,
  InvalidBudgetLineError,
  BudgetVersionNumberConflictError,
  MilestoneWrongProjectError,
  SelfManagerError,
  CircularReportingError,
  ReportingManagerNotFoundError,
  ExitDateRequiredError,
  InvalidMasterReferenceError,
  EmployeeInvalidStatusTransitionError,
  LeaveNotPendingError,
  LeaveNotCancellableError,
  NotEntitledLeaveApproverError,
  OverlappingLeaveError,
  InvalidHalfDayRequestError,
  MaxConsecutiveLeaveExceededError,
  LeaveNotAllowedDuringProbationError,
  LeaveRestrictedDuringNoticeError,
  PastDateLeaveError,
  EmptyLeaveRangeError,
  InsufficientLeaveBalanceError,
  NoReportingManagerError,
  AttendanceOutsideEmploymentError,
  AttendanceLockedError,
  StandardTemplateImmutableError,
  ProjectHasNoTemplateError,
  InvalidLevelForTemplateError,
  InvalidParentError,
  InvalidStatusForTemplateError,
  NodeHasChildrenError,
];

export function handleDomainError(err: unknown, res: Response): void {
  const error = err as Error;

  if (NOT_FOUND_ERRORS.some((ErrClass) => error instanceof ErrClass)) {
    res.status(404).json({ error: error.message });
    return;
  }

  if (BUSINESS_RULE_ERRORS.some((ErrClass) => error instanceof ErrClass)) {
    res.status(422).json({ error: error.message });
    return;
  }

  throw err; // unrecognized — let it reach the generic 500 handler, no message leaked
}
