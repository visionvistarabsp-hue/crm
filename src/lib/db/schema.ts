import { relations, sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  primaryKey,
  boolean,
} from 'drizzle-orm/pg-core';

const uuid = () => globalThis.crypto.randomUUID();

const id = () => text('id').primaryKey().$defaultFn(() => uuid());
const now = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();

const money = (name: string) => numeric(name, { precision: 14, scale: 2 });

// ------------------------------------------------------------------
// Users & Team
// ------------------------------------------------------------------
export const users = pgTable('users', {
  id: id(),
  name: text('name').notNull(),
  // Login identity. Enforced case-insensitively (see users_email_lower_key).
  email: text('email').notNull(),
  // scrypt digest, format: scrypt$N$r$p$saltB64$hashB64. NULL = cannot log in
  // (service accounts such as the Meta webhook bot).
  passwordHash: text('password_hash'),
  phone: text('phone'),
  role: text('role').notNull().default('SALES_EXECUTIVE'),
  // NOTE: manager_id FK is added in constraints.ts (self-reference breaks TS inference)
  managerId: text('manager_id'),
  avatar: text('avatar'),
  isActive: boolean('is_active').notNull().default(true),
  remindersEnabled: boolean('reminders_enabled').notNull().default(true),
  // Real-time new-lead alerts, split from remindersEnabled on purpose: a user
  // may want to mute the 12-hour digest while still being paged the moment a
  // lead arrives, because the two answer different urgencies.
  newLeadAlertsEnabled: boolean('new_lead_alerts_enabled').notNull().default(true),
  reminderTime: text('reminder_time').notNull().default('09:00'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_users_role').on(t.role),
  index('idx_users_manager').on(t.managerId),
  uniqueIndex('users_email_lower_key').on(sql`lower(${t.email})`),
]);

// ------------------------------------------------------------------
// Auth sessions (one row per signed-in browser)
// ------------------------------------------------------------------
export const sessions = pgTable('sessions', {
  id: id(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // sha256 of the opaque cookie token — a leaked DB row cannot be replayed
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: now(),
}, (t) => [
  uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
  index('idx_sessions_user').on(t.userId),
  index('idx_sessions_expires').on(t.expiresAt),
]);

// ------------------------------------------------------------------
// Projects / Towers / Units inventory
// ------------------------------------------------------------------
export const projects = pgTable('projects', {
  id: id(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  location: text('location').notNull(),
  city: text('city').notNull().default(''),
  state: text('state').notNull().default(''),
  reraNo: text('rera_no'),
  description: text('description'),
  status: text('status').notNull().default('ACTIVE'),
  priceRangeMin: money('price_range_min'),
  priceRangeMax: money('price_range_max'),
  amenities: jsonb('amenities').$type<string[]>().default([]),
  images: jsonb('images').$type<string[]>().default([]),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_projects_status').on(t.status),
]);

export const towers = pgTable('towers', {
  id: id(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  floors: integer('floors').notNull().default(0),
  unitsPerFloor: integer('units_per_floor').notNull().default(0),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_towers_project').on(t.projectId),
]);

export const units = pgTable('units', {
  id: id(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  towerId: text('tower_id').references(() => towers.id, { onDelete: 'set null' }),
  unitNo: text('unit_no').notNull(),
  floor: integer('floor'),
  unitType: text('unit_type').notNull().default('APARTMENT'),
  bhk: text('bhk').notNull().default('2'),
  areaSqft: numeric('area_sqft', { precision: 10, scale: 2 }),
  facing: text('facing'),
  price: money('price').notNull(),
  status: text('status').notNull().default('AVAILABLE'),
  bookingId: text('booking_id'),
  customerId: text('customer_id'),
  holdUntil: timestamp('hold_until', { withTimezone: true }),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('uq_unit_project_unitno').on(t.projectId, t.unitNo),
  index('idx_units_project').on(t.projectId),
  index('idx_units_tower').on(t.towerId),
  index('idx_units_status').on(t.status),
]);

// ------------------------------------------------------------------
// Customers
// ------------------------------------------------------------------
export const customers = pgTable('customers', {
  id: id(),
  customerNo: text('customer_no').notNull().unique(),
  leadId: text('lead_id'),
  name: text('name').notNull(),
  phone: text('phone'),
  whatsapp: text('whatsapp'),
  email: text('email'),
  pan: text('pan'),
  aadhaar: text('aadhaar'),
  address: text('address'),
  city: text('city'),
  state: text('state'),
  pincode: text('pincode'),
  ownerId: text('owner_id').references(() => users.id),
  tags: jsonb('tags').$type<string[]>().default([]),
  notes: text('notes'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_customers_phone').on(t.phone),
  index('idx_customers_email').on(t.email),
  index('idx_customers_owner').on(t.ownerId),
  index('idx_customers_name').on(t.name),
]);

// ------------------------------------------------------------------
// Leads
// ------------------------------------------------------------------
export const leads = pgTable('leads', {
  id: id(),
  leadNo: text('lead_no').notNull().unique(),
  name: text('name').notNull(),
  phone: text('phone'),
  whatsapp: text('whatsapp'),
  email: text('email'),
  source: text('source').notNull().default('MANUAL'),
  campaign: text('campaign'),
  adName: text('ad_name'),
  projectId: text('project_id').references(() => projects.id),
  budget: money('budget'),
  // Financing intent, captured at enquiry time. Buyers who need a home loan
  // convert on a different clock and stall differently, so sales needs to
  // filter on this before the booking even exists.
  financingNeeded: boolean('financing_needed').notNull().default(false),
  preferredBank: text('preferred_bank'),
  preferredLocation: text('preferred_location'),
  propertyType: text('property_type'),
  requirement: text('requirement'),
  ownerId: text('owner_id').references(() => users.id),
  assignedAt: timestamp('assigned_at', { withTimezone: true }),
  priority: text('priority').notNull().default('MEDIUM'),
  status: text('status').notNull().default('NEW'),
  tags: jsonb('tags').$type<string[]>().default([]),
  isDuplicate: boolean('is_duplicate').notNull().default(false),
  duplicateOfId: text('duplicate_of_id'),
  notes: text('notes'),
  sourceRef: text('source_ref'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  createdById: text('created_by_id').references(() => users.id),
  // Stamped by the first human interaction (edit, status change, logged
  // activity). Null means nobody has engaged the lead yet, which is what the
  // manager escalation scans for. Deliberately not set on INSERT: a lead that
  // arrives already "handled" would never escalate.
  firstTouchedAt: timestamp('first_touched_at', { withTimezone: true }),
  // Stamped when the unclaimed-lead escalation is queued. Kept separate from
  // the scan's dedupe key so an operator can see, in the row itself, whether
  // escalation already happened - and why a lead is or is not still a candidate.
  escalatedAt: timestamp('escalated_at', { withTimezone: true }),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_leads_phone').on(t.phone),
  index('idx_leads_email').on(t.email),
  index('idx_leads_status').on(t.status),
  index('idx_leads_source').on(t.source),
  index('idx_leads_owner').on(t.ownerId),
  index('idx_leads_project').on(t.projectId),
  index('idx_leads_priority').on(t.priority),
  index('idx_leads_created').on(t.createdAt),
  // Partial index for the unclaimed-lead escalation scan, which only ever asks
  // for leads that are still NEW, still untouched and not yet escalated - a
  // small slice of the table. Plain indexes above already satisfy the
  // `created_at` range, so this is purely an optimisation: without it every
  // 5-minute cron tick re-reads the whole window and discards most of it.
  index('idx_leads_unclaimed')
    .on(t.createdAt)
    .where(sql`${t.status} = 'NEW' AND ${t.firstTouchedAt} IS NULL AND ${t.escalatedAt} IS NULL`),
  /**
   * Provider webhook idempotency key.
   *
   * Webhooks are at-least-once: Meta (and every generic provider) will
   * re-deliver on a non-2xx or a timeout, and can double-deliver even on a
   * success. Without a unique key a retry silently creates a second lead, and
   * after the alert work that second lead also emails a real owner.
   *
   * Nullable, and deliberately left plain: Postgres treats NULLs as distinct in
   * a unique index, so manually created leads (no `source_ref`) are unlimited
   * while any real provider ref is claimed exactly once.
   */
  uniqueIndex('uq_leads_source_ref').on(t.sourceRef),
]);

export const leadsRelations = relations(leads, ({ one, many }) => ({
  owner: one(users, { fields: [leads.ownerId], references: [users.id] }),
  project: one(projects, { fields: [leads.projectId], references: [projects.id] }),
  activities: many(leadActivities),
  statusHistory: many(leadStatusHistory),
  followups: many(followups),
  meetings: many(meetings),
}));

// Immutable activity / status history
export const leadActivities = pgTable('lead_activities', {
  id: id(),
  leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  type: text('type').notNull().default('NOTE'),
  note: text('note'),
  meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
  performedById: text('performed_by_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_activities_lead').on(t.leadId),
  index('idx_activities_lead_created').on(t.leadId, t.createdAt),
]);

export const customerActivities = pgTable('customer_activities', {
  id: id(),
  customerId: text('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  type: text('type').notNull().default('NOTE'),
  note: text('note'),
  meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
  performedById: text('performed_by_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_customer_activities_customer').on(t.customerId),
  index('idx_customer_activities_customer_created').on(t.customerId, t.createdAt),
]);

export const leadStatusHistory = pgTable('lead_status_history', {
  id: id(),
  leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  reason: text('reason'),
  changedById: text('changed_by_id'),
  meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_status_history_lead').on(t.leadId),
]);

export const leadDuplicates = pgTable('lead_duplicates', {
  id: id(),
  leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  duplicateOfId: text('duplicate_of_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  ruleType: text('rule_type').notNull().default('PHONE'),
  confidence: integer('confidence').notNull().default(100),
  status: text('status').notNull().default('OPEN'), // OPEN | IGNORED | MERGED | NOT_DUPLICATE
  resolvedById: text('resolved_by_id'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
  createdAt: now(),
}, (t) => [
  index('idx_duplicates_lead').on(t.leadId),
  index('idx_duplicates_of').on(t.duplicateOfId),
]);

export const leadAssignments = pgTable('lead_assignments', {
  id: id(),
  leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  fromUserId: text('from_user_id'),
  toUserId: text('to_user_id').references(() => users.id),
  rule: text('rule').notNull().default('MANUAL'),
  ruleDetail: text('rule_detail'),
  assignedById: text('assigned_by_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_assignments_lead').on(t.leadId),
  index('idx_assignments_to').on(t.toUserId),
]);

// Received raw leads from external providers (normalized into leads)
export const incomingLeads = pgTable('incoming_leads', {
  id: id(),
  provider: text('provider').notNull(),
  rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>().notNull(),
  normalized: jsonb('normalized').$type<Record<string, unknown>>(),
  status: text('status').notNull().default('RECEIVED'), // RECEIVED | CREATED | DUPLICATE | ERROR | IGNORED
  leadId: text('lead_id').references(() => leads.id),
  error: text('error'),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_incoming_provider').on(t.provider),
  index('idx_incoming_status').on(t.status),
]);

// ------------------------------------------------------------------
// Follow-ups
// ------------------------------------------------------------------
export const followups = pgTable('followups', {
  id: id(),
  leadId: text('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
  customerId: text('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
  type: text('type').notNull().default('CALL'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  reminderAt: timestamp('reminder_at', { withTimezone: true }),
  status: text('status').notNull().default('PENDING'),
  notes: text('notes'),
  assignedTo: text('assigned_to').references(() => users.id),
  createdById: text('created_by_id').references(() => users.id),
  completedById: text('completed_by_id'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  remindBeforeMinutes: integer('remind_before_minutes').default(60),
  reminderSent: boolean('reminder_sent').notNull().default(false),
  nextFollowupId: text('next_followup_id'),
  meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_followups_lead').on(t.leadId),
  index('idx_followups_scheduled').on(t.scheduledAt),
  index('idx_followups_status').on(t.status),
  index('idx_followups_assigned').on(t.assignedTo),
  index('idx_followups_status_scheduled').on(t.status, t.scheduledAt),
]);

export const followupsRelations = relations(followups, ({ one }) => ({
  lead: one(leads, { fields: [followups.leadId], references: [leads.id] }),
  customer: one(customers, { fields: [followups.customerId], references: [customers.id] }),
  assignee: one(users, { fields: [followups.assignedTo], references: [users.id] }),
}));

// ------------------------------------------------------------------
// Meetings & Site Visits
// ------------------------------------------------------------------
export const meetings = pgTable('meetings', {
  id: id(),
  leadId: text('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  customerId: text('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  projectId: text('project_id').references(() => projects.id),
  type: text('type').notNull().default('MEETING'), // MEETING | SITE_VISIT
  visitNumber: integer('visit_number'), // 1 | 2 | 3 for site visits
  title: text('title'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('SCHEDULED'),
  location: text('location'),
  notes: text('notes'),
  feedback: text('feedback'),
  nextAction: text('next_action'),
  assignedTo: text('assigned_to').references(() => users.id),
  createdById: text('created_by_id').references(() => users.id),
  conversationDone: text('conversation_done').default(''),
  meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_meetings_lead').on(t.leadId),
  index('idx_meetings_type').on(t.type),
  index('idx_meetings_scheduled').on(t.scheduledAt),
  index('idx_meetings_status').on(t.status),
]);

// ------------------------------------------------------------------
// Bookings / Cancellations / Payments / Refunds / Expenses
// ------------------------------------------------------------------
export const bookings = pgTable('bookings', {
  id: id(),
  bookingNo: text('booking_no').notNull().unique(),
  customerId: text('customer_id').notNull().references(() => customers.id),
  leadId: text('lead_id').references(() => leads.id),
  projectId: text('project_id').references(() => projects.id),
  towerId: text('tower_id').references(() => towers.id),
  unitId: text('unit_id').references(() => units.id),
  saleValue: money('sale_value').notNull(),
  bookingAmount: money('booking_amount').notNull().default('0'),
  paymentDetails: jsonb('payment_details').$type<Record<string, unknown>>().default({}),
  salespersonId: text('salesperson_id').references(() => users.id),
  teamLeaderId: text('team_leader_id').references(() => users.id),
  brokerId: text('broker_id').references(() => users.id),
  brokerName: text('broker_name'),
  bookingDate: timestamp('booking_date', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('CONFIRMED'),
  cancellationId: text('cancellation_id'),
  notes: text('notes'),
  meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
  createdById: text('created_by_id').references(() => users.id),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_bookings_customer').on(t.customerId),
  index('idx_bookings_project').on(t.projectId),
  index('idx_bookings_unit').on(t.unitId),
  index('idx_bookings_salesperson').on(t.salespersonId),
  index('idx_bookings_status').on(t.status),
]);

export const cancellations = pgTable('cancellations', {
  id: id(),
  bookingId: text('booking_id').notNull().references(() => bookings.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
  reasonCategory: text('reason_category').default('OTHER'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }).notNull(),
  refundAmount: money('refund_amount').default('0'),
  refundStatus: text('refund_status').notNull().default('PENDING'),
  approvalStatus: text('approval_status').notNull().default('PENDING'), // PENDING | APPROVED | REJECTED
  approvedById: text('approved_by_id').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  inventoryProcessed: boolean('inventory_processed').notNull().default(false),
  commissionProcessed: boolean('commission_processed').notNull().default(false),
  notes: text('notes'),
  meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
  createdById: text('created_by_id').references(() => users.id),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_cancellations_booking').on(t.bookingId),
  index('idx_cancellations_status').on(t.approvalStatus),
]);

export const payments = pgTable('payments', {
  id: id(),
  bookingId: text('booking_id').notNull().references(() => bookings.id, { onDelete: 'cascade' }),
  customerId: text('customer_id').references(() => customers.id),
  amount: money('amount').notNull(),
  paymentDate: timestamp('payment_date', { withTimezone: true }).notNull(),
  method: text('method').notNull().default('BANK_TRANSFER'),
  reference: text('reference'),
  status: text('status').notNull().default('RECEIVED'), // RECEIVED | BOUNCED | REVERSED
  // Receipts are issued lazily, one per payment, and can be voided without
  // touching the money row - a reprint must never double-count collection.
  receiptNo: text('receipt_no'),
  receiptIssuedAt: timestamp('receipt_issued_at', { withTimezone: true }),
  receiptVoidedAt: timestamp('receipt_voided_at', { withTimezone: true }),
  receiptVoidReason: text('receipt_void_reason'),
  notes: text('notes'),
  receivedById: text('received_by_id').references(() => users.id),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_payments_booking').on(t.bookingId),
  index('idx_payments_customer').on(t.customerId),
]);

export const paymentDue = pgTable('payment_due', {
  id: id(),
  leadId: text('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  customerId: text('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  bookingId: text('booking_id').references(() => bookings.id, { onDelete: 'set null' }),
  amount: money('amount').notNull(),
  dueDate: timestamp('due_date', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('PENDING'), // PENDING | PARTIAL | PAID | CANCELLED
  paidAt: timestamp('paid_at', { withTimezone: true }),
  paymentId: text('payment_id').references(() => payments.id, { onDelete: 'set null' }),
  paidAmount: money('paid_amount'),
  notes: text('notes'),
  createdById: text('created_by_id').references(() => users.id),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_payment_due_status').on(t.status, t.dueDate),
  index('idx_payment_due_customer').on(t.customerId),
  index('idx_payment_due_lead').on(t.leadId),
  index('idx_payment_due_booking').on(t.bookingId),
]);

export const refunds = pgTable('refunds', {
  id: id(),
  cancellationId: text('cancellation_id').references(() => cancellations.id, { onDelete: 'cascade' }),
  bookingId: text('booking_id').references(() => bookings.id),
  amount: money('amount').notNull(),
  date: timestamp('date', { withTimezone: true }).notNull(),
  method: text('method'),
  reference: text('reference'),
  status: text('status').notNull().default('PENDING'),
  notes: text('notes'),
  createdById: text('created_by_id').references(() => users.id),
  createdAt: now(),
}, (t) => [
  index('idx_refunds_cancellation').on(t.cancellationId),
]);

export const expenses = pgTable('expenses', {
  id: id(),
  category: text('category').notNull().default('OTHER'),
  amount: money('amount').notNull(),
  date: timestamp('date', { withTimezone: true }).notNull(),
  description: text('description'),
  projectId: text('project_id').references(() => projects.id),
  createdById: text('created_by_id').references(() => users.id),
  createdAt: now(),
});

// ------------------------------------------------------------------
// Documents (metadata only; files live in R2 / local disk)
// ------------------------------------------------------------------
export const documents = pgTable('documents', {
  id: id(),
  customerId: text('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
  bookingId: text('booking_id').references(() => bookings.id, { onDelete: 'set null' }),
  leadId: text('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  documentType: text('document_type').notNull(),
  title: text('title'),
  fileName: text('file_name').notNull(),
  r2Key: text('r2_key').notNull().unique(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull().default(0),
  sha256: text('sha256'),
  verificationStatus: text('verification_status').notNull().default('PENDING'),
  verificationNote: text('verification_note'),
  uploadedById: text('uploaded_by_id').references(() => users.id),
  verifiedById: text('verified_by_id').references(() => users.id),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_documents_customer').on(t.customerId),
  index('idx_documents_booking').on(t.bookingId),
  index('idx_documents_type').on(t.documentType),
  index('idx_documents_status').on(t.verificationStatus),
]);

// ------------------------------------------------------------------
// Commission engine
// ------------------------------------------------------------------
export const commissionRules = pgTable('commission_rules', {
  id: id(),
  name: text('name').notNull(),
  type: text('type').notNull().default('PERCENTAGE'),
  payableTo: text('payable_to').notNull().default('SALES_EXECUTIVE'), // role / BROKER / OTHER
  personId: text('person_id').references(() => users.id),
  projectId: text('project_id').references(() => projects.id),
  brokerName: text('broker_name'),
  rate: numeric('rate', { precision: 8, scale: 4 }),
  fixedAmount: money('fixed_amount'),
  slabConfig: jsonb('slab_config').$type<Array<{ max: number; rate: number; fixed?: number }>>().default([]),
  collectionWindowDays: integer('collection_window_days'), // for collection-based
  isActive: boolean('is_active').notNull().default(true),
  version: integer('version').notNull().default(1),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  effectiveTo: timestamp('effective_to', { withTimezone: true }),
  notes: text('notes'),
  createdById: text('created_by_id').references(() => users.id),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_ci_person').on(t.personId),
  index('idx_ci_project').on(t.projectId),
  index('idx_ci_active').on(t.isActive),
]);

// Immutable per-booking commission entitlements
export const commissionSnapshots = pgTable('commission_snapshots', {
  id: id(),
  bookingId: text('booking_id').notNull().references(() => bookings.id, { onDelete: 'cascade' }),
  ruleId: text('rule_id'),
  ruleVersion: integer('rule_version'),
  ruleName: text('rule_name'),
  personId: text('person_id').references(() => users.id),
  personRole: text('person_role'),
  personName: text('person_name'),
  basis: text('basis').notNull().default('SALE_VALUE'), // SALE_VALUE | COLLECTION
  baseAmount: money('base_amount'),
  rate: numeric('rate', { precision: 8, scale: 4 }),
  amount: money('amount').notNull(),
  status: text('status').notNull().default('PENDING'),
  payableOn: timestamp('payable_on', { withTimezone: true }),
  notes: text('notes'),
  meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_csnap_booking').on(t.bookingId),
  index('idx_csnap_person').on(t.personId),
  index('idx_csnap_status').on(t.status),
]);

export const commissionAdjustments = pgTable('commission_adjustments', {
  id: id(),
  snapshotId: text('snapshot_id').notNull().references(() => commissionSnapshots.id, { onDelete: 'cascade' }),
  amount: money('amount').notNull(), // signed
  type: text('type').notNull().default('ADJUSTMENT'), // ADJUSTMENT | DEDUCTION | REVERSAL
  reason: text('reason').notNull(),
  status: text('status').notNull().default('PENDING'),
  approvedById: text('approved_by_id').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdById: text('created_by_id').references(() => users.id),
  createdAt: now(),
});

export const commissionLedger = pgTable('commission_ledger', {
  id: id(),
  personId: text('person_id').references(() => users.id),
  snapshotId: text('snapshot_id').references(() => commissionSnapshots.id),
  bookingId: text('booking_id').references(() => bookings.id),
  credit: money('credit').notNull().default('0'),
  debit: money('debit').notNull().default('0'),
  runningBalance: money('running_balance').notNull().default('0'),
  sourceType: text('source_type').notNull(),
  sourceId: text('source_id'),
  notes: text('notes'),
  createdById: text('created_by_id').references(() => users.id),
  createdAt: now(),
}, (t) => [
  index('idx_ledger_person').on(t.personId),
]);

export const payoutBatches = pgTable('payout_batches', {
  id: id(),
  batchNo: text('batch_no').notNull().unique(),
  status: text('status').notNull().default('DRAFT'),
  periodFrom: timestamp('period_from', { withTimezone: true }),
  periodTo: timestamp('period_to', { withTimezone: true }),
  totalAmount: money('total_amount').notNull().default('0'),
  approvedById: text('approved_by_id').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  createdById: text('created_by_id').references(() => users.id),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const payoutTransactions = pgTable('payout_transactions', {
  id: id(),
  batchId: text('batch_id').notNull().references(() => payoutBatches.id, { onDelete: 'cascade' }),
  snapshotId: text('snapshot_id').references(() => commissionSnapshots.id),
  personId: text('person_id').references(() => users.id),
  amount: money('amount').notNull(),
  status: text('status').notNull().default('PENDING'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  notes: text('notes'),
  createdById: text('created_by_id').references(() => users.id),
  createdAt: now(),
}, (t) => [
  index('idx_payout_tx_batch').on(t.batchId),
  index('idx_payout_tx_person').on(t.personId),
]);

// ------------------------------------------------------------------
// Notifications / Automation / Integrations / Jobs / Audit
// ------------------------------------------------------------------
export const notifications = pgTable('notifications', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull().default('SYSTEM'),
  title: text('title').notNull(),
  body: text('body'),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  readAt: timestamp('read_at', { withTimezone: true }),
  meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
  createdAt: now(),
}, (t) => [
  index('idx_notifications_user').on(t.userId),
  index('idx_notifications_user_read').on(t.userId, t.readAt),
]);

export const automationRules = pgTable('automation_rules', {
  id: id(),
  name: text('name').notNull(),
  trigger: text('trigger').notNull(),
  actions: jsonb('actions').$type<Array<Record<string, unknown>>>().notNull().default([]),
  config: jsonb('config').$type<Record<string, unknown>>().default({}),
  isActive: boolean('is_active').notNull().default(true),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  createdById: text('created_by_id').references(() => users.id),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const integrations = pgTable('integrations', {
  id: id(),
  provider: text('provider').notNull().unique(),
  label: text('label').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().default({}),
  webhookSecret: text('webhook_secret'),
  isActive: boolean('is_active').notNull().default(false),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const auditLogs = pgTable('audit_logs', {
  id: id(),
  userId: text('user_id'),
  userEmail: text('user_email'),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id'),
  oldValue: jsonb('old_value').$type<unknown>(),
  newValue: jsonb('new_value').$type<unknown>(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  requestPath: text('request_path'),
  requestMethod: text('request_method'),
  meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_audit_entity').on(t.entity, t.entityId),
  index('idx_audit_action').on(t.action),
  index('idx_audit_created').on(t.createdAt),
  index('idx_audit_user').on(t.userId),
]);

export const backgroundJobs = pgTable('background_jobs', {
  id: id(),
  type: text('type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').notNull().default('PENDING'), // PENDING | PROCESSING | DONE | FAILED
  priority: integer('priority').notNull().default(5),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  runAt: timestamp('run_at', { withTimezone: true }).defaultNow().notNull(),
  lastError: text('last_error'),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  digestKey: text('digest_key'),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_jobs_status').on(t.status, t.runAt),
  uniqueIndex('idx_jobs_digest_key').on(t.digestKey),
]);

/**
 * Outbound message history: every email and WhatsApp message the app sends,
 * one row per delivery attempt. `status` = SENT | FAILED; on a failure the
 * queue retries the job, so a lead can legitimately have several FAILED rows
 * followed by one SENT. Kept separate from `background_jobs` (which only
 * stores the queued payload) so staff can see who was told what, when, and
 * whether it actually went out. `leadId` links the row back to the lead that
 * triggered the send, `userId` to the team member it was addressed to.
 */
export const messageLogs = pgTable('message_logs', {
  id: id(),
  channel: text('channel').notNull(), // EMAIL | WHATSAPP
  recipient: text('recipient').notNull(), // email address or E.164 phone
  subject: text('subject'),
  bodyText: text('body_text'),
  status: text('status').notNull(), // SENT | FAILED
  providerMessageId: text('provider_message_id'),
  leadId: text('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  error: text('error'),
  createdAt: now(),
}, (t) => [
  index('idx_message_logs_channel_created').on(t.channel, t.createdAt),
  index('idx_message_logs_lead').on(t.leadId),
  index('idx_message_logs_recipient').on(t.recipient),
]);

// Simple key/value counter used to mint sequential business numbers.
export const counters = pgTable('counters', {
  key: text('key').primaryKey(),
  value: integer('value').notNull().default(0),
});

// Application settings (round-robin pointer, assignment config, brand, etc.)
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ------------------------------------------------------------------
// AI assistant
// ------------------------------------------------------------------

/** One chat thread. Strictly owned by a single user - never shared. */
export const assistantConversations = pgTable(
  'assistant_conversations',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('New chat'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('assistant_conversations_user_idx').on(t.userId, t.updatedAt),
  }),
);

/** A single turn. `pendingActions` holds proposed writes awaiting confirmation. */
export const assistantMessages = pgTable(
  'assistant_messages',
  {
    id: id(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => assistantConversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull().default(''),
    /** Tool calls the model requested this turn, kept for transcript only. */
    toolCalls: jsonb('tool_calls').$type<unknown[]>(),
    /** Proposed writes, shown as confirm cards. Cleared once applied/discarded. */
    pendingActions: jsonb('pending_actions').$type<unknown[]>(),
    model: text('model'),
    createdAt: now(),
  },
  (t) => ({
    convIdx: index('assistant_messages_conversation_idx').on(t.conversationId, t.createdAt),
  }),
);

// ------------------------------------------------------------------
// Sales targets & forecast
// ------------------------------------------------------------------

/**
 * One target row per salesperson per month. Metrics are nullable columns
 * rather than separate rows so a manager can set "1.2 Cr booking value and 20
 * leads" for the same person in one edit, and so an unset metric is visibly
 * unset instead of silently zero.
 */
export const salesTargets = pgTable(
  'sales_targets',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Calendar month in `YYYY-MM` form, matching analytics.monthKey. */
    period: text('period').notNull(),
    /** Null = all projects combined. */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    bookingValueTarget: money('booking_value_target'),
    collectionTarget: money('collection_target'),
    leadCountTarget: integer('lead_count_target'),
    bookingCountTarget: integer('booking_count_target'),
    notes: text('notes'),
    setById: text('set_by_id').references(() => users.id),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One target per (person, month, project). Postgres treats NULLs as
    // distinct, so the all-projects row needs a partial index of its own.
    uniqueIndex('uq_targets_person_period_project').on(t.userId, t.period, t.projectId),
    index('idx_targets_period').on(t.period),
    uniqueIndex('uq_targets_person_period_all')
      .on(t.userId, t.period)
      .where(sql`${t.projectId} is null`),
  ],
);

// ------------------------------------------------------------------
// Collection: milestone schedule
// ------------------------------------------------------------------

/**
 * The agreed instalment plan for a booking. A real-estate booking is not one
 * payment - it is booking amount, down payment, construction-linked
 * instalments, then possession. Tracking only "payments received" hides every
 * overdue instalment, which is the number the accounts team actually works
 * from.
 *
 * `amount` is derived (saleValue x percentage) but stored, so a later price
 * revision never silently rewrites history.
 */
export const paymentMilestones = pgTable(
  'payment_milestones',
  {
    id: id(),
    bookingId: text('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    /** 1-based position in the plan; also the display order. */
    seq: integer('seq').notNull(),
    name: text('name').notNull(),
    dueDate: timestamp('due_date', { withTimezone: true }).notNull(),
    percentage: numeric('percentage', { precision: 6, scale: 3 }),
    amount: money('amount').notNull(),
    status: text('status').notNull().default('PENDING'), // PENDING | PARTIAL | PAID | WAIVED
    paidAmount: money('paid_amount').notNull().default('0'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    notes: text('notes'),
    meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
    createdById: text('created_by_id').references(() => users.id),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('uq_milestone_booking_seq').on(t.bookingId, t.seq),
    index('idx_milestones_booking').on(t.bookingId),
    index('idx_milestones_due').on(t.dueDate),
    index('idx_milestones_status').on(t.status),
  ],
);

// ------------------------------------------------------------------
// Home loan / financing
// ------------------------------------------------------------------

/**
 * Financing attached to a booking. Most Indian buyers pay through a mortgage,
 * so the sale is not complete until the loan is disbursed - but nothing between
 * "application filed" and "cheque to the builder" used to be visible anywhere.
 *
 * Loan documents are not duplicated here: `documents` already supports
 * LOAN_DOCUMENT / BANK_DOCUMENT against a bookingId.
 */
export const loans = pgTable(
  'loans',
  {
    id: id(),
    bookingId: text('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** Co-applicant / spouse / sibling, for joint mortgages. */
    applicantName: text('applicant_name'),
    applicantRelation: text('applicant_relation'),
    bankName: text('bank_name'),
    applicationNo: text('application_no'),
    loanType: text('loan_type').notNull().default('HOME'), // HOME | PLOT | BALLOON | BRIDGE
    loanAmount: money('loan_amount').notNull().default('0'),
    marginAmount: money('margin_amount'),
    propertyValuation: money('property_valuation'),
    interestRate: numeric('interest_rate', { precision: 5, scale: 3 }),
    tenureMonths: integer('tenure_months'),
    emi: money('emi'),
    status: text('status').notNull().default('APPLIED'),
    applicationDate: timestamp('application_date', { withTimezone: true }).notNull(),
    sanctionDate: timestamp('sanction_date', { withTimezone: true }),
    /** Lender releases money against construction milestones. */
    disbursementDate: timestamp('disbursement_date', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    remarks: text('remarks'),
    meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
    createdById: text('created_by_id').references(() => users.id),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_loans_booking').on(t.bookingId),
    index('idx_loans_customer').on(t.customerId),
    index('idx_loans_status').on(t.status),
    index('idx_loans_bank').on(t.bankName),
    index('idx_loans_applied').on(t.applicationDate),
  ],
);

// ------------------------------------------------------------------
// Relations
// ------------------------------------------------------------------

export const usersRelations = relations(users, ({ one, many }) => ({
  manager: one(users, { fields: [users.managerId], references: [users.id], relationName: 'manager' }),
  reports: many(users, { relationName: 'manager' }),
  leads: many(leads),
  sessions: many(sessions),
  assistantConversations: many(assistantConversations),
}));

export const assistantConversationsRelations = relations(assistantConversations, ({ one, many }) => ({
  user: one(users, { fields: [assistantConversations.userId], references: [users.id] }),
  messages: many(assistantMessages),
}));

export const assistantMessagesRelations = relations(assistantMessages, ({ one }) => ({
  conversation: one(assistantConversations, {
    fields: [assistantMessages.conversationId],
    references: [assistantConversations.id],
  }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const projectsRelations = relations(projects, ({ many }) => ({
  towers: many(towers),
  units: many(units),
}));

export const towersRelations = relations(towers, ({ one, many }) => ({
  project: one(projects, { fields: [towers.projectId], references: [projects.id] }),
  units: many(units),
}));

export const unitsRelations = relations(units, ({ one }) => ({
  project: one(projects, { fields: [units.projectId], references: [projects.id] }),
  tower: one(towers, { fields: [units.towerId], references: [towers.id] }),
  booking: one(bookings, { fields: [units.bookingId], references: [bookings.id] }),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  lead: one(leads, { fields: [customers.leadId], references: [leads.id] }),
  owner: one(users, { fields: [customers.ownerId], references: [users.id] }),
  bookings: many(bookings),
  documents: many(documents),
  salesTargets: many(salesTargets),
  loans: many(loans),
  activities: many(customerActivities),
}));

export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  customer: one(customers, { fields: [bookings.customerId], references: [customers.id] }),
  lead: one(leads, { fields: [bookings.leadId], references: [leads.id] }),
  project: one(projects, { fields: [bookings.projectId], references: [projects.id] }),
  tower: one(towers, { fields: [bookings.towerId], references: [towers.id] }),
  unit: one(units, { fields: [bookings.unitId], references: [units.id] }),
  salesperson: one(users, { fields: [bookings.salespersonId], references: [users.id] }),
  payments: many(payments),
  cancellations: many(cancellations),
  commissionSnapshots: many(commissionSnapshots),
  milestones: many(paymentMilestones),
  loans: many(loans),
}));

export const paymentMilestonesRelations = relations(paymentMilestones, ({ one }) => ({
  booking: one(bookings, { fields: [paymentMilestones.bookingId], references: [bookings.id] }),
}));

export const loansRelations = relations(loans, ({ one }) => ({
  booking: one(bookings, { fields: [loans.bookingId], references: [bookings.id] }),
  customer: one(customers, { fields: [loans.customerId], references: [customers.id] }),
}));

export const salesTargetsRelations = relations(salesTargets, ({ one }) => ({
  user: one(users, { fields: [salesTargets.userId], references: [users.id], relationName: 'targetOwner' }),
  project: one(projects, { fields: [salesTargets.projectId], references: [projects.id] }),
  setBy: one(users, { fields: [salesTargets.setById], references: [users.id] }),
}));

export const cancellationsRelations = relations(cancellations, ({ one, many }) => ({
  booking: one(bookings, { fields: [cancellations.bookingId], references: [bookings.id] }),
  refunds: many(refunds),
}));

export const documentsRelations = relations(documents, ({ one }) => ({
  customer: one(customers, { fields: [documents.customerId], references: [customers.id] }),
  booking: one(bookings, { fields: [documents.bookingId], references: [bookings.id] }),
  uploader: one(users, { fields: [documents.uploadedById], references: [users.id] }),
}));

export const commissionSnapshotsRelations = relations(commissionSnapshots, ({ one }) => ({
  booking: one(bookings, { fields: [commissionSnapshots.bookingId], references: [bookings.id] }),
  person: one(users, { fields: [commissionSnapshots.personId], references: [users.id] }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  booking: one(bookings, { fields: [payments.bookingId], references: [bookings.id] }),
  customer: one(customers, { fields: [payments.customerId], references: [customers.id] }),
  receivedBy: one(users, { fields: [payments.receivedById], references: [users.id] }),
}));

export const payoutTransactionsRelations = relations(payoutTransactions, ({ one }) => ({
  batch: one(payoutBatches, { fields: [payoutTransactions.batchId], references: [payoutBatches.id] }),
  snapshot: one(commissionSnapshots, { fields: [payoutTransactions.snapshotId], references: [commissionSnapshots.id] }),
}));

export const meetingsRelations = relations(meetings, ({ one }) => ({
  lead: one(leads, { fields: [meetings.leadId], references: [leads.id] }),
  customer: one(customers, { fields: [meetings.customerId], references: [customers.id] }),
  project: one(projects, { fields: [meetings.projectId], references: [projects.id] }),
  assignee: one(users, { fields: [meetings.assignedTo], references: [users.id] }),
}));

export const leadActivitiesRelations = relations(leadActivities, ({ one }) => ({
  lead: one(leads, { fields: [leadActivities.leadId], references: [leads.id] }),
}));

export const leadStatusHistoryRelations = relations(leadStatusHistory, ({ one }) => ({
  lead: one(leads, { fields: [leadStatusHistory.leadId], references: [leads.id] }),
}));

export const customerActivitiesRelations = relations(customerActivities, ({ one }) => ({
  customer: one(customers, { fields: [customerActivities.customerId], references: [customers.id] }),
}));

export const refundsRelations = relations(refunds, ({ one }) => ({
  cancellation: one(cancellations, { fields: [refunds.cancellationId], references: [cancellations.id] }),
  booking: one(bookings, { fields: [refunds.bookingId], references: [bookings.id] }),
  createdBy: one(users, { fields: [refunds.createdById], references: [users.id] }),
}));

// Referential integrity guard on bookings<->units link column
export type Lead = typeof leads.$inferSelect;
export type LeadInsert = typeof leads.$inferInsert;
export type User = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type Tower = typeof towers.$inferSelect;
export type Unit = typeof units.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type CustomerInsert = typeof customers.$inferInsert;
export type CustomerActivity = typeof customerActivities.$inferSelect;
export type CustomerActivityInsert = typeof customerActivities.$inferInsert;
export type Booking = typeof bookings.$inferSelect;
export type BookingInsert = typeof bookings.$inferInsert;
export type Cancellation = typeof cancellations.$inferSelect;
export type Followup = typeof followups.$inferSelect;
export type Meeting = typeof meetings.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type CommissionSnapshot = typeof commissionSnapshots.$inferSelect;
export type CommissionRule = typeof commissionRules.$inferSelect;
export type PayoutBatch = typeof payoutBatches.$inferSelect;
export type PayoutTx = typeof payoutTransactions.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type LeadActivity = typeof leadActivities.$inferSelect;
export type IncomingLead = typeof incomingLeads.$inferSelect;
export type AssistantConversation = typeof assistantConversations.$inferSelect;
export type AssistantMessage = typeof assistantMessages.$inferSelect;
export type SalesTarget = typeof salesTargets.$inferSelect;
export type PaymentMilestone = typeof paymentMilestones.$inferSelect;
export type Loan = typeof loans.$inferSelect;
