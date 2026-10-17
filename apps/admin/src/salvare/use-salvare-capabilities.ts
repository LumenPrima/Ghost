// fork(salvare): feature detection for the Salvare fork's Admin surfaces.
import { type Config, useBrowseConfig } from '@tryghost/admin-x-framework/api/config';

export interface SalvareCapabilities {
  /** One-time tier purchases: the tier editor's pricing mode and the member Purchases panel. */
  purchases: boolean;
}

/**
 * Reads `config.salvare` (core `public-config/config.js`). A stock Ghost backend
 * has no such key, so every capability is false there.
 */
export function getSalvareCapabilities(config: Config | undefined): SalvareCapabilities {
  const salvare = config?.salvare;
  const isObject = typeof salvare === 'object' && salvare !== null && !Array.isArray(salvare);

  return {
    purchases: isObject && 'purchases' in salvare && salvare.purchases === true,
  };
}

/** All capabilities are false while the config is loading or failed to load. */
export function useSalvareCapabilities(): SalvareCapabilities {
  const { data } = useBrowseConfig();
  return getSalvareCapabilities(data?.config);
}
