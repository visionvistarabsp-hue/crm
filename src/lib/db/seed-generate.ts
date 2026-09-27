/**
 * Pure dataset builder for the demo environment.
 *
 * Nothing here touches the database — `generateDataset()` returns plain row
 * arrays which `seed.ts` then inserts in foreign-key-safe order. Keeping the
 * generation pure means the shape of the demo data can be reasoned about (and
 * asserted in tests) without a live connection.
 *
 * Every row gets a client-side UUID so the whole dataset can be linked with
 * zero read-back round trips, and every date is relative to "now" so the
 * dataset always has work due today no matter which day the demo runs.
 */
import {
  Clock,
  Rng,
  PROJECTS,
  TEAM,
  FUNNEL,
  PIPELINE_ORDER,
  CAMPAIGNS,
  REQUIREMENTS,
  OBJECTIONS,
  NOTES,
  TAG_POOL,
  OPENING_MESSAGE,
  FOLLOWUP_NOTES,
  VISIT_FEEDBACK,
  LOCALITIES,
  makePersonName,
  makePan,
  SOURCES,
  AI_SUMMARY_SEED,
} from './demo-data';
import { pad } from '../utils';

const uid = () => globalThis.crypto.randomUUID();

/**
 * Business numbers deliberately reuse the exact format the app mints at
 * runtime (`services/counters.ts`), so a record created during a demo
 * continues the sequence instead of colliding with a different scheme.
 */
const NO = {
  lead: (n: number) => `LD-${pad(n, 4)}`,
  customer: (n: number) => `CU-${pad(n, 4)}`,
  booking: (n: number) => `BK-${pad(n, 4)}`,
  payout: (n: number) => `PO-${pad(n, 4)}`,
};

/** Funnel weights are relative; this scales them to ~200 leads. */
const LEAD_SCALE = 1.4;

/** How old (in days) a lead at each stage tends to be. */
const STAGE_AGE: Record<string, [number, number]> = {
  NEW: [0, 5],
  CONTACT_PENDING: [0, 10],
  CONTACTED: [1, 20],
  QUALIFIED: [3, 35],
  FOLLOW_UP: [5, 60],
  MEETING: [5, 70],
  SITE_VISIT_1: [10, 80],
  SITE_VISIT_2: [15, 95],
  SITE_VISIT_3: [20, 110],
  NEGOTIATION: [25, 130],
  BOOKING: [30, 140],
  DOCUMENT_COLLECTION: [35, 150],
  DEAL_COMPLETED: [45, 170],
  NOT_INTERESTED: [10, 120],
  CALL_BACK_LATER: [10, 90],
  LOST: [15, 140],
  WRONG_NUMBER: [1, 45],
};

/** Deep-funnel leads are the ones worth calling today. */
const STAGE_PRIORITY: Record<string, Array<[string, number]>> = {
  NEW: [['LOW', 3], ['MEDIUM', 5], ['HIGH', 2]],
  CONTACT_PENDING: [['MEDIUM', 4], ['HIGH', 4], ['URGENT', 2]],
  CONTACTED: [['MEDIUM', 5], ['HIGH', 4], ['URGENT', 1]],
  QUALIFIED: [['MEDIUM', 3], ['HIGH', 5], ['URGENT', 2]],
  FOLLOW_UP: [['MEDIUM', 2], ['HIGH', 5], ['URGENT', 3]],
  MEETING: [['MEDIUM', 2], ['HIGH', 5], ['URGENT', 3]],
  SITE_VISIT_1: [['HIGH', 4], ['URGENT', 4], ['MEDIUM', 2]],
  SITE_VISIT_2: [['HIGH', 3], ['URGENT', 5], ['MEDIUM', 2]],
  SITE_VISIT_3: [['HIGH', 2], ['URGENT', 6], ['MEDIUM', 2]],
  NEGOTIATION: [['HIGH', 2], ['URGENT', 7], ['MEDIUM', 1]],
  BOOKING: [['HIGH', 1], ['URGENT', 8], ['MEDIUM', 1]],
  DOCUMENT_COLLECTION: [['HIGH', 2], ['URGENT', 7], ['MEDIUM', 1]],
  DEAL_COMPLETED: [['MEDIUM', 6], ['LOW', 4]],
  NOT_INTERESTED: [['LOW', 7], ['MEDIUM', 3]],
  CALL_BACK_LATER: [['LOW', 4], ['MEDIUM', 5], ['HIGH', 1]],
  LOST: [['LOW', 5], ['MEDIUM', 5]],
  WRONG_NUMBER: [['LOW', 10]],
};

const PAYMENT_METHODS: Array<[string, number]> = [
  ['UPI', 26], ['BANK_TRANSFER', 24], ['NEFT', 18], ['RTGS', 14],
  ['CHEQUE', 8], ['CARD', 6], ['CASH', 4],
];

const CANCEL_REASONS: Array<[string, string]> = [
  ['Customer withdrew due to a change in financial plans', 'FINANCIAL'],
  ['Customer found a better deal in another project', 'BETTER_OFFER'],
  ['Bank loan sanction was rejected', 'LOAN_FAILED'],
  ['Customer relocated to another city', 'RELOCATION'],
  ['Customer is not happy with the selected unit', 'UNIT_CHOICE'],
  ['Delay in the possession timeline', 'PROJECT_DELAY'],
];

const DOC_TYPES = [
  'PAN', 'AADHAAR', 'BANK_DOCUMENT', 'LOAN_DOCUMENT', 'AGREEMENT', 'BOOKING_FORM', 'PAYMENT_RECEIPT', 'ADDRESS_PROOF',
] as const;

const UNIT_PROFILES: Record<string, Array<{ unitType: string; bhk: string; area: number; price: number }>> = {
  'PRJ-SKY2026': [
    { unitType: 'APARTMENT', bhk: '2', area: 1120, price: 72_00_000 },
    { unitType: 'APARTMENT', bhk: '2.5', area: 1310, price: 84_50_000 },
    { unitType: 'APARTMENT', bhk: '3', area: 1490, price: 98_00_000 },
    { unitType: 'APARTMENT', bhk: '3', area: 1640, price: 1_12_50_000 },
  ],
  'PRJ-GRV2025': [
    { unitType: 'APARTMENT', bhk: '2', area: 1210, price: 88_00_000 },
    { unitType: 'APARTMENT', bhk: '3', area: 1620, price: 1_18_00_000 },
    { unitType: 'APARTMENT', bhk: '3.5', area: 1880, price: 1_36_00_000 },
    { unitType: 'APARTMENT', bhk: '4', area: 2240, price: 1_62_00_000 },
  ],
  'PRJ-URB2024': [
    { unitType: 'APARTMENT', bhk: '3', area: 1780, price: 1_68_00_000 },
    { unitType: 'APARTMENT', bhk: '3.5', area: 2050, price: 1_95_00_000 },
    { unitType: 'PENTHOUSE', bhk: '4', area: 2650, price: 2_85_00_000 },
  ],
  'PRJ-MRN2026': [
    { unitType: 'VILLA', bhk: '4', area: 3250, price: 1_95_00_000 },
    { unitType: 'VILLA', bhk: '4', area: 3480, price: 2_15_00_000 },
    { unitType: 'VILLA', bhk: '4.5', area: 3820, price: 2_55_00_000 },
    { unitType: 'VILLA', bhk: '4', area: 4150, price: 3_10_00_000 },
  ],
  'PRJ-HRZ2026': [
    { unitType: 'COMMERCIAL', bhk: '2', area: 820, price: 48_00_000 },
    { unitType: 'COMMERCIAL', bhk: '2', area: 1180, price: 62_00_000 },
    { unitType: 'COMMERCIAL', bhk: '2.5', area: 1560, price: 78_00_000 },
    { unitType: 'COMMERCIAL', bhk: '3', area: 2040, price: 92_00_000 },
    { unitType: 'COMMERCIAL', bhk: '3', area: 2380, price: 1_02_00_000 },
  ],
};

const FACINGS = ['East', 'North-East', 'North', 'West', 'South-West', 'South', 'North-West', 'East'];

/** Tower names → short, project-unique codes used to build unit numbers. */
function towerCode(name: string): string {
  const parts = name.split(/\s+/);
  const last = parts[parts.length - 1];
  if (/^[A-Z]$/.test(last)) return last;
  if (/^\d+$/.test(last)) return `${parts[0][0]}${last}`;
  return parts.map((p) => p[0]).join('').toUpperCase();
}

