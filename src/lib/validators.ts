import { z } from 'zod';
import {
  ACTIVITY_TYPES,
  APPLICANT_RELATIONS,
  AUTOMATION_TRIGGERS,
  COMMISSION_TYPES,
  CANCELLATION_STATUS,
  DOCUMENT_TYPES,
  FOLLOWUP_TYPES,
  LEAD_SOURCES,
  LOAN_STATUS,
  LOAN_TYPES,
  MEETING_STATUS,
  MEETING_TYPES,
  MILESTONE_STATUS,
  PAYMENT_METHODS,
  PAYABLE_TO,
  PRIORITIES,
  PROPERTY_TYPES,
  PROJECT_STATUS,
  ROLES,
  UNIT_STATUS,
  UNIT_TYPE,
  VERIFICATION_STATUS,
} from './constants';

export const isoDate = z.union([z.string().refine((s) => !isNaN(Date.parse(s)), 'Invalid date'), z.date()]);

export const money = z.union([
  z.number().nonnegative(),
  z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'Invalid amount'),
]);

export const optionalPhone = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => v ?? undefined);

// ---------------------------------------------------------------- Leads
export const leadBaseSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  phone: z.string().trim().optional().nullable(),
  whatsapp: z.string().trim().optional().nullable(),
  email: z.string().trim().email().optional().nullable(),
  source: z.enum(LEAD_SOURCES).optional(),
  campaign: z.string().trim().max(120).optional().nullable(),
  adName: z.string().trim().max(120).optional().nullable(),
  projectId: z.string().optional().nullable(),
  budget: money.optional().nullable(),
  financingNeeded: z.boolean().optional().nullable(),
  preferredBank: z.string().trim().max(200).optional().nullable(),
  preferredLocation: z.string().trim().max(200).optional().nullable(),
  propertyType: z.enum(PROPERTY_TYPES).optional().nullable(),
  requirement: z.string().trim().max(1000).optional().nullable(),
  priority: z.enum(PRIORITIES).optional(),
  status: z.string().optional(),
  tags: z.array(z.string().max(40)).optional(),
  notes: z.string().trim().max(4000).optional().nullable(),
  sourceRef: z.string().trim().max(120).optional().nullable(),
  meta: z.record(z.unknown()).optional(),
});

export const createLeadSchema = leadBaseSchema
  .extend({ status: z.enum(['NEW']).optional().default('NEW') })
  .refine((d) => d.phone || d.email || d.whatsapp, {
    message: 'Provide at least a phone, WhatsApp or email',
    path: ['phone'],
  });

export const updateLeadSchema = leadBaseSchema.partial();

export const assignLeadSchema = z.object({
  userId: z.string().min(1),
  rule: z.string().max(60).optional(),
});

export const statusChangeSchema = z.object({
  status: z.string().min(1),
  reason: z.string().trim().max(1000).optional(),
  note: z.string().trim().max(4000).optional(),
});

export const activityCreateSchema = z.object({
  type: z.enum(ACTIVITY_TYPES).default('NOTE'),
  note: z.string().trim().max(4000).optional(),
  meta: z.record(z.unknown()).optional(),
});

export const mergeLeadsSchema = z.object({
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
});

export const webhookLeadSchema = z.object({
  name: z.string().trim().min(1),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  email: z.string().email().optional(),
  campaign: z.string().optional(),
  adName: z.string().optional(),
  project: z.string().optional(),
  budget: z.union([z.number(), z.string()]).optional(),
  preferredLocation: z.string().optional(),
  propertyType: z.string().optional(),
  requirement: z.string().optional(),
  sourceRef: z.string().optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  raw: z.record(z.unknown()).optional(),
});

// ---------------------------------------------------------------- Follow-ups
export const followupCreateCore = z.object({
  leadId: z.string().optional(),
  customerId: z.string().optional(),
  type: z.enum(FOLLOWUP_TYPES).default('CALL'),
  scheduledAt: isoDate,
  reminderAt: isoDate.optional(),
  notes: z.string().trim().max(4000).optional(),
  assignedTo: z.string().optional(),
  remindBeforeMinutes: z.number().int().min(0).max(1440).optional(),
});

export const followupCreateSchema = followupCreateCore.refine((d) => d.leadId || d.customerId, { message: 'Link to a lead or customer', path: ['leadId'] });

export const followupCompleteSchema = z.object({
  outcome: z.string().trim().max(2000).optional(),
  nextFollowupAt: isoDate.optional(),
  nextFollowupType: z.enum(FOLLOWUP_TYPES).optional(),
  nextFollowupNote: z.string().trim().max(2000).optional(),
});

export const followupUpdateSchema = followupCreateCore.partial();

