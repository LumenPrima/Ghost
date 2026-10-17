// fork(salvare)
import { describe, expect, it } from 'vitest';
import type { Config } from '@tryghost/admin-x-framework/api/config';

import { getSalvareCapabilities } from './use-salvare-capabilities';

const config = (extra: Partial<Config>) => ({ ...extra }) as Config;

describe('getSalvareCapabilities', () => {
  it('reads salvare.purchases', () => {
    expect(getSalvareCapabilities(config({ salvare: { purchases: true } }))).toEqual({
      purchases: true,
    });
  });

  it('is all false on a stock backend, a missing config or a malformed key', () => {
    expect(getSalvareCapabilities(undefined)).toEqual({ purchases: false });
    expect(getSalvareCapabilities(config({}))).toEqual({ purchases: false });
    expect(getSalvareCapabilities(config({ salvare: true }))).toEqual({ purchases: false });
    expect(getSalvareCapabilities(config({ salvare: { purchases: 'yes' } }))).toEqual({
      purchases: false,
    });
  });
});
