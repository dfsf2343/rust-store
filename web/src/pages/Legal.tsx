import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { PageHeader } from '../components/bits';
import { useStore } from '../data';

function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  const { site } = useStore();
  return (
    <div className="container page page--narrow legal">
      <PageHeader title={title}>
        <p className="muted">Last updated {site.legal.lastUpdated}</p>
      </PageHeader>
      {children}
    </div>
  );
}

export function Terms() {
  const { site } = useStore();
  const { operatorName, contactEmail } = site.legal;
  return (
    <LegalPage title="Terms of service">
      <p>
        These terms cover the {site.name} website and store. {operatorName} runs {site.name}, a community Rust server. {site.name} is not affiliated with or endorsed by Facepunch
        Studios. By entering the access password, signing in or buying anything you agree to these terms, the <Link to="/refunds">refund policy</Link> and the{' '}
        <Link to="/rules">server rules</Link>.
      </p>
      <h2>Who can use the store</h2>
      <p>
        The website and store are only for players authorized by the {site.name} staff. Purchases by anyone else are prohibited: the access is removed and the order is not refunded,
        except where the law requires it. Do not share the access password.
      </p>
      <h2>Your account</h2>
      <p>You either sign in with Steam or enter a SteamID64 or Steam profile link at checkout. Each purchase is tied to that Steam account and cannot be moved to another one, so check it before paying. A kit sent to the wrong account because of a mistyped ID is not refunded.</p>
      <h2>What you are buying</h2>
      <p>
        A kit purchase gives your Steam account the right to claim that kit in game on our server, once per cooldown, for the access length you chose. Kits are virtual items with no cash
        value. They cannot be resold, traded for real money or exchanged for currency. Lifetime access lasts for as long as we operate the server and store.
      </p>
      <h2>Delivery</h2>
      <p>
        Access starts automatically once the payment provider confirms your payment, usually within a minute. You claim kits in game with the chat command shown on your account page.
        Buying the same kit again adds the new access time after your current access ends.
      </p>
      <h2>All sales are final</h2>
      <p>
        Every purchase is final and non-refundable. The only exception is an internal problem on our server that stops you from receiving or using what you bought, as described in the{' '}
        <Link to="/refunds">refund policy</Link>.
      </p>
      <h2>Changes to the server</h2>
      <p>
        Rust is a live game. We may change kit contents, cooldowns, gameplay settings and the wipe schedule, and Facepunch updates can change items. Map and blueprint wipes remove items
        you have already claimed. None of this is a reason for a refund. If we permanently close the server, active access ends with it.
      </p>
      <h2>Rules and bans</h2>
      <p>Buying a kit does not exempt anyone from the rules. If you are banned for breaking them you lose access to purchased kits without a refund.</p>
      <h2>Payments</h2>
      <p>
        Payments are processed by Stripe and show on card statements as CC DIGITAL. We never see or store your full card details. Prices are in US dollars; your bank may add its
        own conversion fees. Stripe and your card issuer may also apply their own buyer-protection rules.
      </p>
      <h2>Chargebacks</h2>
      <p>
        Contact the staff before opening a chargeback or payment dispute. A chargeback removes the access bought with that payment and can block the account from future purchases.
      </p>
      <h2>Age</h2>
      <p>If you are under 18, you need permission from a parent or guardian to buy.</p>
      <h2>No warranty</h2>
      <p>
        The server and store are provided as they are. We work to keep them online but do not guarantee uptime. To the extent the law allows, our liability for any purchase is limited
        to the amount you paid for it.
      </p>
      <h2>Security logs</h2>
      <p>
        To protect the store and stop fraud we record visits, password attempts, sign-ins and purchases, with the IP address, approximate location, network, browser and a
        device identifier stored in a cookie. Staff can see these records.
      </p>
      <h2>Governing law</h2>
      <p>
        These terms are governed by the laws of the United States and of the U.S. state where {operatorName} is registered, without regard to conflict-of-law rules. Any dispute is
        handled in the courts of that state, to the extent the law allows.
      </p>
      <h2>Immediate delivery</h2>
      <p>
        Kits are digital content delivered right after payment. By buying you ask for immediate delivery and accept that, once the kit is delivered, you lose any right to cancel or
        withdraw from the purchase.
      </p>
      <h2>Changes to these terms</h2>
      <p>We may update these terms. The version shown when you buy applies to that purchase.</p>
      <h2>Contact</h2>
      <p>
        Questions about these terms: <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
      </p>
    </LegalPage>
  );
}

