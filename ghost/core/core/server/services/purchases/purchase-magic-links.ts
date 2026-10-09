export interface MagicLinkAttribution {
  id: string | null;
  type: string | null;
  url: string | null;
}

export interface PurchaseMagicLinks {
  getSignupLink(
    email: string,
    attribution: MagicLinkAttribution,
    referrer: string,
  ): Promise<string>;
  getSigninLink(email: string, referrer: string): Promise<string>;
  sendSigninEmail(email: string): Promise<void>;
}

interface MembersApi {
  getMagicLink(
    email: string,
    type: 'signin' | 'signup',
    tokenData?: Record<string, unknown>,
  ): Promise<string>;
  sendEmailWithMagicLink(options: { email: string; requestedType: 'signin' }): Promise<unknown>;
}

/**
 * Magic links through the members API. getMagicLink takes no referrer, so the
 * `r` search param is set here, as MembersConfigProvider.getSigninURL would.
 */
export class MembersApiMagicLinks implements PurchaseMagicLinks {
  private readonly getMembersApi: () => MembersApi;

  constructor({ getMembersApi }: { getMembersApi: () => MembersApi }) {
    this.getMembersApi = getMembersApi;
  }

  async getSignupLink(
    email: string,
    attribution: MagicLinkAttribution,
    referrer: string,
  ): Promise<string> {
    const link = await this.getMembersApi().getMagicLink(email, 'signup', { attribution });

    return withReferrer(link, referrer);
  }

  async getSigninLink(email: string, referrer: string): Promise<string> {
    const link = await this.getMembersApi().getMagicLink(email, 'signin');

    return withReferrer(link, referrer);
  }

  async sendSigninEmail(email: string): Promise<void> {
    await this.getMembersApi().sendEmailWithMagicLink({ email, requestedType: 'signin' });
  }
}

function withReferrer(link: string, referrer: string): string {
  const url = new URL(link);
  url.searchParams.set('r', referrer);

  return url.toString();
}
