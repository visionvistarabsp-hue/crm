/**
 * Deterministic demo dataset generator.
 *
 * Produces a realistic Indian real-estate sales funnel large enough to demo
 * every screen and workflow end to end. All randomness is seeded, so the same
 * input always yields the same dataset — a demo is reproducible and a bug found
 * during a demo can be reproduced exactly.
 *
 * All dates are relative to "now", so the dataset always has due-today
 * follow-ups and meetings no matter which day the demo is run on.
 */

// ------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic, fast, good enough for fixtures
// ------------------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  /** float in [min, max) */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
  /** raw float in [0, 1) */
  unit(): number {
    return this.next();
  }
  /** integer in [min, max] inclusive */
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
  /** true with probability p */
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Pick `count` distinct items (or all of them if count >= length). */
  sample<T>(items: readonly T[], count: number): T[] {
    const pool = [...items];
    const out: T[] = [];
    while (out.length < count && pool.length) {
      out.push(pool.splice(Math.floor(this.next() * pool.length), 1)[0]);
    }
    return out;
  }
  /** Weighted pick: weights need not sum to 1. */
  weighted<T>(entries: ReadonlyArray<[T, number]>): T {
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [value, w] of entries) {
      r -= w;
      if (r <= 0) return value;
    }
    return entries[entries.length - 1][0];
  }
}

// ------------------------------------------------------------------
// Time helpers — everything is relative to a single "now" anchor
// ------------------------------------------------------------------
const DAY = 86_400_000;
const HOUR = 3_600_000;

