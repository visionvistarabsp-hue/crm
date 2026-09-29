import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { projects } from '@/lib/db/schema';

export interface ProjectMatchCandidate {
  id: string;
  code: string;
  name: string;
  location: string;
  city: string;
  state: string;
  description: string | null;
  amenities: string[] | null;
  priceRangeMin: string | number | null;
  priceRangeMax: string | number | null;
}

export interface ProjectMatchInput {
  preferredLocation?: string | null;
  requirement?: string | null;
  propertyType?: string | null;
  budget?: string | number | null;
  /** A project named directly on the ad or form, which always wins. */
  explicitProject?: string | null;
}

export interface ProjectMatch {
  projectId: string;
  projectName: string;
  projectCode: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  score: number;
  /** Human-readable trail so an agent can see why this project was picked. */
  reason: string;
}

/**
 * Below this the only signal was a weak token overlap, which produces a
 * confidently wrong assignment more often than a useful one.
 */
const MIN_SCORE = 40;
/**
 * Two projects this close together means the evidence genuinely cannot
 * separate them. Leaving the lead unassigned is recoverable; filing it under
 * the wrong project is not.
 */
const AMBIGUITY_MARGIN = 8;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'at', 'for', 'to', 'near', 'by', 'with', 'from',
  'is', 'are', 'want', 'looking', 'need', 'about', 'my', 'me', 'i', 'we', 'interested',
]);

function normalise(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() : '';
}

function tokens(value: unknown): string[] {
  return normalise(value)
    .split(' ')
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.replace(/[^\d.]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Whole-word containment, so "Noida" matches "Noida Sec 45" but not "Noidax". */
function containsWord(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/**
 * Prefix-tolerant token match. Real answers are plural ("apartments",
 * "villas", "plots") while the form field usually carries a singular or an
 * abbreviation, so exact word matching would miss the most common case.
 */
function tokenPresent(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const list = haystack.split(' ');
  if (list.some((t) => t === needle)) return true;
  if (needle.length < 4) return false;
  return list.some((t) => t.startsWith(needle) && t.length > needle.length);
}

function scoreCandidate(
  candidate: ProjectMatchCandidate,
  input: ProjectMatchInput,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const haystack = normalise(
    [candidate.name, candidate.location, candidate.city, candidate.state, candidate.description, (candidate.amenities ?? []).join(' ')].join(' '),
  );
  const nameHaystack = normalise(candidate.name);
  const locationHaystack = normalise([candidate.location, candidate.city, candidate.state].join(' '));

  // 1. The ad named the project. This is the marketer telling us directly.
  const explicit = normalise(input.explicitProject);
  if (explicit) {
    const code = normalise(candidate.code);
    if (code && (explicit === code || containsWord(explicit, code))) {
      score += 100;
      reasons.push(`ad named project code ${candidate.code}`);
    } else if (nameHaystack && containsWord(explicit, nameHaystack)) {
      score += 100;
      reasons.push(`ad named ${candidate.name}`);
    } else if (containsWord(nameHaystack, explicit)) {
      score += 100;
      reasons.push(`${candidate.name} matched the project named in the ad`);
    }
  }

  // 2. The project name is written out in the requirement text.
  const requirement = normalise(input.requirement);
  if (requirement && nameHaystack && containsWord(requirement, nameHaystack)) {
    score += 60;
    reasons.push(`requirement mentions ${candidate.name}`);
  }

  // 3. The preferred locality is the city itself.
  const preferred = normalise(input.preferredLocation);
  const city = normalise(candidate.city);
  let exactLocationHit = false;
  if (preferred && city && preferred === city) {
    score += 45;
    exactLocationHit = true;
    reasons.push(`preferred location is ${candidate.city}`);
  }

  // 4. The preferred locality is contained in, or contains, the project location.
  if (preferred && locationHaystack && !exactLocationHit) {
    if (containsWord(locationHaystack, preferred)) {
      score += 40;
      exactLocationHit = true;
      reasons.push(`${candidate.location} is in ${input.preferredLocation}`);
    } else if (containsWord(preferred, locationHaystack)) {
      score += 40;
      exactLocationHit = true;
      reasons.push(`preferred location ${input.preferredLocation} covers ${candidate.location}`);
    }
  }

  // 5. Token overlap, as a partial-credit signal for a locality spelled slightly
  //    differently from the project record. Skipped when the exact branches
  //    already fired, otherwise the same locality gets paid for twice.
  if (preferred && !exactLocationHit) {
    const wanted = tokens(preferred);
    if (wanted.length) {
      const available = new Set(tokens(locationHaystack));
      const hits = wanted.filter((t) => available.has(t));
      if (hits.length) {
        const partial = Math.min(30, hits.length * 10);
        score += partial;
        reasons.push(`location words matched: ${hits.join(', ')}`);
      }
    }
  }

  // 6. Budget compatibility only breaks ties; it is never enough on its own,
  //    because "under 2 crore" matches every project in the city.
  const budget = toNumber(input.budget);
  const min = toNumber(candidate.priceRangeMin);
  const max = toNumber(candidate.priceRangeMax);
  if (budget !== null && (min !== null || max !== null)) {
    if ((min === null || budget >= min) && (max === null || budget <= max)) {
      score += 15;
      reasons.push('budget sits inside the project price range');
    } else {
      score -= 10;
    }
  }

  // 7. Property type is a weak signal; "apartment" fits most inventory.
  const type = normalise(input.propertyType);
  if (type && tokenPresent(haystack, type)) {
    score += 10;
    reasons.push(`${type} appears in the project details`);
  }

  return { score, reasons };
}

function confidenceFor(score: number): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (score >= 70) return 'HIGH';
  if (score >= 50) return 'MEDIUM';
  return 'LOW';
}

/**
 * Pick the single project a lead belongs to, or null when the evidence is
 * absent or genuinely tied. Pure so the ladder can be tested without a database.
 */
export function matchProject(
  candidates: ProjectMatchCandidate[],
  input: ProjectMatchInput,
): ProjectMatch | null {
  const scored = candidates
    .map((candidate) => ({ candidate, ...scoreCandidate(candidate, input) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name));

  if (scored.length === 0) return null;

  const best = scored[0];
  if (best.score < MIN_SCORE) return null;

  const runnerUp = scored[1];
  if (runnerUp && best.score - runnerUp.score < AMBIGUITY_MARGIN) return null;

  return {
    projectId: best.candidate.id,
    projectName: best.candidate.name,
    projectCode: best.candidate.code,
    confidence: confidenceFor(best.score),
    score: best.score,
    reason: best.reasons.join('; '),
  };
}

/**
 * Load the sellable projects and run the matcher. Inactive inventory is
 * excluded because filing a new lead under a sold-out project sends the agent
 * chasing something that cannot be booked.
 */
export async function matchProjectForLead(input: ProjectMatchInput): Promise<ProjectMatch | null> {
  let candidates: ProjectMatchCandidate[] = [];
  try {
    const rows = await db
      .select({
        id: projects.id,
        code: projects.code,
        name: projects.name,
        location: projects.location,
        city: projects.city,
        state: projects.state,
        description: projects.description,
        amenities: projects.amenities,
        priceRangeMin: projects.priceRangeMin,
        priceRangeMax: projects.priceRangeMax,
        status: projects.status,
      })
      .from(projects)
      .where(and(inArray(projects.status, ['ACTIVE', 'UPCOMING'])));
    candidates = rows as ProjectMatchCandidate[];
  } catch {
    return null;
  }

  return matchProject(candidates, input);
}
