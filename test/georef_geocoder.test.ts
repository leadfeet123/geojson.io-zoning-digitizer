/* eslint-disable @typescript-eslint/require-await */
import {
  buildJurisdictionSearchQueries,
  DefaultGeorefGeocoder,
  findIntersectionsFromOsmWays,
  parseStreetSignature,
  type OsmRoadWay
} from 'app/lib/georef_geocoder';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('georef_geocoder', () => {
  it('normalizes street names, ordinals, saint prefixes, and highway route numbers', () => {
    const springfield = parseStreetSignature('W. Springfield Ave.');
    expect(springfield[0].core).toBe('springfield');
    expect(springfield[0].direction).toBe('w');
    expect(springfield[0].roadType).toBe('ave');

    const saintCharles = parseStreetSignature('Saint Charles Road');
    const stCharles = parseStreetSignature('St. Charles Rd');
    expect(saintCharles[0].core).toBe('st charles');
    expect(stCharles[0].core).toBe('st charles');

    const firstSt = parseStreetSignature('North First Street');
    expect(firstSt[0].core).toBe('1st');

    const usHwy = parseStreetSignature('S Neil St (US-45)');
    expect(usHwy.some((s) => s.core === 'neil')).toBe(true);
    expect(
      usHwy.some((s) =>
        s.routes.some((r) => r.network === 'us' && r.number === '45')
      )
    ).toBe(true);
  });

  it('finds exact shared-node, geometric crossing, and divided-boulevard intersections', () => {
    const ways: OsmRoadWay[] = [
      // Divided E-W boulevard (two parallel carriageways ~16m apart around lat 40.1125 / 40.11264)
      {
        id: 1,
        nodes: [101, 102, 103],
        tags: { name: 'West Springfield Avenue', ref: 'IL 10' },
        geometry: [
          { lon: -88.25, lat: 40.1125 },
          { lon: -88.2434, lat: 40.1125 },
          { lon: -88.235, lat: 40.1125 }
        ]
      },
      {
        id: 2,
        nodes: [201, 202, 203],
        tags: { name: 'West Springfield Avenue', ref: 'IL 10' },
        geometry: [
          { lon: -88.25, lat: 40.11264 },
          { lon: -88.2434, lat: 40.11264 },
          { lon: -88.235, lat: 40.11264 }
        ]
      },
      // N-S arterial sharing nodes 102 and 202
      {
        id: 3,
        nodes: [301, 102, 202, 304],
        tags: { name: 'South Neil Street', ref: 'US 45' },
        geometry: [
          { lon: -88.2434, lat: 40.108 },
          { lon: -88.2434, lat: 40.1125 },
          { lon: -88.2434, lat: 40.11264 },
          { lon: -88.2434, lat: 40.118 }
        ]
      },
      // Grade-separated interstate crossing Neil St without a shared node
      {
        id: 4,
        nodes: [401, 402],
        tags: { ref: 'I 74' },
        geometry: [
          { lon: -88.255, lat: 40.116 },
          { lon: -88.23, lat: 40.116 }
        ]
      }
    ];

    const matches = findIntersectionsFromOsmWays(ways, [
      { id: 'q1', street1: 'W Springfield Ave', street2: 'S Neil St' },
      { id: 'q2', street1: 'Interstate 74', street2: 'US-45' }
    ]);

    const q1Hits = matches.get('q1');
    expect(q1Hits).toBeDefined();
    expect(q1Hits).toHaveLength(1); // Clustered into a single divided-intersection midpoint
    expect(q1Hits![0].lon).toBeCloseTo(-88.2434, 5);
    expect(q1Hits![0].lat).toBeCloseTo(40.11257, 5);

    const q2Hits = matches.get('q2');
    expect(q2Hits).toBeDefined();
    expect(q2Hits).toHaveLength(1);
    expect(q2Hits![0].lon).toBeCloseTo(-88.2434, 5);
    expect(q2Hits![0].lat).toBeCloseTo(40.116, 5);
  });

  it('builds clean jurisdiction search queries stripping zoning boilerplate', () => {
    const queries = buildJurisdictionSearchQueries({
      municipality: 'Official Zoning Map - Village of Oak Park',
      county: 'Cook County',
      state: 'IL',
      country: 'USA'
    });

    expect(queries[0]).toBe('Village of Oak Park, Cook County, IL, USA');
    expect(queries).toContain('Oak Park, Cook County, IL, USA');
  });

  it('disambiguates jurisdiction by state abbreviation and resolves Overpass intersections', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (new URL(url).hostname === 'nominatim.openstreetmap.org') {
        return {
          ok: true,
          json: async () => [
            // Wrong state (Springfield, MO) listed first with higher importance
            {
              lat: '37.2089',
              lon: '-93.2923',
              display_name: 'Springfield, Greene County, Missouri, USA',
              class: 'place',
              importance: 0.85,
              boundingbox: ['37.10', '37.30', '-93.40', '-93.18']
            },
            // Correct state (Springfield, IL) matching state: 'IL'
            {
              lat: '39.7990',
              lon: '-89.6439',
              display_name: 'Springfield, Sangamon County, Illinois, USA',
              class: 'boundary',
              importance: 0.78,
              boundingbox: ['39.70', '39.88', '-89.75', '-89.55']
            }
          ]
        } as Response;
      }

      if (url.includes('overpass')) {
        return {
          ok: true,
          json: async () => ({
            elements: [
              {
                id: 10,
                nodes: [1, 2],
                tags: { name: 'East Capitol Avenue' },
                geometry: [
                  { lon: -89.66, lat: 39.798 },
                  { lon: -89.64, lat: 39.798 }
                ]
              },
              {
                id: 11,
                nodes: [3, 4],
                tags: { name: 'South 5th Street' },
                geometry: [
                  { lon: -89.649, lat: 39.79 },
                  { lon: -89.649, lat: 39.805 }
                ]
              }
            ]
          })
        } as Response;
      }

      return { ok: false, status: 404 } as Response;
    });

    const geocoder = new DefaultGeorefGeocoder('');
    const jurisdiction = await geocoder.resolveJurisdiction({
      municipality: 'City of Springfield',
      state: 'IL',
      country: 'USA'
    });

    expect(jurisdiction).not.toBeNull();
    expect(jurisdiction!.displayName).toContain('Illinois');
    expect(jurisdiction!.center.lon).toBeCloseTo(-89.6439, 3);

    const intersections = await geocoder.resolveIntersections(
      [{ id: 'lm1', street1: 'E Capitol Ave', street2: 'S Fifth St' }],
      jurisdiction!
    );

    expect(intersections.get('lm1')?.[0].lon).toBeCloseTo(-89.649, 5);
    expect(intersections.get('lm1')?.[0].lat).toBeCloseTo(39.798, 5);
  });
});
