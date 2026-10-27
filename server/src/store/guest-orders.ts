/**
 * Lets a buyer who did not sign in with Steam see their own orders on the same browser.
 * The cookie lists recent order ids, each signed with a key kept in the database.
 */
import crypto from 'node:crypto';
import type { DB } from '../db.js';
import { getMeta, setMeta } from '../db.js';

export const GUEST_ORDERS_COOKIE = 'rs_orders';
const MAX_ORDERS = 10;

function key(db: DB): string {
  let k = getMeta(db, 'guest_order_key');
  if (!k) {
    k = crypto.randomBytes(32).toString('hex');
    setMeta(db, 'guest_order_key', k);
  }
  return k;
}

function sign(db: DB, orderId: string): string {
  return crypto.createHmac('sha256', key(db)).update(`order:${orderId}`).digest('base64url').slice(0, 32);
}

function entries(value: string | undefined): string[] {
  return (value ?? '').split('~').filter((e) => /^ord_[A-Za-z0-9_-]{8,40}\.[A-Za-z0-9_-]{32}$/.test(e));
}

export function guestOwns(db: DB, cookie: string | undefined, orderId: string): boolean {
  const expected = Buffer.from(`${orderId}.${sign(db, orderId)}`);
  return entries(cookie).some((e) => {
    const given = Buffer.from(e);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

/** New cookie value with this order added (newest first). */
export function addGuestOrder(db: DB, cookie: string | undefined, orderId: string): string {
  return [`${orderId}.${sign(db, orderId)}`, ...entries(cookie)].slice(0, MAX_ORDERS).join('~');
}
