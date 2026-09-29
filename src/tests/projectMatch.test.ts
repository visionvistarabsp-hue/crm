import { describe, it, expect } from 'vitest';
import { matchProject, type ProjectMatchCandidate } from '@/lib/services/projectMatch';

function project(over: Partial<ProjectMatchCandidate> = {}): ProjectMatchCandidate {
  return {
    id: 'p1',
    code: 'GRN-01',
    name: 'Green Meadows',
    location: 'Sector 45, Gurugram',
    city: 'Gurugram',
    state: 'Haryana',
    description: '2 and 3 bedroom apartments near the metro',
    amenities: ['Clubhouse', 'Pool'],
    priceRangeMin: '8000000',
    priceRangeMax: '15000000',
    ...over,
  };
}

const candidates = [
  project(),
  project({
    id: 'p2',
    code: 'BLV-02',
    name: 'Blue Valley',
    location: 'Sector 76, Noida',
    city: 'Noida',
    state: 'Uttar Pradesh',
    description: '2 and 3 bedroom apartments in a green belt',
  }),
  project({
    id: 'p3',
    code: 'RIV-03',
    name: 'Riverside Heights',
    location: 'Marine Drive, Kochi',
    city: 'Kochi',
    state: 'Kerala',
    description: 'Waterfront villas and penthouses',
    amenities: ['Private dock'],
    priceRangeMin: '30000000',
    priceRangeMax: '60000000',
  }),
];

describe('matchProject', () => {
  it('assigns on an exact city match', () => {
    const match = matchProject(candidates, { preferredLocation: 'Gurugram' });
    expect(match?.projectCode).toBe('GRN-01');
    expect(match?.reason).toContain('preferred location is Gurugram');
  });

  it('assigns when the preferred locality is inside the project location', () => {
    const match = matchProject(candidates, { preferredLocation: 'Sector 76' });
    expect(match?.projectCode).toBe('BLV-02');
  });

  it('matches a project named in the requirement text', () => {
    const match = matchProject(candidates, { requirement: 'We liked Riverside Heights during the site visit' });
    expect(match?.projectCode).toBe('RIV-03');
    expect(match?.reason).toContain('requirement mentions Riverside Heights');
  });

  it('lets a project named on the ad win over location inference', () => {
    const match = matchProject(candidates, { preferredLocation: 'Gurugram', explicitProject: 'RIV-03' });
    expect(match?.projectCode).toBe('RIV-03');
    expect(match?.confidence).toBe('HIGH');
    expect(match?.reason).toContain('project code RIV-03');
  });

  it('lets a project name on the ad win', () => {
    const match = matchProject(candidates, { preferredLocation: 'Gurugram', explicitProject: 'Blue Valley' });
    expect(match?.projectCode).toBe('BLV-02');
  });

  it('rates an ad-named project HIGH and an inferred one lower', () => {
    const explicit = matchProject(candidates, { explicitProject: 'GRN-01' });
    expect(explicit?.confidence).toBe('HIGH');

    const inferred = matchProject(candidates, { preferredLocation: 'Gurugram' });
    expect(inferred?.confidence).toBe('LOW');
  });

  it('declines when two projects score the same', () => {
    const tied = [
      project({ id: 'a', code: 'A-1', name: 'Alpha', location: 'Park Street, Pune', city: 'Pune' }),
      project({ id: 'b', code: 'B-2', name: 'Beta', location: 'Park Street, Pune', city: 'Pune' }),
    ];
    expect(matchProject(tied, { preferredLocation: 'Pune' })).toBeNull();
  });

  it('declines on a city that several projects share', () => {
    const busy = [
      project({ id: 'a', code: 'A-1', name: 'Alpha', location: 'Sector 1, Pune', city: 'Pune' }),
      project({ id: 'b', code: 'B-2', name: 'Beta', location: 'Sector 2, Pune', city: 'Pune' }),
    ];
    expect(matchProject(busy, { preferredLocation: 'Pune' })).toBeNull();
  });

  it('breaks a city tie once the budget separates the projects', () => {
    const busy = [
      project({
        id: 'a', code: 'A-1', name: 'Alpha', location: 'Sector 1, Pune', city: 'Pune',
        priceRangeMin: '8000000', priceRangeMax: '10000000',
      }),
      project({
        id: 'b', code: 'B-2', name: 'Beta', location: 'Sector 2, Pune', city: 'Pune',
        priceRangeMin: '30000000', priceRangeMax: '40000000',
      }),
    ];
    const match = matchProject(busy, { preferredLocation: 'Pune', budget: '35000000' });
    expect(match?.projectCode).toBe('B-2');
    expect(match?.reason).toContain('budget sits inside');
  });

  it('returns null when nothing matches', () => {
    expect(matchProject(candidates, { preferredLocation: 'Jaipur' })).toBeNull();
    expect(matchProject(candidates, {})).toBeNull();
    expect(matchProject(candidates, { requirement: 'no project info here' })).toBeNull();
  });

  it('returns null for an empty catalogue', () => {
    expect(matchProject([], { preferredLocation: 'Gurugram' })).toBeNull();
  });

  it('does not assign on budget alone', () => {
    expect(matchProject(candidates, { budget: '35000000' })).toBeNull();
  });

  it('rewards a property type that appears in the project details', () => {
    const match = matchProject(candidates, { preferredLocation: 'Gurugram', propertyType: 'apartment' });
    expect(match?.projectCode).toBe('GRN-01');
    expect(match?.reason).toContain('apartment appears in the project details');
  });

  it('ignores substring false positives between similar names', () => {
    const similar = [project({ name: 'Noidax Heights', location: 'Sector 150, Noida', city: 'Noida' })];
    expect(matchProject(similar, { preferredLocation: 'Noida' })).not.toBeNull();
    expect(matchProject(similar, { explicitProject: 'Noida' })).toBeNull();
  });

  it('is case and punctuation insensitive', () => {
    const match = matchProject(candidates, { preferredLocation: '  GURUGRAM  ' });
    expect(match?.projectCode).toBe('GRN-01');
  });
});

