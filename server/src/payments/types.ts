import type { ProviderId } from '../config.js';
import type { Duration, Kit } from '../content.js';
import type { OrderRow } from '../store/orders.js';

export interface CheckoutInput {
  order: OrderRow;
  kit: Kit;
  duration: Duration;
}

export interface CheckoutResult {
  providerRef: string;
  redirectUrl: string;
}

export interface ChargeQuote {
  /** Minor units of `currency`. */
  amount: number;
  currency: string;
}

export interface PaymentProvider {
  readonly id: ProviderId;
  /** Short label shown on the checkout button. */
  readonly label: string;
  /** One line describing the accepted methods. */
  readonly description: string;
  quote(amountCents: number): ChargeQuote;
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
  /** Asks the provider for the current payment state and applies it to the order. */
  refresh(order: OrderRow, hint?: { paymentId?: string | null }): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    public readonly provider: ProviderId,
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}
