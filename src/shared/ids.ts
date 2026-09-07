import { randomBytes, randomUUID } from 'node:crypto';
const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
export function squadId(): string {
  return Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}
export const messageId = () => `m_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
export const provisionalId = (agent: string) => `${agent}:prov-${randomUUID()}`;
export const safeSid = (sid: string) => Buffer.from(sid).toString('base64url');