// ---------------------------------------------------------------- Meetings / Site visits
export const meetingCreateCore = z.object({
  leadId: z.string().optional(),
  customerId: z.string().optional(),
  projectId: z.string().optional(),
  type: z.enum(MEETING_TYPES).default('MEETING'),
  visitNumber: z.number().int().min(1).max(3).optional(),
  title: z.string().trim().max(200).optional(),
  scheduledAt: isoDate,
  status: z.enum(MEETING_STATUS).default('SCHEDULED'),
  location: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(4000).optional(),
  assignedTo: z.string().optional(),
  feedback: z.string().trim().max(4000).optional(),
  nextAction: z.string().trim().max(2000).optional(),
});

export const meetingCreateSchema = meetingCreateCore.refine((d) => d.leadId || d.customerId, { message: 'Link to a lead or customer', path: ['leadId'] });

export const meetingUpdateSchema = meetingCreateCore.partial();

// ---------------------------------------------------------------- Customers
export const customerCreateSchema = z.object({
  leadId: z.string().optional().nullable(),
  name: z.string().trim().min(1).max(200),
  phone: z.string().optional().nullable(),
  whatsapp: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN').optional().nullable(),
  aadhaar: z.string().trim().regex(/^\d{4}\s?\d{4}\s?\d{4}$/, 'Invalid Aadhaar').optional().nullable(),
  address: z.string().trim().max(1000).optional().nullable(),
  city: z.string().trim().max(100).optional().nullable(),
  state: z.string().trim().max(100).optional().nullable(),
  pincode: z.string().trim().max(10).optional().nullable(),
  ownerId: z.string().optional().nullable(),
  tags: z.array(z.string().max(40)).optional(),
  notes: z.string().trim().max(4000).optional().nullable(),
});

export const customerUpdateSchema = customerCreateSchema.partial();

// ---------------------------------------------------------------- Projects / units
export const projectCreateSchema = z.object({
  code: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(200),
  location: z.string().trim().min(1).max(300),
  city: z.string().trim().max(100).optional().default(''),
  state: z.string().trim().max(100).optional().default(''),
  reraNo: z.string().trim().max(120).optional().nullable(),
  description: z.string().trim().max(4000).optional().nullable(),
  status: z.enum(PROJECT_STATUS).optional().default('ACTIVE'),
  priceRangeMin: money.optional().nullable(),
  priceRangeMax: money.optional().nullable(),
  amenities: z.array(z.string()).optional(),
});

export const projectUpdateSchema = projectCreateSchema.partial();

export const towerCreateSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  floors: z.number().int().min(1).max(200).default(1),
  unitsPerFloor: z.number().int().min(1).max(20).default(4),
});

export const unitCreateSchema = z.object({
  projectId: z.string().min(1),
  towerId: z.string().optional().nullable(),
  unitNo: z.string().trim().min(1).max(40),
  floor: z.number().int().min(0).max(200).optional().nullable(),
  unitType: z.enum(UNIT_TYPE).default('APARTMENT'),
  bhk: z.string().max(12).default('2'),
  areaSqft: money.optional().nullable(),
  facing: z.string().trim().max(60).optional().nullable(),
  price: money,
  status: z.enum(UNIT_STATUS).default('AVAILABLE'),
});

export const unitUpdateSchema = unitCreateSchema.partial();

// ---------------------------------------------------------------- Bookings
export const bookingCreateSchema = z.object({
  customerId: z.string().optional(),
  leadId: z.string().optional(),
  newCustomer: customerCreateSchema.partial().optional(),
  projectId: z.string().min(1),
  towerId: z.string().optional().nullable(),
  unitId: z.string().optional().nullable(),
  saleValue: money,
  bookingAmount: money.optional().default('0'),
  paymentDetails: z.record(z.unknown()).optional(),
  salespersonId: z.string().optional(),
  teamLeaderId: z.string().optional(),
  brokerId: z.string().optional(),
  brokerName: z.string().trim().max(120).optional().nullable(),
  bookingDate: isoDate,
  notes: z.string().trim().max(4000).optional().nullable(),
});

export const bookingUpdateSchema = bookingCreateSchema.partial();

export const paymentCreateSchema = z.object({
  amount: money,
  paymentDate: isoDate,
  method: z.enum(PAYMENT_METHODS).default('BANK_TRANSFER'),
  reference: z.string().trim().max(120).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export const cancellationCreateSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
  reasonCategory: z.string().max(80).optional().default('OTHER'),
  cancelledAt: isoDate,
  refundAmount: money.optional().default('0'),
  refundStatus: z.enum(['PENDING', 'APPROVED', 'PAID', 'REJECTED']).optional().default('PENDING'),
  notes: z.string().trim().max(4000).optional().nullable(),
});

