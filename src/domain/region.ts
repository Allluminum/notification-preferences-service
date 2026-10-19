import { DomainError } from './errors.js';

/**
 * Regulatory regions used by global policies. A closed set on purpose:
 * policies are compliance rules, so a typo in a region must fail loudly instead of silently never matching.
 */
export const REGIONS = ['EU', 'UK', 'US', 'CA', 'LATAM', 'APAC', 'MEA', 'RU'] as const;
export type Region = (typeof REGIONS)[number];

export const isRegion = (value: string): value is Region =>
  (REGIONS as readonly string[]).includes(value);

export const parseRegion = (value: string): Region => {
  const normalized = value.trim().toUpperCase();
  if (!isRegion(normalized)) {
    throw new DomainError(
      'invalid_region',
      `Unknown region "${value}". Expected one of: ${REGIONS.join(', ')}`,
    );
  }
  return normalized;
};