export class Clock {
  now: Date;
  constructor(now = new Date()) {
    // Anchor to midnight so day-offset arithmetic is stable within a run.
    this.now = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  /** n days ago, at a random hour/minute inside the working day */
  daysAgo(n: number, rng?: Rng): Date {
    const d = new Date(this.now.getTime() - n * DAY);
    d.setHours(9 + (rng ? rng.int(0, 9) : 0), rng ? rng.int(0, 59) : 0, 0, 0);
    return d;
  }
  daysAhead(n: number, rng?: Rng): Date {
    return this.daysAgo(-n, rng);
  }
  /** n days from now, snapped to a plausible slot (10:00–19:00) */
  slot(n: number, hour: number, minute = 0): Date {
    const d = new Date(this.now.getTime() + n * DAY);
    d.setHours(hour, minute, 0, 0);
    return d;
  }
  hoursFromNow(h: number): Date {
    return new Date(Date.now() + h * HOUR);
  }
}

// ------------------------------------------------------------------
// Reference data
// ------------------------------------------------------------------
export const SEED_PASSWORD = 'SalesPoint@123';

const FIRST_M = [
  'Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Reyansh', 'Krishna', 'Ishaan', 'Rohan', 'Karthik',
  'Siddharth', 'Anirudh', 'Rahul', 'Suresh', 'Manish', 'Praveen', 'Nikhil', 'Varun', 'Yash', 'Harsh',
  'Deepak', 'Sanjay', 'Gaurav', 'Rakesh', 'Sanjay', 'Vivek', 'Ajay', 'Sunil', 'Manoj', 'Ashok',
];
const FIRST_F = [
  'Ananya', 'Diya', 'Aadhya', 'Saanvi', 'Riya', 'Ishita', 'Priya', 'Kavya', 'Meera', 'Anjali',
  'Sneha', 'Pooja', 'Shreya', 'Neha', 'Divya', 'Aishwarya', 'Lakshmi', 'Nandini', 'Sanjana', 'Swara',
  'Trisha', 'Nitya', 'Bhavana', 'Harini', 'Varsha', 'Chitra', 'Padma', 'Rekha',
];
const LAST = [
  'Sharma', 'Verma', 'Iyer', 'Nair', 'Reddy', 'Rao', 'Gupta', 'Mehta', 'Kapoor', 'Joshi',
  'Patil', 'Desai', 'Menon', 'Chopra', 'Malhotra', 'Bhatt', 'Agarwal', 'Bansal', 'Chauhan', 'Dutta',
  'Kulkarni', 'Shetty', 'Pillai', 'Sinha', 'Saxena', 'Mishra', 'Pandey', 'Rastogi', 'Chauhan', 'Sethi',
  'Kaur', 'Bhatia', 'Khanna', 'Ghosh', 'Banerjee', 'Chatterjee', 'Mukherjee', 'Rai', 'Thakur', 'Yadav',
];

export const LOCALITIES = [
  'Whitefield', 'Koramangala', 'Indiranagar', 'Marathahalli', 'Jayanagar', 'HSR Layout',
  'Electronic City', 'Sarjapur Road', 'Hebbal', 'Banashankari', 'BTM Layout', 'Kalyan Nagar',
  'Yelahanka', 'Rajarajeshwari Nagar', 'Brookefield', 'Hennur Road', 'CV Raman Nagar',
  'Bellandur', 'Panathur', 'Kadugodi',
];

export interface ProjectSpec {
  code: string;
  name: string;
  location: string;
  city: string;
  state: string;
  reraNo: string;
  priceMin: number;
  priceMax: number;
  status: 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'DRAFT';
  towers: Array<{ name: string; floors: number; unitsPerFloor: number; status?: string }>;
  amenities: string[];
  description: string;
}

export const PROJECTS: ProjectSpec[] = [
  {
    code: 'PRJ-SKY2026',
    name: 'Skyline Heights',
    location: 'Whitefield, Bengaluru',
    city: 'Bengaluru', state: 'Karnataka',
    reraNo: 'PRM/KA/RERA/1251/310/RR/2026',
    priceMin: 55_00_000, priceMax: 1_85_00_000,
    status: 'ACTIVE',
    towers: [
      { name: 'Tower A', floors: 10, unitsPerFloor: 4 },
      { name: 'Tower B', floors: 10, unitsPerFloor: 4 },
      { name: 'Tower C', floors: 8, unitsPerFloor: 3 },
    ],
    amenities: ['Gym', 'Swimming Pool', 'Clubhouse', 'EV Charging', 'Rooftop Garden', 'Yoga Deck', 'CCTV', 'Power Backup'],
    description:
      'RERA-approved 2-4 BHK apartments in Whitefield with a podium-level clubhouse, 60% open space and direct lift access from the basement parking. Possession from March 2027.',
  },
  {
    code: 'PRJ-GRV2025',
    name: 'Greenview Residences',
    location: 'Sarjapur Road, Bengaluru',
    city: 'Bengaluru', state: 'Karnataka',
    reraNo: 'PRM/KA/RERA/1251/446/RR/2025',
    priceMin: 68_00_000, priceMax: 2_10_00_000,
    status: 'ACTIVE',
    towers: [
      { name: 'Wing 1', floors: 12, unitsPerFloor: 4 },
      { name: 'Wing 2', floors: 12, unitsPerFloor: 4 },
    ],
    amenities: ['Infinity Pool', 'Gym', 'Children Play Area', 'Jogging Track', 'Banquet Hall', 'Security'],
    description:
      'Gated community on Sarjapur Road focused on 3-4 BHK layouts, walking distance to the upcoming metro terminus. Currently in pre-launch, with early-bird pricing.',
  },
  {
    code: 'PRJ-URB2024',
    name: 'Urban Nest',
    location: 'Indiranagar, Bengaluru',
    city: 'Bengaluru', state: 'Karnataka',
    reraNo: 'PRM/KA/RERA/1251/288/RR/2024',
    priceMin: 95_00_000, priceMax: 3_40_00_000,
    status: 'COMPLETED',
    towers: [
      { name: 'Block A', floors: 14, unitsPerFloor: 3 },
      { name: 'Block B', floors: 14, unitsPerFloor: 3 },
    ],
    amenities: ['Sky Lounge', 'Concierge', 'Gym', 'Spa', 'Home Automation', 'Parking'],
    description:
      'Ready-to-move boutique development a short walk from 100ft Road. Limited inventory remaining in the top three floors — premium resale potential.',
  },
  {
    code: 'PRJ-MRN2026',
    name: 'Marina Bay Villas',
    location: 'Yelahanka, Bengaluru',
    city: 'Bengaluru', state: 'Karnataka',
    reraNo: 'PRM/KA/RERA/1251/512/RR/2026',
    priceMin: 1_80_00_000, priceMax: 4_50_00_000,
    status: 'ACTIVE',
    towers: [
      { name: 'Row Phase 1', floors: 2, unitsPerFloor: 4 },
      { name: 'Row Phase 2', floors: 2, unitsPerFloor: 4 },
    ],
    amenities: ['Private Pool', 'Private Garden', 'Home Theatre', 'Wine Cellar', 'Staff Quarters', 'Solar Backup'],
    description:
      '28 villas adjoining Yelahanka lake. Breezepass construction, 4 BHK with private pool options. High-net-worth buyer segment, longest sales cycle.',
  },
  {
    code: 'PRJ-HRZ2026',
    name: 'Horizon Business Park',
    location: 'Hebbal, Bengaluru',
    city: 'Bengaluru', state: 'Karnataka',
    reraNo: 'PRM/KA/RERA/1251/377/RR/2026',
    priceMin: 42_00_000, priceMax: 1_10_00_000,
    status: 'ON_HOLD',
    towers: [
      { name: 'Block 1', floors: 6, unitsPerFloor: 5 },
    ],
    amenities: ['Covered Parking', 'Double-height Lobby', 'Food Court', 'Conference Suites', 'ATM'],
    description:
      'Commercial office suites in a SEZ-adjacent development, currently on hold pending the metro corridor sanction. Kept in the inventory to show a non-ACTIVE project state.',
  },
];

// ------------------------------------------------------------------
// People
// ------------------------------------------------------------------
export interface PersonSpec {
  key: string;
  name: string;
  email: string;
  role: string;
  phone: string;
  managerKey?: string;
  title: string;
}

export const TEAM: PersonSpec[] = [
  { key: 'aarav', name: 'Aarav Mehta', email: 'admin@salespoint.in', role: 'SUPER_ADMIN', phone: '+91 9811100001', title: 'Sales Head' },
  { key: 'priya', name: 'Priya Nair', email: 'manager@salespoint.in', role: 'SALES_MANAGER', phone: '+91 9811100002', managerKey: 'aarav', title: 'Regional Sales Manager' },
  { key: 'kavita', name: 'Kavita Deshpande', email: 'accounts@salespoint.in', role: 'ACCOUNTS', phone: '+91 9811100003', managerKey: 'aarav', title: 'Accounts & Payouts' },
  { key: 'rohan', name: 'Rohan Kapoor', email: 'teamlead1@salespoint.in', role: 'TEAM_LEADER', phone: '+91 9811100004', managerKey: 'priya', title: 'Team Leader — East' },
  { key: 'fatima', name: 'Fatima Sheikh', email: 'teamlead2@salespoint.in', role: 'TEAM_LEADER', phone: '+91 9811100005', managerKey: 'priya', title: 'Team Leader — West' },
  { key: 'sneha', name: 'Sneha Reddy', email: 'exec1@salespoint.in', role: 'SALES_EXECUTIVE', phone: '+91 9811100006', managerKey: 'rohan', title: 'Senior Executive' },
  { key: 'virat', name: 'Virat Menon', email: 'exec2@salespoint.in', role: 'SALES_EXECUTIVE', phone: '+91 9811100007', managerKey: 'rohan', title: 'Executive' },
  { key: 'kavya', name: 'Kavya Iyer', email: 'exec3@salespoint.in', role: 'SALES_EXECUTIVE', phone: '+91 9811100008', managerKey: 'rohan', title: 'Executive' },
  { key: 'anand', name: 'Anand Prakash', email: 'exec4@salespoint.in', role: 'SALES_EXECUTIVE', phone: '+91 9811100009', managerKey: 'rohan', title: 'Executive' },
  { key: 'divya', name: 'Divya Raman', email: 'exec5@salespoint.in', role: 'SALES_EXECUTIVE', phone: '+91 9811100010', managerKey: 'fatima', title: 'Senior Executive' },
  { key: 'sameer', name: 'Sameer Khan', email: 'exec6@salespoint.in', role: 'SALES_EXECUTIVE', phone: '+91 9811100011', managerKey: 'fatima', title: 'Executive' },
  { key: 'pooja', name: 'Pooja Nair', email: 'exec7@salespoint.in', role: 'SALES_EXECUTIVE', phone: '+91 9811100012', managerKey: 'fatima', title: 'Executive' },
  { key: 'imran', name: 'Imran Qureshi', email: 'exec8@salespoint.in', role: 'SALES_EXECUTIVE', phone: '+91 9811100013', managerKey: 'fatima', title: 'Executive' },
  { key: 'nisha', name: 'Nisha Bhatt', email: 'docs@salespoint.in', role: 'DOCUMENT_MANAGER', phone: '+91 9811100014', managerKey: 'aarav', title: 'Documentation' },
];

export const EXEC_KEYS = TEAM.filter((t) => t.role === 'SALES_EXECUTIVE').map((t) => t.key);

// ------------------------------------------------------------------
// Lead funnel shape — deliberately mirrors a real conversion funnel so
// dashboards and reports show plausible conversion rates.
// ------------------------------------------------------------------
export interface StageSpec {
  status: string;
  weight: number;
  /** how many of these leads should also have a customer/booking behind them */
  winRate: number;
}

export const FUNNEL: StageSpec[] = [
  { status: 'NEW', weight: 34, winRate: 0 },
  { status: 'CONTACT_PENDING', weight: 12, winRate: 0 },
  { status: 'CONTACTED', weight: 16, winRate: 0 },
  { status: 'QUALIFIED', weight: 10, winRate: 0 },
  { status: 'FOLLOW_UP', weight: 14, winRate: 0 },
  { status: 'MEETING', weight: 7, winRate: 0 },
  { status: 'SITE_VISIT_1', weight: 6, winRate: 0 },
  { status: 'SITE_VISIT_2', weight: 4, winRate: 0 },
  { status: 'SITE_VISIT_3', weight: 3, winRate: 0.5 },
  { status: 'NEGOTIATION', weight: 5, winRate: 0.6 },
  { status: 'BOOKING', weight: 3, winRate: 0.7 },
  { status: 'DOCUMENT_COLLECTION', weight: 3, winRate: 0.7 },
  { status: 'DEAL_COMPLETED', weight: 6, winRate: 1 },
  { status: 'NOT_INTERESTED', weight: 7, winRate: 0 },
  { status: 'CALL_BACK_LATER', weight: 4, winRate: 0 },
  { status: 'LOST', weight: 4, winRate: 0 },
  { status: 'WRONG_NUMBER', weight: 3, winRate: 0 },
];

/** Ordering used to walk a lead's status history forward. */
export const PIPELINE_ORDER = [
  'NEW', 'CONTACT_PENDING', 'CONTACTED', 'QUALIFIED', 'FOLLOW_UP', 'MEETING',
  'SITE_VISIT_1', 'SITE_VISIT_2', 'SITE_VISIT_3', 'NEGOTIATION', 'BOOKING',
  'DOCUMENT_COLLECTION', 'DEAL_COMPLETED',
];

export const SOURCES: Array<[string, number]> = [
  ['FACEBOOK', 22], ['WHATSAPP', 18], ['INSTAGRAM', 12], ['WEBSITE', 10],
  ['NINE9ACRES', 9], ['MAGICBRICKS', 8], ['REFERRAL', 8], ['YOUTUBE_ADS', 7],
  ['REALESTATE_INDIA', 4], ['MANUAL', 2],
];

export const CAMPAIGNS: Record<string, string[]> = {
  FACEBOOK: ['Skyline Heights Launch', 'Whitefield Pre-launch', 'Skyline Fest 2026', 'Home Loan Offer'],
  INSTAGRAM: ['Skyline Heights Reel', 'Weekend Open House', 'Skyline Reveal'],
  YOUTUBE_ADS: ['Skyline Walkthrough', 'Greenview Explainer', 'Why Whitefield'],
  WHATSAPP: ['Click-to-WhatsApp', 'Save Our Number'],
  WEBSITE: ['Contact Form', 'Brochure Download', 'Site Visit Enquiry'],
  NINE9ACRES: ['9acres Listing', 'NRI Buyers'],
  MAGICBRICKS: ['MagicBricks Listing', 'Budget Homes'],
  REFERRAL: ['Customer Referral', 'Channel Partner', 'Family Referral'],
  REALESTATE_INDIA: ['REA Inquiry', 'Local Listing'],
  MANUAL: ['Walk-in', 'Call Enquiry'],
};

export const REQUIREMENTS = [
  '2 BHK, ready to move, with covered parking',
  '3 BHK east facing, possession within a year',
  '2.5 BHK for investment, rental yield matters most',
  '4 BHK villa with private pool, lake preferred',
  '3 BHK near metro line, family move-in',
  '2 BHK compact, first home purchase',
  'Commercial office suite, ground or first floor',
  '3 BHK + servant room, vastu compliant',
  'Penthouse with terrace, top floor only',
  '2 BHK plot in an approved layout',
  'Budget under 60L, no loan',
  'Home loan pre-approved, needs immediate possession',
];

export const OBJECTIONS = [
  'Price is slightly over budget, asked for 5% discount',
  'Wants to compare with two other projects before deciding',
  'Waiting on home loan sanction from HDFC',
  'Currently renting, agreement ends in 3 months',
  'Spouse wants to visit before any commitment',
  'Concerned about possession timeline slippage',
  'Asked about carpet vs built-up area',
  'Wants to know resale liquidity in the area',
  'Requested payment schedule split',
  'Not decided on final unit, prefers higher floor',
];

export const NOTES = [
  'Wants to see the sample flat before anything else.',
  'Responded well to the WhatsApp brochure, asked about maintenance charges.',
  'Called twice, no answer. Marking as call back later.',
  'Referred by an existing customer in the same tower.',
  'Budget confirmed on WhatsApp. Ready for a site visit this week.',
  'Requested a price comparison sheet against nearby projects.',
  'Loan pre-approved up to 80L. Loan sanction letter shared.',
  'Very responsive on WhatsApp, slow on calls.',
  'Asked for the payment plan in writing before the next visit.',
  'Said they will decide after Diwali.',
];

export const TAG_POOL = [
  'hot', 'nri', 'pre-approved', 'first-home', 'investment', 'family', 'corporate',
  'referral', 'broker-assisted', 'price-sensitive', 'urgent', 'site-visit-done',
  'loan-pending', 'decision-maker', 'follow-up-today', 'vip',
];

export const OPENING_MESSAGE = [
  'Hi, I saw your ad for Skyline Heights. Is the 2 BHK still available?',
  'Hello, I am looking for a 3 BHK in Whitefield, budget around 1 Cr. Can you share options?',
  'Can you share the brochure and payment plan for Greenview Residences?',
  'Interested in a 2 BHK. What is the current best price?',
  'I need a commercial office in Hebbal. Do you have anything ready?',
  'What are the charges per sqft for Skyline Heights?',
];

export const AI_SUMMARY_SEED = [
  'Enthusiastic about the layout, held back by price. Asked for a discount and a written payment plan. Home loan pre-approved for 80L.',
  'Reached on WhatsApp, sent brochure and floor plans. Wants to visit the sample flat before committing to a unit.',
  'Comparing against two competing projects. Price-sensitive; the discount and early-possession angle resonated most.',
  'Spouse is the decision maker and has not seen the site yet. Follow-up call agreed for the weekend.',
  'Investor looking at rental yield. Asked about tenant profile and the area\'s absorption rate.',
  'Straightforward enquiry with a firm budget. Ready for a site visit as soon as a slot opens.',
];

export const FOLLOWUP_NOTES = [
  'Called, spoke for 3 minutes. Interested, asked about availability.',
  'WhatsApp sent the revised price list.',
  'No response. Will try again tomorrow.',
  'Confirmed the site visit slot for Saturday morning.',
  'Discussed payment plan; sending the EMI calculator sheet.',
  'Left a voicemail.',
  'Asked for a site visit reschedule to next week.',
  'Shared the floor plan and parking details.',
];

export const VISIT_FEEDBACK = [
  'Liked the view and the clubhouse. Concerned about the kitchen layout. Asked for a revised quote.',
  'Very happy with the finish quality. Compared against two other projects, ours is the strongest build quality.',
  'Did not like the common area maintenance charge. Asked if it is negotiable at negotiation stage.',
  'Loved the sample flat layout. Requested the same layout on a higher floor with an east facing.',
  'Impressed by the clubhouse and pool. Sought clarification on the parking allocation.',
  'Felt the unit was slightly small for their family. Asked about the 3 BHK variant and price difference.',
  'Very satisfied. Asked about the possession date and the loan disbursal timeline.',
  'Concerned about traffic in the evening peak. Asked about the upcoming metro line.',
];

// ------------------------------------------------------------------
// Name / phone generation
// ------------------------------------------------------------------
export function makePersonName(rng: Rng): string {
  const first = rng.chance(0.5) ? rng.pick(FIRST_M) : rng.pick(FIRST_F);
  return `${first} ${rng.pick(LAST)}`;
}

/**
 * Indian mobile number: 10 digits starting 6-9. Deliberately unique per index
 * so the duplicate-detection demo has real signal to work on.
 */
export function makePhone(rng: Rng, salt: number): string {
  const head = rng.pick(['6', '7', '8', '9']);
  let tail = '';
  for (let i = 0; i < 9; i++) tail += rng.int(0, 9);
  return `+91 ${head}${salt.toString().padStart(2, '0')}${tail}`.replace(/(\+\d{2} )(\d{2})(\d{4})(\d{3})/, '$1$2 $3 $4');
}

export function emailForName(name: string, index: number): string {
  const clean = name.toLowerCase().replace(/[^a-z]+/g, '.');
  return `${clean}${index}@example.com`;
}

/** Indian PAN format: 5 letters, 4 digits, 1 letter. */
export function makePan(rng: Rng): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const pick = () => letters[rng.int(0, letters.length - 1)];
  return `${pick()}${pick()}${pick()}${pick()}${pick()}${rng.int(1000, 9999)}${pick()}`;
}