export const cancellationApproveSchema = z.object({
  approved: z.boolean(),
  note: z.string().trim().max(1000).optional(),
});

export const refundCreateSchema = z.object({
  amount: money,
  date: isoDate,
  method: z.enum(PAYMENT_METHODS).optional(),
  reference: z.string().trim().max(120).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export const expenseCreateSchema = z.object({
  category: z.string().trim().min(1).max(80).default('OTHER'),
  amount: money,
  date: isoDate,
  description: z.string().trim().max(1000).optional(),
  projectId: z.string().optional().nullable(),
});

// ---------------------------------------------------------------- Sales targets
/** `YYYY-MM`, matching analytics.monthKey so the two can be joined directly. */
const period = z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');

export const targetUpsertSchema = z
  .object({
    userId: z.string().min(1),
    projectId: z.string().optional().nullable(),
    bookingValueTarget: money.optional().nullable(),
    collectionTarget: money.optional().nullable(),
    leadCountTarget: z.number().int().nonnegative().optional().nullable(),
    bookingCountTarget: z.number().int().nonnegative().optional().nullable(),
    notes: z.string().trim().max(1000).optional().nullable(),
  })
  // A row with no metric at all is a silent no-op that looks saved.
  .refine(
    (d) =>
      d.bookingValueTarget != null ||
      d.collectionTarget != null ||
      d.leadCountTarget != null ||
      d.bookingCountTarget != null,
    { message: 'Set at least one target metric', path: ['bookingValueTarget'] },
  );

export const targetBulkSchema = z.object({
  period,
  rows: z.array(targetUpsertSchema).min(1).max(200),
});

// ---------------------------------------------------------------- Collection schedule
export const milestoneCreateSchema = z.object({
  bookingId: z.string().min(1),
  name: z.string().trim().min(1, 'Name is required').max(200),
  dueDate: isoDate,
  percentage: z.number().min(0).max(100).optional().nullable(),
  /** Explicit amount; when omitted it is derived from the booking sale value. */
  amount: money.optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export const milestonePlanSchema = z.object({
  bookingId: z.string().min(1),
  /** Applied in array order; each row's seq is assigned server-side. */
  milestones: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        dueDate: isoDate,
        percentage: z.number().min(0).max(100).optional().nullable(),
        amount: money.optional().nullable(),
      }),
    )
    .min(1, 'A plan needs at least one milestone')
    .max(40),
});

export const milestoneUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  dueDate: isoDate.optional(),
  percentage: z.number().min(0).max(100).optional().nullable(),
  amount: money.optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  status: z.enum(MILESTONE_STATUS).optional(),
});

export const milestonePaymentSchema = z.object({
  bookingId: z.string().min(1),
  amount: z.union([z.number().positive('Amount must be greater than 0'), z.string().regex(/^\d{1,12}(\.\d{1,2})?$/)]),
  method: z.enum(PAYMENT_METHODS).default('BANK_TRANSFER'),
  reference: z.string().trim().max(120).optional().nullable(),
  paymentDate: isoDate.optional(),
  /** Apply the whole payment to this milestone instead of allocating by age. */
  milestoneId: z.string().min(1).optional().nullable(),
  /** Allocate to the oldest outstanding milestone first. Defaults to true. */
  autoAllocate: z.boolean().default(true),
});

