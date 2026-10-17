import { promises as fs } from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';
import {
  getSubject,
  renderText,
  type PurchaseAccessEmailData,
} from './email-templates/purchase-access';

const DEFAULT_ACCENT_COLOR = '#15212A';

interface TransactionalMailer {
  send(message: {
    to: string;
    subject: string;
    html: string;
    text: string;
    from: string;
    replyTo: string;
    forceTextContent: boolean;
    disableTracking?: boolean;
  }): Promise<unknown>;
}

interface SettingsCache {
  get(key: string, options?: unknown): string | undefined;
}

interface UrlUtils {
  getSiteUrl(): string;
}

interface BlogIcon {
  getIconUrl(options: { absolute: boolean; fallbackToDefault: boolean }): string | null;
}

export interface AccessEmailData {
  toEmail: string;
  tierName: string;
  isNewMember: boolean;
  // Sign-in magic link; r = the tier welcome page or the site URL. Valid for 24 hours.
  accessUrl: string;
  amount: number;
  currency: string;
  // A staff grant: the copy says "You've been given access", with no amount and no thanks.
  granted?: boolean;
}

export interface PurchaseEmailServiceDeps {
  transactionalMailer: TransactionalMailer;
  settingsCache: SettingsCache;
  urlUtils: UrlUtils;
  getFromAddress: () => string;
  getReplyToAddress: () => string;
  blogIcon: BlogIcon;
}

/**
 * The buyer's "you now have access" email. English only for now; see
 * email-templates/purchase-access.ts.
 */
export class PurchaseEmailService {
  private readonly deps: PurchaseEmailServiceDeps;
  private readonly handlebars: typeof Handlebars;
  private template: Promise<HandlebarsTemplateDelegate> | undefined;

  constructor(deps: PurchaseEmailServiceDeps) {
    this.deps = deps;
    this.handlebars = Handlebars.create();
  }

  async sendAccessEmail(data: AccessEmailData): Promise<void> {
    const siteUrl = this.deps.urlUtils.getSiteUrl();
    const siteDomain = this.getSiteDomain(siteUrl);
    const templateData: PurchaseAccessEmailData = {
      siteTitle: this.deps.settingsCache.get('title') ?? siteDomain,
      siteUrl,
      siteIconUrl: this.deps.blogIcon.getIconUrl({ absolute: true, fallbackToDefault: false }),
      siteDomain,
      accentColor: this.deps.settingsCache.get('accent_color') || DEFAULT_ACCENT_COLOR,
      toEmail: data.toEmail,
      purchase: {
        tierName: data.tierName,
        isNewMember: data.isNewMember,
        accessUrl: data.accessUrl,
        amount: this.formatAmount(data.amount, data.currency),
        granted: data.granted === true,
      },
    };
    const template = await this.getTemplate();

    await this.deps.transactionalMailer.send({
      to: data.toEmail,
      subject: getSubject(templateData),
      html: template(templateData),
      text: renderText(templateData),
      from: this.deps.getFromAddress(),
      replyTo: this.deps.getReplyToAddress(),
      forceTextContent: true,
      disableTracking: true,
    });
  }

  private getTemplate(): Promise<HandlebarsTemplateDelegate> {
    if (!this.template) {
      this.template = fs
        .readFile(path.join(__dirname, './email-templates', 'purchase-access.hbs'), 'utf8')
        .then((source) => this.handlebars.compile(source));
      // Let a failed read be retried by the next send.
      this.template.catch(() => {
        this.template = undefined;
      });
    }

    return this.template;
  }

  private getSiteDomain(siteUrl: string): string {
    try {
      return new URL(siteUrl).hostname;
    } catch {
      return '';
    }
  }

  // Amounts are in minor units. Zero-decimal currencies are not special-cased
  // (known limitation, as in the staff emails).
  private formatAmount(amount: number, currency: string): string {
    try {
      return new Intl.NumberFormat('en', {
        style: 'currency',
        currency: currency.toUpperCase(),
      }).format(amount / 100);
    } catch {
      return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
    }
  }
}
