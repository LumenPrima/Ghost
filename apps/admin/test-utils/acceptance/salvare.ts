// fork(salvare): boots the app against a Salvare fork backend.
import { configResponse, type ConfigResponse } from '@tryghost/test-data';

import type { BootOverrides } from './boot';

/**
 * Config boot response carrying the fork capability key (`config.salvare`).
 * The default boot config has no such key, so specs that don't opt in run the
 * stock UI.
 */
export function salvareConfigResponse(): ConfigResponse {
  const response = configResponse();
  response.config.salvare = { purchases: true };
  return response;
}

/**
 * Boot overrides switching the fork's purchase surfaces on. Combines with the
 * `labs` render option. Spread and extend when a spec needs further overrides:
 * `renderAdminApp(route, {boot: salvareBootOverrides()})`.
 */
export function salvareBootOverrides(): BootOverrides {
  return {
    browseConfig: { response: salvareConfigResponse() },
  };
}
