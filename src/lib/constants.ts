// ------------------------------------------------------------------
// Central domain enumerations used across the whole CRM.
// The DB stores these as text; validation is app-level via Zod, with
// a few CHECK constraints added in migrations.
// ------------------------------------------------------------------

export const LEAD_STATUSES = [
  'NEW',
  'CONTACT_PENDING',
  'CONTACTED',
  'QUALIFIED',
  'FOLLOW_UP',
  'MEETING',
  'SITE_VISIT_1',
  'SITE_VISIT_2',
  'SITE_VISIT_3',
  'NEGOTIATION',
  'BOOKING',
  'DOCUMENT_COLLECTION',
  'DEAL_COMPLETED',
  'NOT_INTERESTED',
  'CALL_BACK_LATER',
  'WRONG_NUMBER',
  'DUPLICATE',
  'LOST',
  'CANCELLED',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const OPEN_STATUSES: LeadStatus[] = [
  'NEW',
  'CONTACT_PENDING',
  'CONTACTED',
  'QUALIFIED',
  'FOLLOW_UP',
  'MEETING',
  'SITE_VISIT_1',
  'SITE_VISIT_2',
  'SITE_VISIT_3',
  'NEGOTIATION',
  'BOOKING',
  'DOCUMENT_COLLECTION',
];

export const CLOSED_STATUSES: LeadStatus[] = [
  'DEAL_COMPLETED',
  'NOT_INTERESTED',
  'CALL_BACK_LATER',
  'WRONG_NUMBER',
  'DUPLICATE',
  'LOST',
  'CANCELLED',
];

// Pipeline progression for validation / analytics
export const PIPELINE_POSITION: Record<LeadStatus, number> = {
  NEW: 0,
  CONTACT_PENDING: 1,
  CONTACTED: 2,
  QUALIFIED: 3,
  FOLLOW_UP: 4,
  MEETING: 5,
  SITE_VISIT_1: 6,
  SITE_VISIT_2: 7,
  SITE_VISIT_3: 8,
  NEGOTIATION: 9,
  BOOKING: 10,
  DOCUMENT_COLLECTION: 11,
  DEAL_COMPLETED: 12,
  NOT_INTERESTED: -1,
  CALL_BACK_LATER: -2,
  WRONG_NUMBER: -3,
  DUPLICATE: -4,
  LOST: -5,
  CANCELLED: -6,
};

export const ACTIVITY_TYPES = [
  'CALL',
  'WHATSAPP',
  'EMAIL',
  'MEETING',
  'SITE_VISIT',
  'NOTE',
  'STATUS_CHANGE',
  'FOLLOWUP_CREATED',
  'BOOKING',
  'DOCUMENT_UPLOAD',
  'PAYMENT',
  'CANCELLATION',
  'ASSIGNMENT',
  'IMPORT',
  'MERGE',
  'SYSTEM',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const LEAD_SOURCES = [
  'INSTAGRAM',
  'FACEBOOK',
  'WHATSAPP',
  'NINE9ACRES',
  'REALESTATE_INDIA',
  'MAGICBRICKS',
  'YOUTUBE_ADS',
  'WEBSITE',
  'REFERRAL',
  'MANUAL',
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PROPERTY_TYPES = [
  'APARTMENT',
  'VILLA',
  'PLOT',
  'COMMERCIAL',
  'PENTHOUSE',
  'ROW_HOUSE',
] as const;

export const FOLLOWUP_TYPES = ['CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'SITE_VISIT', 'OTHER'] as const;
export const FOLLOWUP_STATUS = ['PENDING', 'COMPLETED', 'SKIPPED', 'EXPIRED'] as const;

export const MEETING_TYPES = ['MEETING', 'SITE_VISIT'] as const;
export const MEETING_STATUS = [
  'SCHEDULED',
  'CONFIRMED',
  'COMPLETED',
  'RESCHEDULED',
  'CANCELLED',
  'NO_SHOW',
] as const;

export const PROJECT_STATUS = ['DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED'] as const;

export const UNIT_TYPE = ['APARTMENT', 'VILLA', 'PLOT', 'COMMERCIAL', 'PENTHOUSE', 'ROW_HOUSE'] as const;

export const UNIT_STATUS = ['AVAILABLE', 'HOLD', 'BOOKED', 'SOLD', 'CANCELLED'] as const;
export type UnitStatus = (typeof UNIT_STATUS)[number];

export const BHK = ['1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5', '5', 'STUDIO'] as const;

export const BOOKING_STATUS = [
  'DRAFT',
  'CONFIRMED',
  'DOCUMENT_COLLECTION',
  'COMPLETED',
  'CANCELLED',
] as const;

export const CANCELLATION_STATUS = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export const REFUND_STATUS = ['NOT_APPLICABLE', 'PENDING', 'APPROVED', 'PAID', 'REJECTED'] as const;

export const DOCUMENT_TYPES = [
  'PAN',
  'AADHAAR',
  'PHOTO',
  'ADDRESS_PROOF',
  'BANK_DOCUMENT',
  'LOAN_DOCUMENT',
  'AGREEMENT',
  'BOOKING_FORM',
  'PAYMENT_RECEIPT',
  'OTHER',
] as const;

export const VERIFICATION_STATUS = ['PENDING', 'VERIFIED', 'REJECTED', 'RE_UPLOAD'] as const;

export const COMMISSION_TYPES = [
  'PERCENTAGE',
  'FIXED',
  'COLLECTION_BASED',
  'SALE_VALUE_BASED',
  'SLAB_BASED',
] as const;

export const PAYABLE_TO = ['SALES_EXECUTIVE', 'TEAM_LEADER', 'SALES_MANAGER', 'BROKER', 'OTHER'] as const;

export const COMMISSION_STATUS = ['PENDING', 'PAYABLE', 'APPROVED', 'PAID', 'ADJUSTED', 'REVERSED'] as const;

export const PAYOUT_BATCH_STATUS = ['DRAFT', 'PROCESSED', 'PAID'] as const;
export const PAYOUT_STATUS = ['PENDING', 'PROCESSED', 'PAID', 'REVERSED'] as const;

export const PAYMENT_METHODS = ['CASH', 'CHEQUE', 'BANK_TRANSFER', 'UPI', 'CARD', 'NEFT', 'RTGS'] as const;

export const MILESTONE_STATUS = ['PENDING', 'PARTIAL', 'PAID', 'WAIVED'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUS)[number];

/** Receivables ageing buckets, in days past due. */
export const AGING_BUCKETS = [
  { key: 'current', label: 'Not due', min: -Infinity, max: 0 },
  { key: 'd1_30', label: '1-30 days', min: 0, max: 30 },
  { key: 'd31_60', label: '31-60 days', min: 30, max: 60 },
  { key: 'd61_90', label: '61-90 days', min: 60, max: 90 },
  { key: 'd90plus', label: '90+ days', min: 90, max: Infinity },
] as const;

export const NOTIFICATION_TYPES = [
  'LEAD_ASSIGNED',
  'FOLLOWUP_REMINDER',
  'UPCOMING_VISIT',
  'DOCUMENT_REJECTED',
  'DOCUMENT_VERIFIED',
  'PAYMENT_REMINDER',
  'BOOKING_EVENT',
  'COMMISSION_EVENT',
  'SYSTEM',
] as const;

export const AUTOMATION_TRIGGERS = [
  'LEAD_CREATED',
  'VISIT_COMPLETED',
  'BOOKING_COMPLETED',
  'FOLLOWUP_DONE',
  'DOCUMENT_VERIFIED',
] as const;

export const AUDIT_ACTIONS = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'STATUS_CHANGE',
  'ASSIGN',
  'MERGE',
  'IMPORT',
  'EXPORT',
  'LOGIN',
  'UPLOAD',
  'VERIFY',
  'REJECT',
  'APPROVE',
  'CANCEL',
  'PAYOUT',
  'COMMISSION_CALC',
] as const;

// ------------------------- Roles & RBAC -------------------------

export const ROLES = [
  'SUPER_ADMIN',
  'ADMIN',
  'SALES_MANAGER',
  'TEAM_LEADER',
  'SALES_EXECUTIVE',
  'DOCUMENT_MANAGER',
  'ACCOUNTS',
  'VIEW_ONLY',
] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | 'leads.view'
  | 'leads.create'
  | 'leads.update'
  | 'leads.assign'
  | 'leads.merge'
  | 'leads.delete'
  | 'leads.import'
  | 'leads.export'
  | 'followups.manage'
  | 'meetings.manage'
  | 'visits.manage'
  | 'customers.view'
  | 'customers.create'
  | 'customers.update'
  | 'customers.delete'
  | 'projects.view'
  | 'projects.manage'
  | 'units.manage'
  | 'bookings.view'
  | 'bookings.manage'
  | 'bookings.cancel'
  | 'cancellations.approve'
  | 'documents.manage'
  | 'documents.verify'
  | 'documents.download'
  | 'accounts.view'
  | 'targets.view'
  | 'targets.manage'
  | 'collections.view'
  | 'collections.manage'
| 'receipts.issue'
  | 'payments.record'
  | 'commissions.manage'
  | 'commissions.approve'
  | 'payouts.manage'
  | 'reports.view'
  | 'team.manage'
  | 'integrations.manage'
  | 'automation.manage'
  | 'settings.manage'
  | 'audit.view'
  | 'search.global'
  | 'users.view';

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPER_ADMIN: [],
  ADMIN: [
    'leads.view', 'leads.create', 'leads.update', 'leads.assign', 'leads.merge', 'leads.delete', 'leads.import', 'leads.export',
    'followups.manage', 'meetings.manage', 'visits.manage',
    'projects.view',
    'customers.view', 'customers.create', 'customers.update', 'customers.delete',
    'projects.manage', 'units.manage',
    'bookings.view', 'bookings.manage', 'bookings.cancel', 'cancellations.approve',
    'documents.manage', 'documents.verify', 'documents.download',
    'accounts.view', 'commissions.manage', 'commissions.approve', 'payouts.manage',
    'targets.view', 'targets.manage', 'collections.view', 'collections.manage', 'receipts.issue', 'payments.record',
    'reports.view', 'team.manage', 'integrations.manage', 'automation.manage', 'settings.manage', 'audit.view',
    'search.global', 'users.view',
  ],
  SALES_MANAGER: [
    'leads.view', 'leads.create', 'leads.update', 'leads.assign', 'leads.merge', 'leads.import', 'leads.export',
    'followups.manage', 'meetings.manage', 'visits.manage',
    'projects.view',
    'customers.view', 'customers.create', 'customers.update',
    'projects.manage', 'units.manage',
    'bookings.view', 'bookings.manage', 'bookings.cancel',
    'documents.manage', 'documents.download',
    'accounts.view', 'commissions.manage',
    'targets.view', 'targets.manage', 'collections.view', 'receipts.issue', 'payments.record',
    'reports.view', 'search.global', 'users.view',
  ],
  TEAM_LEADER: [
    'leads.view', 'leads.create', 'leads.update', 'leads.assign', 'leads.export',
    'followups.manage', 'meetings.manage', 'visits.manage',
    'projects.view',
    'customers.view', 'customers.create', 'customers.update',
    'bookings.view', 'bookings.manage',
    'documents.manage', 'documents.download',
    'accounts.view', 'targets.view', 'collections.view',
    'reports.view', 'search.global', 'users.view',
  ],
  SALES_EXECUTIVE: [
    'leads.view', 'leads.create', 'leads.update',
    'followups.manage', 'meetings.manage', 'visits.manage',
    'projects.view',
    'customers.view', 'customers.create', 'customers.update',
    'bookings.view',
    'documents.manage', 'documents.download',
    'accounts.view',
    'targets.view', 'collections.view', 'payments.record',
    'search.global',
  ],
  DOCUMENT_MANAGER: [
    'leads.view', 'customers.view', 'documents.manage', 'documents.verify', 'documents.download', 'search.global',
  ],
  ACCOUNTS: [
    'leads.view', 'customers.view', 'projects.manage', 'units.manage',
    'bookings.view', 'accounts.view', 'commissions.manage', 'commissions.approve', 'payouts.manage',
    'targets.view', 'collections.view', 'collections.manage', 'receipts.issue', 'payments.record',
    'reports.view', 'search.global', 'users.view',
  ],
  VIEW_ONLY: [
    'leads.view', 'customers.view', 'bookings.view', 'accounts.view',
    'targets.view', 'collections.view',
    'reports.view', 'search.global',
  ],
};

// Computed once so SUPER_ADMIN gets all permissions safely
const ALL_PERMS = new Set<string>();
for (const perms of Object.values(ROLE_PERMISSIONS)) for (const p of perms) ALL_PERMS.add(p);
ROLE_PERMISSIONS.SUPER_ADMIN = [...ALL_PERMS] as Permission[];

export const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin',
  ADMIN: 'Admin',
  SALES_MANAGER: 'Sales Manager',
  TEAM_LEADER: 'Team Leader',
  SALES_EXECUTIVE: 'Sales Executive',
  DOCUMENT_MANAGER: 'Document Manager',
  ACCOUNTS: 'Accounts',
  VIEW_ONLY: 'View Only',
};

// Levels for resource scoping: higher can see more
export const ROLE_LEVEL: Record<Role, number> = {
  SUPER_ADMIN: 7,
  ADMIN: 6,
  SALES_MANAGER: 5,
  TEAM_LEADER: 4,
  SALES_EXECUTIVE: 3,
  DOCUMENT_MANAGER: 2,
  ACCOUNTS: 2,
  VIEW_ONLY: 1,
};

export const STATUS_COLORS: Record<string, string> = {
  NEW: 'bg-blue-50 text-blue-700 ring-blue-200',
  CONTACT_PENDING: 'bg-slate-100 text-slate-700 ring-slate-200',
  CONTACTED: 'bg-cyan-50 text-cyan-700 ring-cyan-200',
  QUALIFIED: 'bg-teal-50 text-teal-700 ring-teal-200',
  FOLLOW_UP: 'bg-amber-50 text-amber-700 ring-amber-200',
  MEETING: 'bg-purple-50 text-purple-700 ring-purple-200',
  SITE_VISIT_1: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  SITE_VISIT_2: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  SITE_VISIT_3: 'bg-indigo-100 text-indigo-800 ring-indigo-300',
  NEGOTIATION: 'bg-orange-50 text-orange-700 ring-orange-200',
  BOOKING: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  DOCUMENT_COLLECTION: 'bg-lime-50 text-lime-700 ring-lime-200',
  DEAL_COMPLETED: 'bg-green-100 text-green-800 ring-green-300',
  NOT_INTERESTED: 'bg-red-50 text-red-600 ring-red-200',
  CALL_BACK_LATER: 'bg-yellow-50 text-yellow-700 ring-yellow-200',
  WRONG_NUMBER: 'bg-slate-100 text-slate-500 ring-slate-200',
  DUPLICATE: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200',
  LOST: 'bg-red-50 text-red-700 ring-red-200',
  CANCELLED: 'bg-red-100 text-red-800 ring-red-300',
};