// fork(salvare): lesson progress. See README.md.
import { ProgressAccessChecker } from './progress-access';
import { ProgressKnexRepository } from './progress-knex-repository';
import { ProgressService } from './progress-service';

// Constructed by init() at boot. The members API controller holds this module and
// reads `.service` per request. Under the dev/test loader (tsx) this compiles to a
// getter-only export, so tests can't assign to it — stub the module instead.
export let service: ProgressService | undefined;

export function init(): void {
  if (service) {
    return;
  }

  const db = require('../../data/db');
  const membersService = require('../members');

  const repository = new ProgressKnexRepository({ knex: db.knex });

  // Every dependency below is a lazy closure: boot runs this before members.init(),
  // so membersService.api does not exist yet, and services/drip is required on use
  // to stay clear of the post-gating import chain.
  const checker = new ProgressAccessChecker({
    loadMember: (id) => membersService.api.memberBREADService.read({ id }, { metafieldsFor: null }),
    loadPosts: (ids) => repository.getPublishedPosts(ids),
    checkPostAccess: (post, member) => membersService.contentGating.checkPostAccess(post, member),
    evaluateDrip: (post, member, opts) => require('../drip').evaluate(post, member, opts),
  });

  service = new ProgressService({ repository, checker });
}
