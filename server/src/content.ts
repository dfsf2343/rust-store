import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const ProviderIdSchema = z.enum(['stripe', 'paypal', 'mercadopago']);
const CountryCode = z.string().regex(/^[A-Z]{2}$/, 'Use two-letter ISO country codes in upper case');
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'Use lower-case letters, digits and dashes (max 32)');
const Shortname = z.string().regex(/^[a-z0-9._-]{2,64}$/, 'Rust item shortnames are lower-case, for example rifle.ak');

export const ItemCategories = [
  'weapon',
  'ammo',
  'attachment',
  'armor',
  'clothing',
  'medical',
  'food',
  'tool',
  'resource',
  'building',
  'explosive',
  'misc',
] as const;

const KitItemSchema = z.object({
  shortname: Shortname,
  name: z.string().min(1).max(64),
  amount: z.number().int().min(1).max(1_000_000),
  category: z.enum(ItemCategories).default('misc'),
});

const DurationSchema = z.object({
  id: Slug,
  label: z.string().min(1).max(32),
  days: z.number().int().min(1).max(3650).nullable(),
  multiplier: z.number().positive().max(100),
  default: z.boolean().optional(),
  badge: z.string().max(24).optional(),
});

const KitSchema = z.object({
  id: Slug,
  name: z.string().min(1).max(40),
  tier: z.number().int().min(1).max(10),
  basePrice: z.number().positive().max(10_000),
  cooldownHours: z.number().min(0).max(24 * 30),
  tagline: z.string().max(160).default(''),
  prices: z.record(z.string(), z.number().positive().max(100_000)).optional(),
  hidden: z.boolean().optional(),
  items: z.array(KitItemSchema).min(1).max(60),
});

const CatalogSchema = z
  .object({
    currency: z.literal('USD'),
    durations: z.array(DurationSchema).min(1).max(8),
    kits: z.array(KitSchema).min(1).max(50),
  })
  .superRefine((c, ctx) => {
    const durationIds = new Set<string>();
    for (const d of c.durations) {
      if (durationIds.has(d.id)) ctx.addIssue({ code: 'custom', message: `Duplicate duration id ${d.id}` });
      durationIds.add(d.id);
    }
    if (c.durations.filter((d) => d.default).length > 1) {
      ctx.addIssue({ code: 'custom', message: 'Only one duration can be marked as default' });
    }
    const kitIds = new Set<string>();
    for (const k of c.kits) {
      if (kitIds.has(k.id)) ctx.addIssue({ code: 'custom', message: `Duplicate kit id ${k.id}` });
      kitIds.add(k.id);
      for (const key of Object.keys(k.prices ?? {})) {
        if (!durationIds.has(key)) ctx.addIssue({ code: 'custom', message: `Kit ${k.id} has a price for unknown duration ${key}` });
      }
    }
  });

const WipeSlotSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24h HH:MM'),
});

const SiteSchema = z.object({
  name: z.string().min(1).max(48),
  shortName: z.string().min(1).max(24),
  tagline: z.string().max(120),
  description: z.string().max(400),
  region: z.string().max(40),
  connect: z.object({ address: z.string().min(3).max(120) }),
  links: z.object({
    discord: z.url().nullable(),
    steamGroup: z.url().nullable(),
  }),
  wipe: z.object({
    timezone: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown IANA time zone'),
    slots: z.array(WipeSlotSchema).max(14),
    label: z.string().max(80),
  }),
  highlights: z.array(z.object({ label: z.string().max(24), value: z.string().max(24) })).max(8),
  features: z.array(z.object({ title: z.string().max(60), body: z.string().max(300) })).max(8),
  rules: z.array(z.object({ title: z.string().max(60), items: z.array(z.string().max(300)).max(20) })).max(12),
  faq: z.array(z.object({ q: z.string().max(160), a: z.string().max(800) })).max(30),
  legal: z.object({
    operatorName: z.string().min(1).max(80),
    contactEmail: z.email(),
    lastUpdated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  store: z.object({
    inGameCommand: z.string().regex(/^[a-z0-9_]{1,24}$/),
    itemIconUrl: z
      .string()
      .refine((v) => v.includes('{shortname}') && /^https:\/\//.test(v), 'Must be an https URL containing {shortname}')
      .nullable(),
  }),
});

const PaymentsSchema = z.object({
  routing: z.object({
    rules: z
      .array(
        z.object({
          name: z.string().min(1).max(40),
          countries: z.array(CountryCode).min(1),
          providers: z.array(ProviderIdSchema).min(1),
        }),
      )
      .max(20),
    default: z.array(ProviderIdSchema).min(1),
  }),
  stripe: z.object({
    automaticTax: z.boolean().default(false),
    allowPromotionCodes: z.boolean().default(false),
  }),
  paypal: z.object({
    brandName: z.string().max(127).nullable().default(null),
  }),
  mercadopago: z.object({
    currency: z.enum(['CLP', 'ARS', 'BRL', 'COP', 'MXN', 'PEN', 'UYU']),
    usdRate: z.number().positive(),
    roundTo: z.number().positive().default(1),
    statementDescriptor: z.string().max(22).nullable().default(null),
  }),
});

export type Catalog = z.infer<typeof CatalogSchema>;
export type Kit = Catalog['kits'][number];
export type KitItem = Kit['items'][number];
export type Duration = Catalog['durations'][number];
export type SiteContent = z.infer<typeof SiteSchema>;
export type PaymentsConfig = z.infer<typeof PaymentsSchema>;

export interface Content {
  site: SiteContent;
  catalog: Catalog;
  payments: PaymentsConfig;
  /** Stable hash of everything the game plugin needs from the catalog. */
  catalogVersion: string;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read ${file}: ${(err as Error).message}`);
  }
}

function validate<T>(name: string, raw: unknown, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid ${name}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export function pluginKitDefinitions(catalog: Catalog) {
  return catalog.kits.map((k) => ({
    id: k.id,
    name: k.name,
    cooldownSeconds: Math.round(k.cooldownHours * 3600),
    items: k.items.map((i) => ({ shortname: i.shortname, amount: i.amount })),
  }));
}

export interface RawContent {
  site: unknown;
  catalog: unknown;
  payments: unknown;
}

export function loadContent(configDir: string): Content {
  return parseContent({
    site: readJson(path.join(configDir, 'site.json')),
    catalog: readJson(path.join(configDir, 'catalog.json')),
    payments: readJson(path.join(configDir, 'payments.json')),
  });
}

/** Validates the three config files. Cloudflare builds pass the JSON bundled at build time. */
export function parseContent(raw: RawContent): Content {
  const site = validate('site.json', raw.site, SiteSchema);
  const catalog = validate('catalog.json', raw.catalog, CatalogSchema);
  const payments = validate('payments.json', raw.payments, PaymentsSchema);
  const catalogVersion = crypto
    .createHash('sha256')
    .update(JSON.stringify(pluginKitDefinitions(catalog)))
    .digest('hex')
    .slice(0, 16);
  return { site, catalog, payments, catalogVersion };
}

export function findKit(content: Content, kitId: string): Kit | undefined {
  return content.catalog.kits.find((k) => k.id === kitId);
}

export function findDuration(content: Content, durationId: string): Duration | undefined {
  return content.catalog.durations.find((d) => d.id === durationId);
}

/** Price in USD cents for a kit and duration. */
export function priceCents(kit: Kit, duration: Duration): number {
  const override = kit.prices?.[duration.id];
  const dollars = override ?? kit.basePrice * duration.multiplier;
  return Math.round(dollars * 100);
}