export interface Dataset {
  users: Array<{
    id: string; name: string; email: string; passwordHash: string; role: string; phone: string;
    managerId: string | null; isActive: boolean; lastLoginAt: Date; createdAt: Date;
  }>;
  projects: Array<Record<string, unknown>>;
  towers: Array<Record<string, unknown>>;
  units: Array<Record<string, unknown>>;
  leads: Array<Record<string, unknown>>;
  leadActivities: Array<Record<string, unknown>>;
  leadStatusHistory: Array<Record<string, unknown>>;
  leadDuplicates: Array<Record<string, unknown>>;
  leadAssignments: Array<Record<string, unknown>>;
  incomingLeads: Array<Record<string, unknown>>;
  customers: Array<Record<string, unknown>>;
  followups: Array<Record<string, unknown>>;
  meetings: Array<Record<string, unknown>>;
  bookings: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  cancellations: Array<Record<string, unknown>>;
  refunds: Array<Record<string, unknown>>;
  expenses: Array<Record<string, unknown>>;
  documents: Array<Record<string, unknown>>;
  commissionRules: Array<Record<string, unknown>>;
  commissionSnapshots: Array<Record<string, unknown>>;
  commissionAdjustments: Array<Record<string, unknown>>;
  commissionLedger: Array<Record<string, unknown>>;
  payoutBatches: Array<Record<string, unknown>>;
  payoutTransactions: Array<Record<string, unknown>>;
  notifications: Array<Record<string, unknown>>;
  automationRules: Array<Record<string, unknown>>;
  integrations: Array<Record<string, unknown>>;
  auditLogs: Array<Record<string, unknown>>;
  backgroundJobs: Array<Record<string, unknown>>;
  counters: Array<{ key: string; value: number }>;
  settings: Array<{ key: string; value: unknown }>;
  stats: Record<string, number>;
}

export interface GenerateOptions {
  seed?: number;
  now?: Date;
  passwordHash: string;
}