export const receiptIssueSchema = z.object({
  receiptDate: isoDate.optional(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export const receiptVoidSchema = z.object({
  reason: z.string().trim().min(3, 'A reason is required to void a receipt').max(500),
});

// ---------------------------------------------------------------- Home loans
export const loanCreateSchema = z
  .object({
    bookingId: z.string().min(1),
    applicantName: z.string().trim().max(200).optional().nullable(),
    applicantRelation: z.enum(APPLICANT_RELATIONS).optional().nullable(),
    bankName: z.string().trim().max(200).optional().nullable(),
    applicationNo: z.string().trim().max(120).optional().nullable(),
    loanType: z.enum(LOAN_TYPES).default('HOME'),
    loanAmount: money.optional().nullable(),
    marginAmount: money.optional().nullable(),
    propertyValuation: money.optional().nullable(),
    interestRate: z.number().min(0).max(100).optional().nullable(),
    tenureMonths: z.number().int().min(1).max(600).optional().nullable(),
    emi: money.optional().nullable(),
    status: z.enum(LOAN_STATUS).default('APPLIED'),
    applicationDate: isoDate.optional(),
    sanctionDate: isoDate.optional().nullable(),
    disbursementDate: isoDate.optional().nullable(),
    remarks: z.string().trim().max(2000).optional().nullable(),
  });
  // No refine demanding a date: createLoan stamps applicationDate with today
  // when it is absent, so "raise a loan right now" has to be a valid request.

export const loanUpdateSchema = z.object({
  applicantName: z.string().trim().max(200).optional().nullable(),
  applicantRelation: z.enum(APPLICANT_RELATIONS).optional().nullable(),
  bankName: z.string().trim().max(200).optional().nullable(),
  applicationNo: z.string().trim().max(120).optional().nullable(),
  loanType: z.enum(LOAN_TYPES).optional(),
  loanAmount: money.optional().nullable(),
  marginAmount: money.optional().nullable(),
  propertyValuation: money.optional().nullable(),
  interestRate: z.number().min(0).max(100).optional().nullable(),
  tenureMonths: z.number().int().min(1).max(600).optional().nullable(),
  emi: money.optional().nullable(),
  status: z.enum(LOAN_STATUS).optional(),
  sanctionDate: isoDate.optional().nullable(),
  disbursementDate: isoDate.optional().nullable(),
  remarks: z.string().trim().max(2000).optional().nullable(),
});

// ---------------------------------------------------------------- Documents
export const documentVerifySchema = z.object({
  verificationStatus: z.enum(VERIFICATION_STATUS),
  verificationNote: z.string().trim().max(2000).optional().nullable(),
});

export const documentUploadMetaSchema = z.object({
  customerId: z.string().optional().nullable(),
  bookingId: z.string().optional().nullable(),
  leadId: z.string().optional().nullable(),
  documentType: z.enum(DOCUMENT_TYPES).default('OTHER'),
  title: z.string().trim().max(200).optional(),
});

// ---------------------------------------------------------------- Commission engine
export const commissionRuleCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(COMMISSION_TYPES).default('PERCENTAGE'),
  payableTo: z.enum(PAYABLE_TO).default('SALES_EXECUTIVE'),
  personId: z.string().optional().nullable(),
  projectId: z.string().optional().nullable(),
  brokerName: z.string().trim().max(120).optional().nullable(),
  rate: z.union([z.number().min(0).max(100), z.string().regex(/^\d{1,4}(\.\d{1,4})?$/)]).optional(),
  fixedAmount: money.optional().nullable(),
  slabConfig: z
    .array(z.object({
      max: z.number().nonnegative(),
      rate: z.number().min(0).max(100),
      fixed: z.number().optional(),
    }))
    .default([]),
  collectionWindowDays: z.number().int().min(1).max(3650).optional().nullable(),
  effectiveFrom: isoDate.optional(),
  effectiveTo: isoDate.optional().nullable(),
  notes: z.string().trim().max(1000).optional(),
});

export const commissionRuleUpdateSchema = commissionRuleCreateSchema.partial();

export const adjustmentCreateSchema = z.object({
  snapshotId: z.string().min(1),
  amount: z.number(),
  type: z.enum(['ADJUSTMENT', 'DEDUCTION', 'REVERSAL']).default('ADJUSTMENT'),
  reason: z.string().trim().min(1).max(1000),
});

export const payoutCreateSchema = z.object({
  periodFrom: isoDate.optional(),
  periodTo: isoDate.optional(),
  snapshotIds: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------- Team / settings / automation
export const userUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  phone: z.string().optional().nullable(),
  role: z.enum(ROLES).optional(),
  managerId: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
});

export const automationRuleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  trigger: z.enum(AUTOMATION_TRIGGERS),
  actions: z.array(z.record(z.unknown())).min(1, 'At least one action required'),
  config: z.record(z.unknown()).optional(),
  isActive: z.boolean().default(true),
});

export const integrationSchema = z.object({
  provider: z.string().trim().min(1).max(60),
  label: z.string().trim().min(1).max(120),
  config: z.record(z.unknown()).optional(),
  webhookSecret: z.string().optional(),
  isActive: z.boolean().default(false),
});

export const assignmentConfigSchema = z.object({
  mode: z.enum(['ROUND_ROBIN', 'SOURCE_BASED', 'PROJECT_BASED', 'MANUAL']).default('ROUND_ROBIN'),
  sources: z.record(z.array(z.string())).optional(),
  projects: z.record(z.array(z.string())).optional(),
  teamIds: z.array(z.string()).optional(),
});

export const importMappingSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  email: z.string().optional(),
  source: z.string().optional(),
  campaign: z.string().optional(),
  adName: z.string().optional(),
  project: z.string().optional(),
  budget: z.string().optional(),
  preferredLocation: z.string().optional(),
  propertyType: z.string().optional(),
  requirement: z.string().optional(),
  notes: z.string().optional(),
  tags: z.string().optional(),
});