import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { serviceFields } from './service-fields.ts';

// Runtime-only private data must never be collected into a deployment bundle.
const directory = () => resolve(/* turbopackIgnore: true */ process.env.SERVICE_VAULT_DIR || './data/private');
function key() {
  mkdirSync(directory(), { recursive: true, mode: 0o700 });
  const path = resolve(directory(), 'vault.key');
  if (!existsSync(path)) {
    try { writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  }
  return readFileSync(path);
}
export function seal(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(v => v.toString('base64url')).join('.');
}
export function unseal<T>(value: string): T {
  const [iv, tag, data] = value.split('.').map(v => Buffer.from(v, 'base64url'));
  const cipher = createDecipheriv('aes-256-gcm', key(), iv);
  cipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString());
}
function read(): Record<string, string> {
  const path = resolve(directory(), 'services.enc');
  return existsSync(path) ? unseal(readFileSync(path, 'utf8')) : {};
}
function productionHealthRedirect(value: string) {
  if (process.env.NODE_ENV !== 'production') return value;
  if (value && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/api\/health\/callback$/i.test(value)) return value;
  const origin = process.env.APP_ORIGIN || (process.env.SITE_DOMAIN ? `https://${process.env.SITE_DOMAIN}` : '');
  try { return origin ? new URL('/api/health/callback', origin).toString() : value; }
  catch { return value; }
}
function runtimeValue(name: string, value: string) {
  return name === 'GOOGLE_HEALTH_REDIRECT_URI' ? productionHealthRedirect(value) : value;
}
function write(saved: Record<string, string>) {
  const target = resolve(directory(), 'services.enc');
  const temporary = target + '.' + randomBytes(6).toString('hex');
  writeFileSync(temporary, seal(saved), { mode: 0o600 });
  renameSync(temporary, target);
}
export function serviceValue(name: string) { return runtimeValue(name, read()[name] ?? process.env[name] ?? ''); }
export function serviceStatus() {
  const saved = read();
  return serviceFields.map(f => {
    const raw = saved[f.key] ?? process.env[f.key] ?? '';
    const value = runtimeValue(f.key, raw);
    return { ...f, configured: Boolean(value), value: f.secret ? '' : value, source: f.key in saved ? 'website' : raw ? 'environment' : value ? 'deployment' : 'none' };
  });
}
export function saveServiceValues(values: Record<string, unknown>) {
  const saved = read();
  for (const [name, value] of Object.entries(values)) {
    if (!serviceFields.some(f => f.key === name) || typeof value !== 'string' || value.length > 8192) throw new Error('INVALID_CONFIG');
    saved[name] = value.trim();
  }
  write(saved);
}
export function savePrivateServiceValue(name: 'OWNER_PASSWORD_HASH', value: string) {
  const saved = read();
  saved[name] = value;
  write(saved);
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const configured=process.env.APP_ORIGIN || (process.env.SITE_DOMAIN ? `https://${process.env.SITE_DOMAIN}` : '');
  if(configured){try{return origin===new URL(configured).origin;}catch{return false;}}
  if(process.env.NODE_ENV==='production')return false;
  const url=new URL(request.url),host=request.headers.get('host');
  return Boolean(origin && (origin===url.origin || (host&&origin===`${url.protocol}//${host}`)));
}