export function Refunds() {
  const { site } = useStore();
  const { contactEmail } = site.legal;
  return (
    <LegalPage title="Refund policy">
      <p>
        <strong>All purchases are final and non-refundable.</strong>
      </p>
      <h2>The only exception</h2>
      <p>
        We refund only when an internal problem on our server stops you from receiving or using what you bought, for example a kit that never reached your account because of an error on
        our side. Staff check each case. If the problem is confirmed we either fix the delivery or refund the purchase.
      </p>
      <h2>Not a reason for a refund</h2>
      <ul>
        <li>Changing your mind after buying.</li>
        <li>Wipes, game updates, or changes to kits, cooldowns or server settings.</li>
        <li>Bans or other action taken for breaking the server rules.</li>
        <li>Buying while not being an authorized member of the server.</li>
        <li>Entering the wrong SteamID or Steam profile link at checkout.</li>
      </ul>
      <h2>How to report a problem</h2>
      <p>
        Email <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
        {site.links.discord && (
          <>
            {' '}
            or open a ticket on <a href={site.links.discord}>Discord</a>
          </>
        )}{' '}
        within 14 days of the purchase. Include the order ID from your account page and the Steam account you used.
      </p>
      <h2>If a refund is approved</h2>
      <p>Refunds go back to the original payment method. The kit access bought with that payment is removed as soon as the refund is processed.</p>
      <h2>Governing law</h2>
      <p>
        This policy is governed by the laws of the United States, as set out in the <Link to="/terms">terms of service</Link>.
      </p>
    </LegalPage>
  );
}

export function Privacy() {
  const { site } = useStore();
  const { operatorName, contactEmail } = site.legal;
  return (
    <LegalPage title="Privacy policy">
      <p>This policy explains what {operatorName} collects when you use the {site.name} website and store, and why.</p>
      <h2>What we collect</h2>
      <ul>
        <li>Your SteamID64, plus your Steam display name and avatar when you sign in with Steam.</li>
        <li>Orders: the kit, duration, amount, payment provider and the provider's reference numbers.</li>
        <li>Your IP address and the country it maps to, used to offer the right payment methods and to prevent fraud.</li>
        <li>When you claim kits in game, so cooldowns work across server restarts.</li>
      </ul>
      <p>
        Card and bank details are entered on Stripe, PayPal or Mercado Pago pages and handled under their own privacy policies. We receive confirmation that a payment succeeded, not your
        full card number.
      </p>
      <h2>Cookies</h2>
      <p>We use one cookie to keep you signed in and a short-lived cookie during Steam sign-in. There are no advertising or tracking cookies.</p>
      <h2>How we use it</h2>
      <p>To deliver kits, provide support, prevent fraud and chargeback abuse, enforce the server rules and meet legal and accounting obligations. We do not sell your data.</p>
      <h2>Who we share it with</h2>
      <p>Only the services needed to run the store: Steam for sign-in, the payment provider that handles your payment, and our hosting provider.</p>
      <h2>How long we keep it</h2>
      <p>Sign-in sessions expire after 30 days. Order records are kept as long as needed for accounting, tax and dispute purposes.</p>
      <h2>Your choices</h2>
      <p>
        You can ask for a copy of your data or for it to be deleted by emailing <a href={`mailto:${contactEmail}`}>{contactEmail}</a>. Some order records may be kept where the law requires it.
      </p>
      <h2>Children</h2>
      <p>The store is not directed at children under 13, and we do not knowingly collect their data.</p>
    </LegalPage>
  );
}