export function generateDataset(opts: GenerateOptions): Dataset {
  const rng = new Rng(opts.seed ?? 20260215);
  const clock = new Clock(opts.now);
  const passwordHash = opts.passwordHash;

  const ds: Dataset = {
    users: [], projects: [], towers: [], units: [], leads: [], leadActivities: [],
    leadStatusHistory: [], leadDuplicates: [], leadAssignments: [], incomingLeads: [],
    customers: [], followups: [], meetings: [], bookings: [], payments: [],
    cancellations: [], refunds: [], expenses: [], documents: [], commissionRules: [],
    commissionSnapshots: [], commissionAdjustments: [], commissionLedger: [],
    payoutBatches: [], payoutTransactions: [], notifications: [], automationRules: [],
    integrations: [], auditLogs: [], backgroundJobs: [], counters: [], settings: [], stats: {},
  };

  // ---------------------------------------------------------------- users
  const userId = new Map<string, string>();
  for (const person of TEAM) {
    const id = uid();
    userId.set(person.key, id);
    ds.users.push({
      id,
      name: person.name,
      email: person.email,
      passwordHash,
      role: person.role,
      phone: person.phone,
      managerId: person.managerKey ? userId.get(person.managerKey)! : null,
      isActive: true,
      lastLoginAt: clock.daysAgo(rng.int(0, 3), rng),
      createdAt: clock.daysAgo(rng.int(120, 400), rng),
    });
  }
  const adminId = userId.get('aarav')!;
  const managerId = userId.get('priya')!;
  const accountsId = userId.get('kavita')!;
  const docsId = userId.get('nisha')!;
  const execIds = TEAM.filter((t) => t.role === 'SALES_EXECUTIVE').map((t) => userId.get(t.key)!);
  const tlIds = TEAM.filter((t) => t.role === 'TEAM_LEADER').map((t) => userId.get(t.key)!);
  const nameById = new Map(ds.users.map((u) => [u.id, u.name]));
  const emailById = new Map(ds.users.map((u) => [u.id, u.email]));

  /** Team leader who manages a given executive, for override attribution. */
  const tlForExec = new Map<string, string>();
  for (const person of TEAM) {
    if (person.role === 'SALES_EXECUTIVE' && person.managerKey) {
      tlForExec.set(userId.get(person.key)!, userId.get(person.managerKey)!);
    }
  }

  // ------------------------------------------------------------- projects
  const projectId = new Map<string, string>();
  const projectName = new Map<string, string>();
  for (const spec of PROJECTS) {
    const id = uid();
    projectId.set(spec.code, id);
    projectName.set(id, spec.name);
    const totalUnits = spec.towers.reduce((s, t) => s + t.floors * t.unitsPerFloor, 0);
    ds.projects.push({
      id,
      code: spec.code,
      name: spec.name,
      location: spec.location,
      city: spec.city,
      state: spec.state,
      reraNo: spec.reraNo,
      description: spec.description,
      status: spec.status,
      priceRangeMin: String(spec.priceMin),
      priceRangeMax: String(spec.priceMax),
      amenities: spec.amenities,
      images: [],
      metadata: {
        totalUnits,
        configurations: [...new Set(UNIT_PROFILES[spec.code].map((p) => `${p.bhk} BHK`))],
        possessionDate: spec.code === 'PRJ-URB2024' ? 'Ready to move' : 'March 2027',
        openArea: rng.int(48, 78),
        launchDate: clock.daysAgo(rng.int(200, 420), rng).toISOString().slice(0, 10),
      },
      createdAt: clock.daysAgo(rng.int(240, 500), rng),
    });
  }

  // ------------------------------------------------- towers + unit inventory
  interface UnitRecord {
    id: string; projectId: string; towerId: string; unitNo: string; floor: number;
    unitType: string; bhk: string; areaSqft: string; facing: string; price: string;
    status: string; bookingId: string | null; customerId: string | null;
    holdUntil: null; createdAt: Date;
  }
  const inventory: UnitRecord[] = [];
  const towerProject = new Map<string, string>();
  const towerLabel = new Map<string, string>();

  for (const spec of PROJECTS) {
    const pid = projectId.get(spec.code)!;
    for (const t of spec.towers) {
      const tid = uid();
      towerProject.set(tid, pid);
      towerLabel.set(tid, t.name);
      ds.towers.push({
        id: tid,
        projectId: pid,
        name: t.name,
        floors: t.floors,
        unitsPerFloor: t.unitsPerFloor,
        status: t.status ?? 'ACTIVE',
        createdAt: clock.daysAgo(rng.int(200, 400), rng),
      });

      const code = towerCode(t.name);
      const profile = UNIT_PROFILES[spec.code];
      for (let floor = 1; floor <= t.floors; floor++) {
        for (let u = 0; u < t.unitsPerFloor; u++) {
          const p = profile[u % profile.length];
          // Higher floors and larger homes carry a premium; keep it inside the
          // project's advertised range so the inventory page stays coherent.
          const floorPremium = 1 + (floor / Math.max(t.floors, 1)) * 0.16;
          const price = Math.round((p.price * floorPremium) / 10_000) * 10_000;
          const area = Math.round(p.area * (1 + (floor / Math.max(t.floors, 1)) * 0.04));
          inventory.push({
            id: uid(),
            projectId: pid,
            towerId: tid,
            unitNo: `${code}-${String(floor).padStart(2, '0')}${String.fromCharCode(65 + u)}`,
            floor,
            unitType: p.unitType,
            bhk: p.bhk,
            areaSqft: String(area),
            facing: FACINGS[(floor + u * 3) % FACINGS.length],
            price: String(price),
            status: 'AVAILABLE',
            bookingId: null,
            customerId: null,
            holdUntil: null,
            createdAt: clock.daysAgo(rng.int(150, 400), rng),
          });
        }
      }
    }
  }
  // `ds.units` aliases the live inventory array (not a copy) so the booking,
  // cancellation and hold passes below mutate the rows that actually get
  // inserted. A copy here silently drops every status change.
  ds.units = inventory as unknown as Array<Record<string, unknown>>;

  const availableByProject = new Map<string, UnitRecord[]>();
  for (const u of inventory) {
    const list = availableByProject.get(u.projectId) ?? [];
    list.push(u);
    availableByProject.set(u.projectId, list);
  }

  // ---------------------------------------------------------------- leads
  const activeProjects = PROJECTS.filter((p) => p.status === 'ACTIVE');
  const projectCodes = PROJECTS.map((p) => p.code);
  const projectByWeight: Array<[string, number]> = [
    ['PRJ-SKY2026', 34], ['PRJ-GRV2025', 26], ['PRJ-URB2024', 20],
    ['PRJ-MRN2026', 12], ['PRJ-HRZ2026', 8],
  ];

  interface LeadRecord {
    id: string; name: string; phone: string; email: string; source: string; status: string;
    priority: string; projectId: string | null; ownerId: string; ageDays: number; createdAt: Date;
    budget: string; hasCustomer: boolean; hasBooking: boolean; bookingStatus: string | null;
    leadNo: string; campaign: string | null;
  }
  const leadRecords: LeadRecord[] = [];
  let phoneSeq = 0;
  let leadSeq = 0;
  let custSeq = 0;
  let bookingSeq = 0;

  for (const stage of FUNNEL) {
    const count = Math.max(1, Math.round(stage.weight * LEAD_SCALE));
    const [ageMin, ageMax] = STAGE_AGE[stage.status];
    for (let i = 0; i < count; i++) {
      leadSeq++;
      const id = uid();
      phoneSeq++;
      const name = makePersonName(rng);
      // 10-digit Indian mobile, unique per lead so duplicate detection has
      // real signal: the tail advances by a prime step each sequence number.
      const phone = `+91 9${pad(20_000_000 + phoneSeq * 7_919, 9)}`;
      const source = rng.weighted(SOURCES);
      // Campaign is fixed here (not at emit time) so the lead row, its first
      // activity note and source attribution all name the same campaign.
      const campaign = rng.chance(0.7) ? rng.pick(CAMPAIGNS[source] ?? ['Not tagged']) : null;
      const picksProject = rng.chance(0.78);
      const code = picksProject ? rng.weighted(projectByWeight) : null;
      const spec = code ? PROJECTS.find((p) => p.code === code)! : rng.pick(activeProjects);
      const pid = picksProject ? projectId.get(code!)! : null;
      const ageDays = rng.int(ageMin, ageMax);
      const createdAt = clock.daysAgo(ageDays, rng);
      const budget = Math.round((rng.float(spec.priceMin, spec.priceMax) / 1_00_000) * 100) * 1_00_000;
      const ownerId = rng.pick(execIds);
      const status = stage.status;

      leadRecords.push({
        id, name, phone,
        email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}.${leadSeq}@example.com`,
        source, status,
        campaign,
        priority: rng.weighted(STAGE_PRIORITY[status] ?? [['MEDIUM', 1]]),
        projectId: pid,
        ownerId,
        ageDays, createdAt,
        budget: String(budget),
        hasCustomer: stage.winRate > 0 && rng.chance(stage.winRate),
        hasBooking: false,
        bookingStatus: null,
        leadNo: '',
      });
    }
  }

  // Leads at the very top of the funnel have nobody assigned yet — that is what
  // makes the "assign / round-robin" demo meaningful.
  for (const lead of leadRecords) {
    if (lead.status === 'NEW' && rng.chance(0.55)) lead.ownerId = '';
  }

  // Reassignments are resolved BEFORE any lead row is emitted, so `ownerId`,
  // the assignment history and every downstream attribution (customer, booking,
  // commission) all agree on one final owner.
  for (const [index, lead] of leadRecords.entries()) {
    lead.leadNo = NO.lead(index + 1);
    if (!lead.ownerId) continue;
    const at = lead.createdAt;
    ds.leadAssignments.push({
      id: uid(),
      leadId: lead.id,
      fromUserId: null,
      toUserId: lead.ownerId,
      rule: rng.chance(0.55) ? 'ROUND_ROBIN' : 'MANUAL',
      ruleDetail: rng.chance(0.5) ? 'East team round robin' : 'Assigned by the sales manager',
      assignedById: managerId,
      createdAt: new Date(at.getTime() + 600_000),
    });
    if (rng.chance(0.14)) {
      const nextOwner = rng.pick(execIds.filter((e) => e !== lead.ownerId));
      if (nextOwner) {
        ds.leadAssignments.push({
          id: uid(),
          leadId: lead.id,
          fromUserId: lead.ownerId,
          toUserId: nextOwner,
          rule: 'MANUAL',
          ruleDetail: 'Reassigned for better response time',
          assignedById: managerId,
          createdAt: new Date(at.getTime() + rng.int(1, 4) * 86_400_000),
        });
        lead.ownerId = nextOwner;
      }
    }
  }

  for (const lead of leadRecords) {
    const source = lead.source;
    ds.leads.push({
      id: lead.id,
      leadNo: lead.leadNo,
      name: lead.name,
      phone: lead.phone,
      whatsapp: rng.chance(0.82) ? lead.phone : null,
      email: lead.email,
      source,
      campaign: lead.campaign,
      adName: rng.chance(0.35) ? `${source.toLowerCase()}_lead_form_v2` : null,
      projectId: lead.projectId,
      budget: lead.budget,
      preferredLocation: rng.chance(0.6) ? rng.pick(LOCALITIES) : null,
      propertyType: rng.pick(['APARTMENT', 'APARTMENT', 'APARTMENT', 'VILLA', 'PLOT', 'COMMERCIAL', 'PENTHOUSE']),
      requirement: rng.pick(REQUIREMENTS),
      ownerId: lead.ownerId || null,
      assignedAt: lead.ownerId ? new Date(lead.createdAt.getTime() + 3_600_000) : null,
      priority: lead.priority,
      status: lead.status,
      tags: rng.sample(TAG_POOL, rng.int(1, 3)),
      isDuplicate: false,
      duplicateOfId: null,
      notes: rng.chance(0.75) ? `${rng.pick(NOTES)} ${rng.chance(0.5) ? rng.pick(OBJECTIONS) : ''}`.trim() : null,
      sourceRef: rng.chance(0.3) ? `ext_${rng.int(100000, 999999)}` : null,
      // Pre-seeded AI output for leads that already have a real conversation,
      // so the AI panels have something to render before an API key exists.
      // AI_SUMMARY_SEED is a list of options, so one is picked per lead -
      // storing the whole array would break the single-summary contract the
      // detail panel reads.
      metadata: PIPELINE_ORDER.indexOf(lead.status) >= PIPELINE_ORDER.indexOf('QUALIFIED') && rng.chance(0.55)
        ? {
            aiSummary: rng.pick(AI_SUMMARY_SEED),
            aiSummarySource: 'seed',
            aiScore: rng.int(35, 95),
          }
        : {},
      createdById: rng.chance(0.4) ? null : lead.ownerId || managerId,
      firstSeenAt: new Date(lead.createdAt.getTime() - rng.int(0, 3) * 86_400_000),
      createdAt: lead.createdAt,
    });
  }

  // ------------------------------------------- status history + activities
  for (const lead of leadRecords) {
    const isOpen = PIPELINE_ORDER.includes(lead.status);
    const chain = isOpen
      ? PIPELINE_ORDER.slice(0, PIPELINE_ORDER.indexOf(lead.status) + 1)
      : [...PIPELINE_ORDER.slice(0, rng.int(4, 9)), lead.status];

    let cursor = lead.createdAt.getTime();
    const span = Math.max(lead.ageDays, 1) * 86_400_000;
    for (let i = 0; i < chain.length; i++) {
      const to = chain[i];
      const at = new Date(cursor + (span / (chain.length + 1)) * (i + 1) * rng.float(0.6, 1.4));
      ds.leadStatusHistory.push({
        id: uid(),
        leadId: lead.id,
        fromStatus: i === 0 ? null : chain[i - 1],
        toStatus: to,
        reason: i === 0
          ? `Lead captured from ${lead.source.toLowerCase().replace(/_/g, ' ')}`
          : rng.pick([
              'Moved by sales executive', 'Progression after call', 'Qualified on budget',
              'Site visit completed', 'Documents submitted', 'Negotiation in progress',
              'No longer interested', 'Could not be contacted',
            ]),
        changedById: lead.ownerId || managerId,
        createdAt: at,
      });
    }

    // Activity feed — the first entry is the capture itself.
    const activityCount = rng.int(2, 6);
    ds.leadActivities.push({
      id: uid(),
      leadId: lead.id,
      type: rng.chance(0.6) ? 'IMPORT' : 'ASSIGN',
      note: lead.source === 'MANUAL'
        ? `Manually created by ${nameById.get(lead.ownerId || managerId)}`
        : `Captured from ${lead.source.toLowerCase().replace(/_/g, ' ')}${lead.campaign ? ` — ${lead.campaign}` : ''}`,
      meta: { source: lead.source, campaign: lead.campaign },
      performedById: lead.ownerId || null,
      createdAt: lead.createdAt,
    });
    for (let i = 1; i < activityCount; i++) {
      const type = rng.weighted([
        ['CALL', 22], ['WHATSAPP', 24], ['NOTE', 18], ['EMAIL', 8],
        ['STATUS_CHANGE', 12], ['SITE_VISIT', 6], ['FOLLOWUP_CREATED', 10],
      ] as Array<[string, number]>);
      ds.leadActivities.push({
        id: uid(),
        leadId: lead.id,
        type,
        note: type === 'STATUS_CHANGE'
          ? `Status moved to ${lead.status}`
          : type === 'WHATSAPP'
            ? rng.pick(OPENING_MESSAGE)
            : rng.pick(NOTES),
        meta: {},
        performedById: lead.ownerId || managerId,
        createdAt: new Date(lead.createdAt.getTime() + (span * i) / activityCount + rng.int(0, 3_600_000)),
      });
    }
  }

  // ------------------------------------------------------------- customers
  interface CustomerRecord {
    id: string; lead: LeadRecord; no: string; bookingId: string | null;
  }
  const customerRecords: CustomerRecord[] = [];

  for (const lead of leadRecords) {
    if (!lead.hasCustomer) continue;
    custSeq++;
    const id = uid();
    const no = NO.customer(custSeq);
    customerRecords.push({ id, lead, no, bookingId: null });
    ds.customers.push({
      id,
      customerNo: no,
      leadId: lead.id,
      name: lead.name,
      phone: lead.phone,
      whatsapp: lead.phone,
      email: lead.email,
      pan: makePan(rng),
      aadhaar: `${rng.int(2000, 9999)} ${rng.int(1000, 9999)} ${rng.int(1000, 9999)}`,
      address: `${rng.int(1, 240)}, ${rng.pick(LOCALITIES)}`,
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: String(rng.int(560001, 560103)),
      ownerId: lead.ownerId,
      tags: rng.sample(TAG_POOL, rng.int(1, 3)),
      notes: rng.pick(NOTES),
      createdAt: new Date(lead.createdAt.getTime() + 2 * 86_400_000),
    });
  }

  // -------------------------------------------------------------- bookings
  const BOOKING_STAGES: Array<[string, string]> = [
    ['NEGOTIATION', 'CONFIRMED'],
    ['BOOKING', 'CONFIRMED'],
    ['DOCUMENT_COLLECTION', 'DOCUMENT_COLLECTION'],
    ['DEAL_COMPLETED', 'COMPLETED'],
  ];
  const unitTaken = new Map<string, boolean>();

  for (const cust of customerRecords) {
    const stage = BOOKING_STAGES.find(([s]) => s === cust.lead.status);
    if (!stage) continue;
    if (!rng.chance(0.85)) continue;

    const pid = cust.lead.projectId ?? projectId.get('PRJ-SKY2026')!;
    const pool = (availableByProject.get(pid) ?? []).filter((u) => !unitTaken.get(u.id));
    if (!pool.length) continue;
    // Prefer a mid-to-high floor — matches how real bookings are distributed.
    const unit = pool.reduce((best, u) => (u.floor > best.floor ? u : best), pool[0]);
    unitTaken.set(unit.id, true);

    bookingSeq++;
    const id = uid();
    cust.bookingId = id;
    cust.lead.hasBooking = true;
    cust.lead.bookingStatus = stage[1];

    const saleValue = Math.round((Number(unit.price) * rng.float(0.94, 1.0)) / 1000) * 1000;
    const bookingAmount = Math.round((saleValue * rng.float(0.01, 0.05)) / 1000) * 1000;
    const bookedDaysAgo = Math.max(1, cust.lead.ageDays - rng.int(5, 20));
    const bookingDate = clock.daysAgo(bookedDaysAgo, rng);
    const hasBroker = rng.chance(0.3);
    const tlId = tlForExec.get(cust.lead.ownerId) ?? tlIds[0];

    ds.bookings.push({
      id,
      bookingNo: NO.booking(bookingSeq),
      customerId: cust.id,
      leadId: cust.lead.id,
      projectId: unit.projectId,
      towerId: unit.towerId,
      unitId: unit.id,
      saleValue: String(saleValue),
      bookingAmount: String(bookingAmount),
      paymentDetails: { method: rng.pick(PAYMENT_METHODS)[0], reference: `TXN${rng.int(100000, 999999)}` },
      salespersonId: cust.lead.ownerId,
      teamLeaderId: tlId,
      brokerId: null,
      brokerName: hasBroker ? `${rng.pick(['Sunshine', 'Prime', 'Elite', 'Metro', 'Nova'])} Realty` : null,
      bookingDate,
      status: stage[1],
      cancellationId: null,
      notes: rng.pick([
        'Booked after two site visits. Negotiation on price settled at a 4% discount.',
        'Customer insisted on an east-facing unit on a higher floor.',
        'Broker-assisted booking with a 1.5% referral fee agreed.',
        'Payment plan split across three instalments as requested.',
        'Home loan pre-approved; booking made on the same day as the site visit.',
      ]),
      createdById: cust.lead.ownerId,
      createdAt: bookingDate,
    });

    unit.status = stage[1] === 'COMPLETED' ? 'SOLD' : 'BOOKED';
    unit.bookingId = id;
    unit.customerId = cust.id;
  }

  const bookingsById = new Map(ds.bookings.map((b) => [b.id as string, b] as const));

  // -------------------------------------------------------------- payments
  for (const cust of customerRecords) {
    if (!cust.bookingId) continue;
    const booking = bookingsById.get(cust.bookingId)!;
    const saleValue = Number(booking.saleValue);
    const bookingAmount = Number(booking.bookingAmount);
    const base = new Date(booking.bookingDate as Date);
    const instalments = rng.int(2, 4);
    let paid = 0;
    for (let i = 0; i < instalments; i++) {
      const isFirst = i === 0;
      const amount = isFirst
        ? bookingAmount
        : Math.round(((saleValue - paid) * rng.float(0.15, 0.35)) / 1000) * 1000;
      if (amount <= 0) break;
      paid += amount;
      const bounced = !isFirst && rng.chance(0.06);
      ds.payments.push({
        id: uid(),
        bookingId: cust.bookingId,
        customerId: cust.id,
        amount: String(amount),
        paymentDate: new Date(base.getTime() + i * rng.int(18, 45) * 86_400_000),
        method: rng.weighted(PAYMENT_METHODS),
        reference: `${rng.pick(['UPI', 'NEFT', 'RTGS', 'CHQ'])}${rng.int(1000000, 9999999)}`,
        status: bounced ? 'BOUNCED' : 'RECEIVED',
        notes: bounced ? 'Cheque returned — insufficient funds. Customer informed.' : null,
        receivedById: cust.lead.ownerId,
        createdAt: new Date(base.getTime() + i * rng.int(18, 45) * 86_400_000),
      });
    }
  }

  // ----------------------------------------------- cancellations + refunds
  const cancellable = ds.bookings.filter(
    (b) => b.status === 'CONFIRMED' || b.status === 'DOCUMENT_COLLECTION',
  );
  for (const booking of rng.sample(cancellable, Math.min(4, cancellable.length))) {
    const id = uid();
    const [reason, category] = rng.pick(CANCEL_REASONS);
    const approved = rng.chance(0.75);
    const cancelledAt = new Date(
      (bookingsById.get(booking.id as string)!.bookingDate as Date).getTime() + rng.int(10, 40) * 86_400_000,
    );
    const refundAmount = Number(booking.bookingAmount);
    (booking as Record<string, unknown>).status = 'CANCELLED';
    (booking as Record<string, unknown>).cancellationId = id;

    ds.cancellations.push({
      id,
      bookingId: booking.id,
      reason,
      reasonCategory: category,
      cancelledAt,
      refundAmount: String(refundAmount),
      refundStatus: approved ? 'APPROVED' : 'PENDING',
      approvalStatus: approved ? 'APPROVED' : 'PENDING',
      approvedById: approved ? adminId : null,
      approvedAt: approved ? new Date(cancelledAt.getTime() + 2 * 86_400_000) : null,
      inventoryProcessed: approved,
      commissionProcessed: approved,
      notes: approved
        ? 'Unit released back to inventory and the booking amount refunded.'
        : 'Awaiting management approval before the unit is released.',
      createdById: accountsId,
      createdAt: cancelledAt,
    });

    if (approved) {
      ds.refunds.push({
        id: uid(),
        cancellationId: id,
        bookingId: booking.id,
        amount: String(refundAmount),
        date: new Date(cancelledAt.getTime() + rng.int(5, 15) * 86_400_000),
        method: 'BANK_TRANSFER',
        reference: `RFND${rng.int(100000, 999999)}`,
        status: rng.chance(0.7) ? 'PAID' : 'PENDING',
        notes: 'Refunded to the original source account.',
        createdById: accountsId,
        createdAt: cancelledAt,
      });
    }
  }

  // Release cancelled units back into inventory.
  const cancelledUnitIds = new Set(
    ds.cancellations.map((c) => bookingsById.get(c.bookingId as string)?.unitId as string),
  );
  for (const u of ds.units) {
    if (cancelledUnitIds.has(u.id as string)) {
      u.status = 'AVAILABLE';
      u.bookingId = null;
      u.customerId = null;
    }
  }

  // ------------------------------------------------------------- followups
  interface FollowupPlan { lead: LeadRecord; offset: number; hour: number; done: boolean }
  const followupPlans: FollowupPlan[] = [];
  for (const lead of leadRecords) {
    const n = lead.status === 'NEW' ? rng.int(0, 1) : rng.int(1, 3);
    for (let i = 0; i < n; i++) {
      // Spread across overdue, today, and upcoming so every filter has data.
      const offset = rng.weighted([
        [rng.int(-12, -1), 40], [0, 22], [rng.int(1, 9), 38],
      ] as Array<[number, number]>);
      followupPlans.push({
        lead,
        offset,
        hour: rng.int(9, 18),
        done: offset < 0,
      });
    }
  }
  // Guarantee a healthy "due today" queue for the demo.
  const todayPool = followupPlans.filter((f) => !f.done);
  for (let i = 0; i < 18 && i < todayPool.length; i++) {
    if (!todayPool[i]) continue;
    todayPool[i].offset = 0;
    todayPool[i].done = false;
  }

  for (const plan of followupPlans) {
    const type = rng.weighted([
      ['CALL', 34], ['WHATSAPP', 30], ['SITE_VISIT', 12], ['MEETING', 10], ['EMAIL', 10], ['OTHER', 4],
    ] as Array<[string, number]>);
    const scheduledAt = plan.offset === 0
      ? clock.slot(0, plan.hour, rng.int(0, 59))
      : clock.slot(plan.offset, plan.hour, rng.int(0, 59));
    const status = plan.done
      ? rng.weighted([['COMPLETED', 82], ['SKIPPED', 8], ['EXPIRED', 10]] as Array<[string, number]>)
      : 'PENDING';
    ds.followups.push({
      id: uid(),
      leadId: plan.lead.id,
      customerId: null,
      type,
      scheduledAt,
      reminderAt: new Date(scheduledAt.getTime() - 3_600_000),
      status,
      notes: `${rng.pick(FOLLOWUP_NOTES)}`,
      assignedTo: plan.lead.ownerId || managerId,
      createdById: plan.lead.ownerId || managerId,
      completedById: status === 'COMPLETED' ? plan.lead.ownerId || managerId : null,
      completedAt: status === 'COMPLETED' ? new Date(scheduledAt.getTime() + 900_000) : null,
      remindBeforeMinutes: 60,
      reminderSent: status !== 'PENDING',
      nextFollowupId: null,
      createdAt: new Date(scheduledAt.getTime() - rng.int(1, 6) * 86_400_000),
    });
  }

  // Some customers get post-booking follow-ups (registration / loan / handover).
  for (const cust of customerRecords) {
    if (!cust.bookingId || !rng.chance(0.55)) continue;
    const offset = rng.weighted([[rng.int(-20, -1), 45], [rng.int(1, 20), 55]] as Array<[number, number]>);
    const scheduledAt = clock.slot(offset, rng.int(10, 17), rng.int(0, 59));
    ds.followups.push({
      id: uid(),
      leadId: cust.lead.id,
      customerId: cust.id,
      type: rng.weighted([['CALL', 30], ['WHATSAPP', 25], ['MEETING', 25], ['EMAIL', 20]] as Array<[string, number]>),
      scheduledAt,
      reminderAt: new Date(scheduledAt.getTime() - 7_200_000),
      status: offset < 0 ? rng.weighted([['COMPLETED', 85], ['SKIPPED', 15]] as Array<[string, number]>) : 'PENDING',
      notes: rng.pick([
        'Loan document collection pending with the customer.',
        'Registration appointment to be confirmed.',
        'Payment reminder for the next instalment.',
        'Handover possession checklist to be shared.',
      ]),
      assignedTo: cust.lead.ownerId,
      createdById: cust.lead.ownerId,
      completedById: offset < 0 ? cust.lead.ownerId : null,
      completedAt: offset < 0 ? new Date(scheduledAt.getTime() + 1_200_000) : null,
      remindBeforeMinutes: 120,
      reminderSent: offset < 0,
      nextFollowupId: null,
      createdAt: new Date(scheduledAt.getTime() - 3 * 86_400_000),
    });
  }

  // --------------------------------------------------------------- meetings
  const meetingLeads = leadRecords.filter((l) =>
    ['MEETING', 'SITE_VISIT_1', 'SITE_VISIT_2', 'SITE_VISIT_3', 'NEGOTIATION', 'BOOKING', 'DOCUMENT_COLLECTION', 'DEAL_COMPLETED'].includes(l.status),
  );
  for (const lead of meetingLeads) {
    const visits = lead.status === 'SITE_VISIT_1' ? 1
      : lead.status === 'SITE_VISIT_2' ? 2
        : lead.status === 'SITE_VISIT_3' ? 3
          : rng.int(1, 3);
    for (let v = 1; v <= visits; v++) {
      const offset = rng.weighted([[rng.int(-45, -2), 55], [0, 15], [rng.int(1, 14), 30]] as Array<[number, number]>);
      const status = offset < 0
        ? rng.weighted([['COMPLETED', 78], ['NO_SHOW', 12], ['RESCHEDULED', 6], ['CANCELLED', 4]] as Array<[string, number]>)
        : offset === 0 ? 'CONFIRMED' : 'SCHEDULED';
      const scheduledAt = clock.slot(offset, rng.int(10, 18), rng.int(0, 59));
      const project = lead.projectId ? projectName.get(lead.projectId)! : rng.pick(activeProjects).name;
      ds.meetings.push({
        id: uid(),
        leadId: lead.id,
        customerId: null,
        projectId: lead.projectId,
        type: 'SITE_VISIT',
        visitNumber: v,
        title: `Site visit ${v} — ${project}`,
        scheduledAt,
        status,
        location: `${project}, Bengaluru`,
        notes: status === 'COMPLETED' || status === 'NO_SHOW'
          ? null
          : 'Customer requested a morning slot. Sample flat to be kept ready.',
        feedback: status === 'COMPLETED' ? rng.pick(VISIT_FEEDBACK) : null,
        nextAction: status === 'COMPLETED'
          ? rng.pick([
              'Send the revised price list and floor plans.',
              'Schedule a second visit with the spouse.',
              'Share the payment plan and EMI sheet.',
              'Confirm the home loan sanction timeline.',
              'Hold the preferred unit for 48 hours.',
            ])
          : null,
        assignedTo: lead.ownerId || managerId,
        createdById: lead.ownerId || managerId,
        conversationDone: status === 'COMPLETED'
          ? rng.pick([
              'Discussed layout, view, maintenance charges and possession timeline.',
              'Walked through the clubhouse, parking allocation and the payment plan.',
              'Reviewed the floor plan, compared with two other projects, and discussed loan options.',
            ])
          : '',
        createdAt: new Date(scheduledAt.getTime() - rng.int(2, 9) * 86_400_000),
      });
    }
  }

  // Add a few customer-facing post-booking meetings.
  for (const cust of customerRecords) {
    if (!cust.bookingId || !rng.chance(0.35)) continue;
    const offset = rng.weighted([[rng.int(-30, -1), 50], [rng.int(1, 21), 50]] as Array<[number, number]>);
    const scheduledAt = clock.slot(offset, rng.int(11, 17), rng.int(0, 59));
    const project = bookingsById.get(cust.bookingId)!.projectId as string;
    ds.meetings.push({
      id: uid(),
      leadId: cust.lead.id,
      customerId: cust.id,
      projectId: project,
      type: 'MEETING',
      visitNumber: null,
      title: `Registration & document review — ${projectName.get(project)}`,
      scheduledAt,
      status: offset < 0 ? 'COMPLETED' : 'SCHEDULED',
      location: `${projectName.get(project)} sales office, Bengaluru`,
      notes: null,
      feedback: offset < 0 ? 'All documents verified. Registration slot confirmed with the customer.' : null,
      nextAction: offset < 0 ? 'Hand over the payment receipt and share the registration date.' : 'Collect the remaining originals.',
      assignedTo: cust.lead.ownerId,
      createdById: cust.lead.ownerId,
      conversationDone: offset < 0 ? 'Reviewed PAN, Aadhaar, bank statement and loan sanction letter.' : '',
      createdAt: new Date(scheduledAt.getTime() - 4 * 86_400_000),
    });
  }

  // -------------------------------------------------------------- documents
  for (const cust of customerRecords) {
    const booking = cust.bookingId ? bookingsById.get(cust.bookingId) : null;
    const base = new Date(cust.lead.createdAt.getTime() + rng.int(3, 12) * 86_400_000);
    const types: string[] = ['PAN', 'AADHAAR', 'ADDRESS_PROOF', 'BANK_DOCUMENT'];
    if (booking) types.push('BOOKING_FORM', 'AGREEMENT', 'PAYMENT_RECEIPT', 'LOAN_DOCUMENT');

    for (const [i, type] of types.entries()) {
      const rejected = rng.chance(0.05);
      const pending = !rejected && rng.chance(0.18);
      const at = new Date(base.getTime() + i * rng.int(1, 8) * 86_400_000);
      ds.documents.push({
        id: uid(),
        customerId: cust.id,
        bookingId: booking?.id ?? null,
        leadId: cust.lead.id,
        documentType: type,
        title: `${type.replace(/_/g, ' ')} — ${cust.lead.name}`,
        fileName: `${cust.no}-${type.toLowerCase()}.pdf`,
        r2Key: `demo/${cust.no}/${type.toLowerCase()}.pdf`,
        mimeType: 'application/pdf',
        size: rng.int(48_000, 2_400_000),
        sha256: Array.from({ length: 64 }, () => '0123456789abcdef'[rng.int(0, 15)]).join(''),
        verificationStatus: rejected ? 'REJECTED' : pending ? 'PENDING' : 'VERIFIED',
        verificationNote: rejected
          ? 'Image is blurred and the document number is not legible. Re-upload requested.'
          : pending ? null : 'Verified against the original.',
        uploadedById: cust.lead.ownerId,
        verifiedById: pending || rejected ? null : docsId,
        verifiedAt: pending || rejected ? null : new Date(at.getTime() + 3_600_000),
        createdAt: at,
      });
    }
  }

  // -------------------------------------------------------- commission rules
  const ruleIdFor = new Map<string, string>();
  for (const spec of PROJECTS) {
    const pid = projectId.get(spec.code)!;
    const base = clock.daysAgo(rng.int(200, 300), rng);
    const defs: Array<{ name: string; type: string; payableTo: string; rate?: string; fixed?: string; collection?: number }> = [
      { name: `${spec.name} — Sales executive 2% on sale value`, type: 'PERCENTAGE', payableTo: 'SALES_EXECUTIVE', rate: '2.0' },
      { name: `${spec.name} — Team leader 0.5% override`, type: 'PERCENTAGE', payableTo: 'TEAM_LEADER', rate: '0.5' },
      { name: `${spec.name} — Sales manager 0.25% management`, type: 'PERCENTAGE', payableTo: 'SALES_MANAGER', rate: '0.25' },
      { name: `${spec.name} — Executive 5% of collection`, type: 'COLLECTION_BASED', payableTo: 'SALES_EXECUTIVE', rate: '5.0', collection: 30 },
      { name: `${spec.name} — Broker referral fee ₹1.5L`, type: 'FIXED', payableTo: 'BROKER', fixed: '150000' },
    ];
    for (const [i, def] of defs.entries()) {
      const id = uid();
      ruleIdFor.set(`${pid}:${def.payableTo}:${def.type}`, id);
      ds.commissionRules.push({
        id,
        name: def.name,
        type: def.type,
        payableTo: def.payableTo,
        personId: null,
        projectId: pid,
        brokerName: def.payableTo === 'BROKER' ? `${spec.name} broker pool` : null,
        rate: def.rate ?? null,
        fixedAmount: def.fixed ?? null,
        slabConfig: i === 0
          ? [{ max: 75_00_000, rate: 2.0 }, { max: 1_50_00_000, rate: 2.25 }, { max: 9_99_99_999, rate: 2.5 }]
          : [],
        collectionWindowDays: def.collection ?? null,
        isActive: true,
        version: 1,
        effectiveFrom: base,
        effectiveTo: null,
        notes: i === 0 ? 'Slab applies on the total sale value of the booking.' : null,
        createdById: adminId,
        createdAt: base,
      });
    }
  }

  // -------------------------------------------------- commission snapshots
  interface SnapshotRecord {
    id: string; bookingId: string; personId: string | null; amount: number;
    status: string; payableOn: Date; personName: string; personRole: string;
  }
  const snapshotRecords: SnapshotRecord[] = [];

  for (const booking of ds.bookings) {
    if (booking.status === 'CANCELLED') continue;
    const b = booking as Record<string, unknown>;
    const saleValue = Number(b.saleValue);
    const pid = b.projectId as string;
    // Age is measured against the injected clock, never `Date.now()`: the
    // generator must produce the same state machine on any wall-clock date.
    const ageDays = Math.floor((clock.now.getTime() - (b.bookingDate as Date).getTime()) / 86_400_000);
    const status = ageDays > 75 ? 'PAID' : ageDays > 45 ? 'PAYABLE' : ageDays > 20 ? 'APPROVED' : 'PENDING';
    const payableOn = new Date((b.bookingDate as Date).getTime() + 30 * 86_400_000);
    const collected = ds.payments
      .filter((p) => p.bookingId === b.id && p.status === 'RECEIVED')
      .reduce((s, p) => s + Number(p.amount), 0);

    const add = (
      payableTo: string, rate: number, basis: 'SALE_VALUE' | 'COLLECTION',
      personId: string | null, personName: string, personRole: string,
    ) => {
      const base = basis === 'COLLECTION' ? collected : saleValue;
      const amount = Math.round((base * rate) / 100);
      if (amount <= 0) return;
      const id = uid();
      const ruleKey = `${pid}:${payableTo}:${basis === 'COLLECTION' ? 'COLLECTION_BASED' : 'PERCENTAGE'}`;
      snapshotRecords.push({
        id, bookingId: b.id as string, personId, amount, status, payableOn, personName, personRole,
      });
      ds.commissionSnapshots.push({
        id,
        bookingId: b.id as string,
        ruleId: ruleIdFor.get(ruleKey) ?? null,
        ruleVersion: 1,
        ruleName: payableTo === 'BROKER'
          ? 'Broker referral fee'
          : `${payableTo.replace(/_/g, ' ').toLowerCase()} — ${rate}% ${basis === 'COLLECTION' ? 'of collection' : 'on sale value'}`,
        personId,
        personRole,
        personName,
        basis: basis === 'COLLECTION' ? 'COLLECTION' : 'SALE_VALUE',
        baseAmount: String(base),
        rate: String(rate),
        amount: String(amount),
        status,
        payableOn,
        notes: basis === 'COLLECTION' ? 'Calculated on the amount collected within 30 days.' : null,
        createdAt: new Date((b.bookingDate as Date).getTime() + 5 * 86_400_000),
      });
    };

    add('SALES_EXECUTIVE', 2.0, 'SALE_VALUE', b.salespersonId as string, nameById.get(b.salespersonId as string)!, 'SALES_EXECUTIVE');
    add('TEAM_LEADER', 0.5, 'SALE_VALUE', b.teamLeaderId as string, nameById.get(b.teamLeaderId as string)!, 'TEAM_LEADER');
    add('SALES_MANAGER', 0.25, 'SALE_VALUE', managerId, nameById.get(managerId)!, 'SALES_MANAGER');
    if (b.brokerName) add('BROKER', 0, 'SALE_VALUE', null, b.brokerName as string, 'BROKER');
    if (collected > 0) add('SALES_EXECUTIVE', 5.0, 'COLLECTION', b.salespersonId as string, nameById.get(b.salespersonId as string)!, 'SALES_EXECUTIVE');
  }

  // A broker snapshot is a flat fee, not a percentage of the sale value.
  for (const snap of ds.commissionSnapshots) {
    if (snap.personRole !== 'BROKER') continue;
    (snap as Record<string, unknown>).amount = '150000';
    (snap as Record<string, unknown>).rate = null;
    (snap as Record<string, unknown>).baseAmount = null;
    const rec = snapshotRecords.find((s) => s.id === snap.id)!;
    rec.amount = 150000;
  }

  // ------------------------------------------------- commission adjustments
  for (const snap of rng.sample(snapshotRecords, Math.min(8, snapshotRecords.length))) {
    const type = rng.weighted([['ADJUSTMENT', 4], ['DEDUCTION', 4], ['REVERSAL', 2]] as Array<[string, number]>);
    const amount = type === 'REVERSAL'
      ? -snap.amount
      : type === 'DEDUCTION'
        ? -Math.round(snap.amount * rng.float(0.1, 0.3))
        : Math.round(snap.amount * rng.float(0.05, 0.2));
    ds.commissionAdjustments.push({
      id: uid(),
      snapshotId: snap.id,
      amount: String(amount),
      type,
      reason: rng.pick([
        'Price revision agreed with the customer — commission adjusted.',
        'Split booking between two executives as per management approval.',
        'Broker fee partially recovered after the customer cancelled the referral.',
        'Bonus for a same-day site visit and booking.',
        'Deduction for delayed registration documentation.',
      ]),
      status: rng.weighted([['APPROVED', 6], ['PENDING', 4]] as Array<[string, number]>),
      approvedById: adminId,
      approvedAt: new Date(snap.payableOn.getTime() + 86_400_000),
      createdById: accountsId,
      createdAt: new Date(snap.payableOn.getTime() + 43_200_000),
    });
  }

  // -------------------------------------------------------- payout batches
  // Batch numbers use the same `PO-NN` format the app mints at runtime.
  // Cut-off points are derived from the actual snapshot ages rather than
  // hardcoded day windows, so every batch is populated no matter how the
  // booking dates land relative to the seed's `now`.
  const payoutSeq = 3;
  const settled = snapshotRecords
    .filter((s) => s.status !== 'PENDING')
    .slice()
    .sort((x, y) => x.payableOn.getTime() - y.payableOn.getTime());
  const cutOld = Math.max(1, Math.round(settled.length * 0.6));
  const cutMid = Math.max(cutOld + 1, Math.round(settled.length * 0.9));
  const batchDefs = [
    { no: NO.payout(1), slice: settled.slice(0, cutOld), status: 'PAID' },
    { no: NO.payout(2), slice: settled.slice(cutOld, cutMid), status: 'PROCESSED' },
    { no: NO.payout(3), slice: settled.slice(cutMid), status: 'DRAFT' },
  ] as const;
  const batchIdByStatus = new Map<string, string>();
  for (const def of batchDefs) {
    const id = uid();
    batchIdByStatus.set(def.status, id);
    const inBatch = def.slice;
    const total = inBatch.reduce((s, r) => s + r.amount, 0);
    const payableDates = inBatch.map((s) => s.payableOn.getTime());
    const periodTo = payableDates.length ? new Date(Math.max(...payableDates)) : clock.daysAgo(1, rng);
    const periodFrom = payableDates.length ? new Date(Math.min(...payableDates)) : periodTo;
    // The batch is raised shortly after the last commission it settles.
    const createdAt = new Date(periodTo.getTime() + 2 * 86_400_000);
    ds.payoutBatches.push({
      id,
      batchNo: def.no,
      status: def.status,
      periodFrom,
      periodTo,
      totalAmount: String(total),
      approvedById: def.status === 'DRAFT' ? null : adminId,
      approvedAt: def.status === 'DRAFT' ? null : new Date(createdAt.getTime() + 86_400_000),
      processedAt: def.status === 'PAID' ? new Date(createdAt.getTime() + 2 * 86_400_000) : null,
      createdById: accountsId,
      createdAt,
    });

    // One transaction per person per batch, so the payout screen is readable.
    const byPerson = new Map<string, { amount: number; count: number }>();
    for (const s of inBatch) {
      const key = s.personId ?? `broker:${s.personName}`;
      const cur = byPerson.get(key) ?? { amount: 0, count: 0 };
      cur.amount += s.amount;
      cur.count += 1;
      byPerson.set(key, cur);
    }
    for (const [key, agg] of byPerson) {
      ds.payoutTransactions.push({
        id: uid(),
        batchId: id,
        snapshotId: null,
        personId: key.startsWith('broker:') ? null : key,
        amount: String(agg.amount),
        status: def.status === 'PAID' ? 'PAID' : def.status === 'PROCESSED' ? 'PROCESSED' : 'PENDING',
        paidAt: def.status === 'PAID' ? new Date(createdAt.getTime() + 2 * 86_400_000) : null,
        notes: key.startsWith('broker:')
          ? `Broker payout — ${key.slice(7)} (${agg.count} bookings)`
          : `${agg.count} commission ${agg.count === 1 ? 'entry' : 'entries'}`,
        createdById: accountsId,
        createdAt,
      });
    }
  }

  // ------------------------------------------------------ commission ledger
  interface LedgerLine {
    personId: string | null; snapshotId: string | null; bookingId: string | null;
    credit: number; debit: number; sourceType: string; sourceId: string | null;
    notes: string | null; at: Date;
  }
  const ledgerLines: LedgerLine[] = [];
  for (const s of snapshotRecords) {
    if (s.status === 'PENDING') continue;
    ledgerLines.push({
      personId: s.personId,
      snapshotId: s.id,
      bookingId: s.bookingId,
      credit: s.amount,
      debit: 0,
      sourceType: 'COMMISSION',
      sourceId: s.id,
      notes: `Commission accrued on ${bookingsById.get(s.bookingId)?.bookingNo ?? s.bookingId}`,
      at: s.payableOn,
    });
  }
  for (const adj of ds.commissionAdjustments) {
    const snap = snapshotRecords.find((s) => s.id === adj.snapshotId)!;
    ledgerLines.push({
      personId: snap.personId,
      snapshotId: snap.id,
      bookingId: snap.bookingId,
      credit: Number(adj.amount) > 0 ? Number(adj.amount) : 0,
      debit: Number(adj.amount) < 0 ? Math.abs(Number(adj.amount)) : 0,
      sourceType: 'ADJUSTMENT',
      sourceId: adj.id as string,
      notes: adj.reason as string,
      at: new Date((adj.createdAt as Date).getTime()),
    });
  }
  for (const tx of ds.payoutTransactions) {
    if (tx.status === 'PENDING') continue;
    ledgerLines.push({
      personId: tx.personId as string | null,
      snapshotId: null,
      bookingId: null,
      credit: 0,
      debit: Number(tx.amount),
      sourceType: 'PAYOUT',
      sourceId: tx.id as string,
      notes: tx.notes as string,
      at: new Date((tx.createdAt as Date).getTime() + 2 * 86_400_000),
    });
  }

  const byPersonKey = new Map<string, LedgerLine[]>();
  for (const line of ledgerLines) {
    const key = line.personId ?? 'unattributed';
    const list = byPersonKey.get(key) ?? [];
    list.push(line);
    byPersonKey.set(key, list);
  }
  for (const [key, list] of byPersonKey) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
    let balance = 0;
    for (const line of list) {
      balance += line.credit - line.debit;
      ds.commissionLedger.push({
        id: uid(),
        personId: key === 'unattributed' ? null : key,
        snapshotId: line.snapshotId,
        bookingId: line.bookingId,
        credit: String(line.credit),
        debit: String(line.debit),
        runningBalance: String(balance),
        sourceType: line.sourceType,
        sourceId: line.sourceId,
        notes: line.notes,
        createdById: accountsId,
        createdAt: line.at,
      });
    }
  }

  // ------------------------------------------------------------- expenses
  const expenseCats = ['TRAVEL', 'MARKETING', 'CALLS', 'MEALS', 'PRINTING', 'BROCHURES', 'EVENTS', 'OTHER'];
  for (let i = 0; i < 42; i++) {
    const pid = rng.pick(projectCodes);
    ds.expenses.push({
      id: uid(),
      category: rng.pick(expenseCats),
      amount: String(rng.int(800, 24_000) * 100),
      date: clock.daysAgo(rng.int(1, 90), rng),
      description: rng.pick([
        'Site visit fuel and tolls',
        'Digital campaign spend',
        'Brochure printing',
        'Client meeting dinner',
        'Open house stall setup',
        'Site signage and banners',
        'Loan officer coordination',
      ]),
      projectId: projectId.get(pid)!,
      createdById: rng.chance(0.5) ? managerId : adminId,
      createdAt: clock.daysAgo(rng.int(1, 90), rng),
    });
  }

  // ------------------------------------------------ duplicates + assignments
  const dupeCandidates = rng.sample(leadRecords, 30).filter((l) => l.status !== 'WRONG_NUMBER');
  const dupeCount = Math.min(6, dupeCandidates.length);
  for (let i = 0; i < dupeCount; i++) {
    const original = dupeCandidates[i];
    const dupeId = uid();
    const confidence = rng.int(78, 100);
    const ruleType = rng.chance(0.7) ? 'PHONE' : 'EMAIL';
    const status = rng.weighted([['OPEN', 5], ['IGNORED', 3], ['MERGED', 2]] as Array<[string, number]>);
    const createdAt = new Date(original.createdAt.getTime() + rng.int(1, 5) * 86_400_000);

    ds.leads.push({
      id: dupeId,
      leadNo: NO.lead(leadRecords.length + i + 1),
      name: original.name,
      phone: ruleType === 'PHONE' ? original.phone : `+91 8${pad(30_000_000 + i * 104_729, 9)}`,
      whatsapp: null,
      email: ruleType === 'EMAIL' ? original.email : `dup${i}@example.com`,
      source: 'MANUAL',
      campaign: 'Re-enquiry',
      projectId: original.projectId,
      budget: original.budget,
      preferredLocation: null,
      propertyType: 'APARTMENT',
      requirement: 'Duplicate enquiry from the same customer',
      // A duplicate is a system-detected, unworked record: it carries no owner
      // and no assignment history until somebody merges or dismisses it.
      ownerId: null,
      assignedAt: null,
      priority: 'LOW',
      status: 'DUPLICATE',
      tags: ['duplicate'],
      isDuplicate: true,
      duplicateOfId: original.id,
      notes: 'Same phone number as an existing lead. Awaiting merge decision.',
      createdById: managerId,
      firstSeenAt: createdAt,
      createdAt,
    });

    ds.leadDuplicates.push({
      id: uid(),
      leadId: dupeId,
      duplicateOfId: original.id,
      ruleType,
      confidence,
      status,
      resolvedById: status === 'OPEN' ? null : managerId,
      resolvedAt: status === 'OPEN' ? null : new Date(createdAt.getTime() + 2 * 86_400_000),
      meta: { matchedOn: ruleType === 'PHONE' ? 'phone' : 'email' },
      createdAt,
    });
  }

  // (assignment history is written above, before the lead rows are emitted)

  // -------------------------------------------------------- incoming leads
  const providers = ['FACEBOOK', 'INSTAGRAM', 'WHATSAPP', 'NINE9ACRES', 'MAGICBRICKS', 'GOOGLE_ADS'];
  for (let i = 0; i < 26; i++) {
    const provider = rng.pick(providers);
    const roll = rng.unit();
    const linkLead = roll < 0.6 ? rng.pick(leadRecords) : null;
    const status = roll < 0.6 ? 'CREATED' : roll < 0.75 ? 'DUPLICATE' : roll < 0.9 ? 'RECEIVED' : roll < 0.96 ? 'IGNORED' : 'ERROR';
    ds.incomingLeads.push({
      id: uid(),
      provider,
      rawPayload: {
        provider,
        lead_id: `ext_${rng.int(100000, 999999)}`,
        name: linkLead?.name ?? makePersonName(rng),
        phone: linkLead?.phone ?? `+91 7${pad(40_000_000 + i * 154_858, 9)}`,
        message: rng.pick(OPENING_MESSAGE),
        received_at: new Date().toISOString(),
      },
      normalized: status === 'CREATED'
        ? { name: linkLead?.name, phone: linkLead?.phone, source: provider }
        : null,
      status,
      leadId: status === 'CREATED' ? linkLead?.id : null,
      error: status === 'ERROR' ? 'Phone number failed validation — not a valid mobile number.' : null,
      receivedAt: clock.daysAgo(rng.int(0, 20), rng),
    });
  }

  // -------------------------------------------------------- notifications
  const unread: Array<[string, string, string]> = [
    ['LEAD_ASSIGNED', 'New lead assigned to you', '{name} enquired about {project}.'],
    ['FOLLOWUP_REMINDER', 'Follow-up due', 'You have a follow-up scheduled for {name} today.'],
    ['UPCOMING_VISIT', 'Site visit in 1 hour', '{name} is scheduled to visit {project}.'],
    ['DOCUMENT_REJECTED', 'Document rejected', 'A document for {name} needs a re-upload.'],
    ['COMMISSION_EVENT', 'Commission approved', 'Your commission of ₹{amount} has been approved.'],
    ['PAYMENT_REMINDER', 'Payment reminder', 'Next instalment for {name} is due.'],
    ['BOOKING_EVENT', 'Booking confirmed', '{name} confirmed a booking in {project}.'],
    ['SYSTEM', 'Payout batch processed', 'Payout batch {batch} has been processed.'],
  ];
  for (const uidv of [adminId, managerId, ...tlIds, ...execIds, accountsId, docsId]) {
    for (let i = 0; i < rng.int(3, 6); i++) {
      const [type, title, body] = rng.pick(unread);
      const at = clock.daysAgo(rng.int(0, 12), rng);
      ds.notifications.push({
        id: uid(),
        userId: uidv,
        type,
        title,
        body: body
          .replace('{name}', makePersonName(rng))
          .replace('{project}', rng.pick(PROJECTS).name)
          .replace('{amount}', (rng.int(20, 400) * 1000).toLocaleString('en-IN'))
          .replace('{batch}', rng.pick(batchDefs).no),
        entityType: type === 'LEAD_ASSIGNED' ? 'lead' : type === 'BOOKING_EVENT' ? 'booking' : null,
        entityId: null,
        readAt: rng.chance(0.55) ? new Date(at.getTime() + 3_600_000) : null,
        meta: {},
        createdAt: at,
      });
    }
  }

  // ------------------------------------------------------ automation rules
  const autoDefs: Array<[string, string, Array<Record<string, unknown>>, Record<string, unknown>]> = [
    ['Auto-assign new leads to the round robin', 'LEAD_CREATED', [{ type: 'ASSIGN_ROUND_ROBIN' }], { team: 'East' }],
    ['Send WhatsApp brochure on first contact', 'LEAD_CREATED', [{ type: 'SEND_WHATSAPP', template: 'BROCHURE_V1' }, { type: 'CREATE_FOLLOWUP', inDays: 1, ftype: 'CALL' }], { delayMinutes: 5 }],
    ['Create follow-up 2 days after a completed site visit', 'VISIT_COMPLETED', [{ type: 'CREATE_FOLLOWUP', inDays: 2, ftype: 'CALL' }], { feedbackRequired: true }],
    ['Notify accounts when a booking is completed', 'BOOKING_COMPLETED', [{ type: 'NOTIFY_ROLE', role: 'ACCOUNTS' }, { type: 'CREATE_TASK', task: 'Collect booking amount receipt' }], {}],
    ['Escalate untouched leads back to the manager', 'FOLLOWUP_DONE', [{ type: 'ESCALATE_IF_NO_RESPONSE', afterDays: 7 }], { notifyRole: 'SALES_MANAGER' }],
    ['Flag verified documents for the customer record', 'DOCUMENT_VERIFIED', [{ type: 'UPDATE_CUSTOMER_FLAGS' }], { flags: ['KYC_COMPLETE'] }],
  ];
  for (const [name, trigger, actions, config] of autoDefs) {
    const isActive = rng.chance(0.8);
    ds.automationRules.push({
      id: uid(),
      name,
      trigger,
      actions,
      config,
      isActive,
      lastRunAt: isActive ? clock.daysAgo(rng.int(0, 3), rng) : null,
      createdById: adminId,
      createdAt: clock.daysAgo(rng.int(30, 200), rng),
    });
  }

  // ---------------------------------------------------------- integrations
  const integrationDefs: Array<[string, string, boolean, Record<string, unknown>]> = [
    ['FACEBOOK', 'Facebook Lead Ads', true, { pageId: 'FB_PAGE_ID', verified: true }],
    ['INSTAGRAM', 'Instagram Lead Ads', true, { businessAccountId: 'IG_BUSINESS_ACCOUNT_ID' }],
    ['WHATSAPP', 'WhatsApp Business Cloud', true, { phoneNumberId: 'WHATSAPP_PHONE_NUMBER_ID', webhook: '/api/webhooks/whatsapp' }],
    ['NINE9ACRES', '9acres.com', rng.chance(0.5), { apiKey: 'NINE9ACRES_API_KEY' }],
    ['MAGICBRICKS', 'MagicBricks', rng.chance(0.5), { apiKey: 'MAGICBRICKS_API_KEY' }],
    ['YOUTUBE_ADS', 'YouTube Ads', true, { apiKey: 'YOUTUBE_ADS_API_KEY' }],
    ['R2', 'Cloudflare R2 Storage', true, { bucket: 'R2_BUCKET', endpoint: 'R2_ENDPOINT' }],
    ['GROQ', 'Groq AI (lead scoring & summaries)', true, { model: 'GROQ_MODEL', keyRef: 'GROQ_API_KEY' }],
  ];
  for (const [provider, label, isActive, config] of integrationDefs) {
    ds.integrations.push({
      id: uid(),
      provider,
      label,
      config,
      webhookSecret: rng.chance(0.5) ? `whsec_${Array.from({ length: 24 }, () => '0123456789abcdef'[rng.int(0, 15)]).join('')}` : null,
      isActive,
      lastSyncAt: isActive ? clock.daysAgo(rng.int(0, 2), rng) : null,
      createdAt: clock.daysAgo(rng.int(60, 300), rng),
    });
  }

  // ------------------------------------------------------------- audit log
  const auditDefs: Array<[string, string]> = [
    ['LOGIN', 'auth'], ['CREATE', 'lead'], ['UPDATE', 'lead'], ['STATUS_CHANGE', 'lead'],
    ['IMPORT', 'lead'], ['MERGE', 'lead'], ['UPLOAD', 'document'], ['VERIFY', 'document'],
    ['CREATE', 'booking'], ['COMMISSION_CALC', 'commission'], ['PAYOUT', 'payout'],
    ['APPROVE', 'cancellation'], ['CANCEL', 'booking'], ['EXPORT', 'report'],
  ];
  for (let i = 0; i < 70; i++) {
    const [action, entity] = rng.pick(auditDefs);
    const actor = rng.pick([adminId, managerId, accountsId, docsId, ...execIds]);
    const pool = entity === 'lead' ? leadRecords
      : entity === 'booking' ? ds.bookings.map((b) => ({ id: b.id as string }))
        : entity === 'document' ? ds.documents.map((d) => ({ id: d.id as string }))
          : entity === 'cancellation' ? ds.cancellations.map((c) => ({ id: c.id as string }))
            : ds.customers.map((c) => ({ id: c.id as string }));
    const target = rng.pick(pool);
    ds.auditLogs.push({
      id: uid(),
      userId: actor,
      userEmail: emailById.get(actor) ?? null,
      action,
      entity,
      entityId: target?.id ?? null,
      oldValue: action === 'STATUS_CHANGE' ? { status: rng.pick(PIPELINE_ORDER) } : null,
      newValue: action === 'STATUS_CHANGE' ? { status: rng.pick(PIPELINE_ORDER) } : null,
      ip: `10.0.${rng.int(0, 4)}.${rng.int(2, 250)}`,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0',
      requestPath: `/${entity === 'auth' ? 'login' : entity}s`,
      requestMethod: action === 'LOGIN' ? 'POST' : rng.pick(['POST', 'PATCH', 'GET']),
      meta: {},
      createdAt: clock.daysAgo(rng.int(0, 45), rng),
    });
  }

  // -------------------------------------------------------- background jobs
  const jobDefs: Array<[string, string, string]> = [
    ['LEAD_SYNC_FACEBOOK', 'DONE', 'Synced 14 new leads from Facebook Lead Ads'],
    ['LEAD_SYNC_WHATSAPP', 'DONE', 'Synced 6 WhatsApp enquiries'],
    ['COMMISSION_CALC_MONTHLY', 'DONE', 'Calculated 84 commission snapshots'],
    ['DOCUMENT_VIRUS_SCAN', 'PROCESSING', 'Scanning 12 uploaded documents'],
    ['FOLLOWUP_REMINDER_DISPATCH', 'DONE', 'Sent 41 follow-up reminders'],
    ['DUPLICATE_DETECTION', 'PENDING', 'Queued — next run at 02:00'],
  ];
  for (const [type, status, msg] of jobDefs) {
    ds.backgroundJobs.push({
      id: uid(),
      type,
      payload: { seeded: true },
      status,
      priority: rng.int(1, 5),
      attempts: status === 'DONE' ? 1 : rng.int(0, 2),
      maxAttempts: 3,
      runAt: clock.daysAgo(rng.int(0, 2), rng),
      lastError: status === 'FAILED' ? msg : null,
      processedAt: status === 'DONE' ? clock.daysAgo(rng.int(0, 1), rng) : null,
      createdAt: clock.daysAgo(rng.int(0, 2), rng),
    });
  }

  // Business-number counters so future creates continue past the demo set.
  // Values mirror `services/counters.ts` (1-based) and `rr:<source>` is the
  // exact key used by `services/assignment.ts` for round-robin pointers.
  ds.counters = [
    { key: 'lead', value: leadRecords.length + dupeCount },
    { key: 'customer', value: custSeq },
    { key: 'booking', value: bookingSeq },
    { key: 'payout', value: payoutSeq },
    ...SOURCES.map(([source]) => ({
      key: `rr:${source}`,
      value: leadRecords.filter((l) => l.source === source).length,
    })),
  ];

  // Settings the app reads at runtime. `assignment.config` is consumed by
  // assignLead(); without it the assignment screen falls back to defaults.
  ds.settings = [
    {
      key: 'assignment.config',
      value: { mode: 'ROUND_ROBIN' },
    },
    {
      key: 'brand',
      value: { name: 'SalesPoint', tagline: 'Real estate sales CRM', supportEmail: 'crm@gmail.com' },
    },
    {
      key: 'demo',
      value: { seededAt: clock.now.toISOString(), leadCount: ds.leads.length, unitCount: ds.units.length },
    },
  ];

  ds.stats = {
    users: ds.users.length,
    projects: ds.projects.length,
    towers: ds.towers.length,
    units: ds.units.length,
    leads: ds.leads.length,
    customers: ds.customers.length,
    bookings: ds.bookings.length,
    payments: ds.payments.length,
    cancellations: ds.cancellations.length,
    followups: ds.followups.length,
    meetings: ds.meetings.length,
    documents: ds.documents.length,
    commissionSnapshots: ds.commissionSnapshots.length,
    payoutTransactions: ds.payoutTransactions.length,
  };

  return ds;
}
