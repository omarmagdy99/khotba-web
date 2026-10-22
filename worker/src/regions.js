export const REGION_ACCESS = ['15may', 'tebeen', 'both'];

export function canAccessRegion(access, region) {
  return access === 'both' || access === region;
}
