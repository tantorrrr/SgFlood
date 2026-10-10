import { checkObservedAt, checkEditObservedAt, editBlock, isLate, isWithdrawn, observedMs } from './reports.js';
import { reportEvent, groupCells, HISTORY_DAYS } from './cells.js';
import { withTrust } from './trust.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const RATE = { minGapMs: MINUTE, perHour: 10, latePerDay: 3 };
const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
// Recent reports: 48 h of late reporting + up to 36 h of TTL/fade, so the 48 h-back timeline shows them.
export const RECENT_MS = 96 * HOUR;
export const HISTORY_MS = HISTORY_DAYS * 24 * HOUR;
const KEY_PREFIX = 'hcmflood.';

export class StoreError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function isRateLimited(myCreatedTimes, now) {
  const recent = myCreatedTimes.filter((t) => now - t < HOUR);
  return recent.some((t) => now - t < RATE.minGapMs) || recent.length >= RATE.perHour;
}

export function isLateLimited(myLateCreatedTimes, now) {
  return myLateCreatedTimes.filter((t) => now - t < 24 * HOUR).length >= RATE.latePerDay;
}

const errorCode = (message = '') => ['rate_limited', 'late_limited', 'invalid_time', 'has_votes', 'edit_limit', 'withdrawn'].find((c) => message.includes(c)) ?? 'network';

export class LocalStore {
  constructor(storage, now = () => Date.now()) {
    this.storage = storage;
    this.now = now;
    this.mode = 'local';
  }

  async init() {
    this.userId = this.read('hcmflood.user') ?? crypto.randomUUID();
    this.write('hcmflood.user', this.userId);
  }

  read(key) {
    try {
      return JSON.parse(this.storage.getItem(key));
    } catch {
      return null;
    }
  }

  write(key, value) {
    try {
      this.storage.setItem(key, JSON.stringify(value));
    } catch {
      throw new StoreError('storage');
    }
  }

  async listReports({ sinceMs = this.now() - RECENT_MS } = {}) {
    return this.withVotes(sinceMs);
  }

  // Same shape as the Supabase view flood_cells incl. §19b trust (no post-event enrichment locally).
  async listCells(trustCfg) {
    const since = this.now() - HISTORY_MS;
    return groupCells(withTrust((await this.withVotes(since)).filter((r) => observedMs(r) >= since).map((r) => reportEvent(r)), trustCfg));
  }

  async exportAll() {
    return { reports: this.read('hcmflood.reports') ?? [], votes: this.read('hcmflood.votes') ?? [] };
  }

  subscribe(onChange) {
    globalThis.addEventListener?.('storage', (e) => e.key?.startsWith(KEY_PREFIX) && onChange());
  }

  withVotes(sinceMs) {
    const votes = this.read('hcmflood.votes') ?? [];
    return (this.read('hcmflood.reports') ?? [])
      .filter((r) => Date.parse(r.created_at) >= sinceMs && !isWithdrawn(r))
      .map((r) => {
        const mine = votes.filter((v) => v.report_id === r.id);
        return {
          ...r,
          confirms: mine.filter((v) => v.value === 1).length,
          denies: mine.filter((v) => v.value === -1).length,
          myVote: mine.find((v) => v.user_id === this.userId)?.value ?? 0,
        };
      });
  }

  async createReport({ lat, lng, level, snapshot = null, observedAt = null }) {
    const reports = this.read('hcmflood.reports') ?? [];
    const now = this.now();
    const observed = observedAt == null ? now : checkObservedAt(observedAt, now);
    if (observed == null) throw new StoreError('invalid_time');
    const mine = reports.filter((r) => r.user_id === this.userId);
    if (isRateLimited(mine.map((r) => Date.parse(r.created_at)), now)) throw new StoreError('rate_limited');
    const report = {
      id: crypto.randomUUID(), lat, lng, level, snapshot,
      created_at: new Date(now).toISOString(), observed_at: new Date(observed).toISOString(), user_id: this.userId,
    };
    if (isLate(report) && isLateLimited(mine.filter(isLate).map((r) => Date.parse(r.created_at)), now)) throw new StoreError('late_limited');
    this.write('hcmflood.reports', [...reports.filter((r) => now - Date.parse(r.created_at) < HISTORY_MS), report]);
    return report;
  }

  // Mirrors the server UPDATE trigger. observedAt is required (ms); snapshot undefined = keep.
  async editReport(id, { lat, lng, level, observedAt, snapshot }) {
    const reports = this.read('hcmflood.reports') ?? [];
    const report = this.ownReport(reports, id);
    const votes = (this.read('hcmflood.votes') ?? []).filter((v) => v.report_id === id);
    const block = editBlock({ ...report, confirms: votes.length });
    if (block) throw new StoreError(block);
    const observed = checkEditObservedAt(observedAt, report);
    if (observed == null) throw new StoreError('invalid_time');
    const now = this.now();
    const next = {
      ...report, lat, lng, level, snapshot: snapshot === undefined ? report.snapshot : snapshot,
      observed_at: new Date(observed).toISOString(), edited_at: new Date(now).toISOString(), edit_count: (report.edit_count ?? 0) + 1,
    };
    const lateOthers = reports.filter((r) => r.user_id === this.userId && r.id !== id && isLate(r));
    if (isLate(next) && !isLate(report) && isLateLimited(lateOthers.map((r) => Date.parse(r.created_at)), now)) throw new StoreError('late_limited');
    this.write('hcmflood.reports', reports.map((r) => (r === report ? next : r)));
    return next;
  }

  // Soft delete: hidden from map/analogs, kept (flagged) in export. Allowed even with votes.
  async withdrawReport(id) {
    const reports = this.read('hcmflood.reports') ?? [];
    const report = this.ownReport(reports, id);
    if (isWithdrawn(report)) return;
    this.write('hcmflood.reports', reports.map((r) => (r === report ? { ...r, withdrawn_at: new Date(this.now()).toISOString() } : r)));
  }

  ownReport(reports, id) {
    const report = reports.find((r) => r.id === id);
    if (!report) throw new StoreError('not_found');
    if (report.user_id !== this.userId) throw new StoreError('not_owner');
    return report;
  }

  async vote(reportId, value) {
    const report = (this.read('hcmflood.reports') ?? []).find((r) => r.id === reportId);
    if (!report) throw new StoreError('not_found');
    if (report.user_id === this.userId) throw new StoreError('own_report');
    const all = this.read('hcmflood.votes') ?? [];
    const prev = all.find((v) => v.report_id === reportId && v.user_id === this.userId);
    const votes = all.filter((v) => v !== prev);
    const now = new Date().toISOString();
    votes.push({ report_id: reportId, user_id: this.userId, value, created_at: prev?.created_at ?? now, updated_at: now });
    this.write('hcmflood.votes', votes);
  }
}

export class SupabaseStore {
  // getCaptcha(siteKey) → token; injected so tests need no DOM (main.js passes captcha.js captchaToken).
  constructor(url, anonKey, { turnstileSiteKey = '', getCaptcha = null } = {}) {
    this.url = url;
    this.anonKey = anonKey;
    this.siteKey = turnstileSiteKey;
    this.getCaptcha = getCaptcha;
    this.mode = 'supabase';
    this.userId = null;
  }

  async init() {
    const { createClient } = await import(SUPABASE_ESM);
    this.client = createClient(this.url, this.anonKey);
    const { data: { session } } = await this.client.auth.getSession();
    if (session) { this.userId = session.user.id; return; }
    if (!this.siteKey) return this.signIn(); // no captcha: unchanged behaviour (failure → caller falls back to local)
    // §19a captcha runs in the background: an interactive challenge must not hold up the map/timeline.
    // Until it resolves the store is read-only; failure leaves authError (report/vote offer a retry via signIn()).
    this.ready = this.signIn().catch((err) => {
      this.authError = err;
      throw err;
    });
  }

  // Anonymous sign-in, with a Turnstile token when a site key is configured.
  async signIn() {
    let options;
    if (this.siteKey) {
      try {
        options = { captchaToken: await this.getCaptcha(this.siteKey) };
      } catch {
        throw new StoreError('captcha');
      }
    }
    const { data, error } = await this.client.auth.signInAnonymously(options ? { options } : undefined);
    if (error) throw new StoreError(this.siteKey ? 'captcha' : 'auth');
    this.userId = data.session.user.id;
    this.authError = null;
  }

  // Writes wait for an in-flight background sign-in instead of failing while the captcha is still running.
  async requireAuth() {
    if (!this.userId && this.ready) await this.ready.catch(() => {});
    if (!this.userId) throw new StoreError('captcha');
  }

  async listReports({ sinceMs = Date.now() - RECENT_MS } = {}) {
    const since = new Date(sinceMs).toISOString();
    const [reports, votes] = await Promise.all([
      this.client.from('reports_with_votes').select('*').gte('created_at', since),
      this.userId ? this.client.from('votes').select('report_id,value').eq('user_id', this.userId).gte('created_at', since) : { data: [] },
    ]);
    if (reports.error || votes.error) throw new StoreError('network');
    const myVotes = new Map(votes.data.map((v) => [v.report_id, v.value]));
    return reports.data.map((r) => ({ ...r, myVote: myVotes.get(r.id) ?? 0 }));
  }

  // §18: valid reports + news_reports per ~150 m cell over 730 days, aggregated server-side.
  async listCells() {
    const { data, error } = await this.client.from('flood_cells').select('*');
    if (error) throw new StoreError('network');
    return data;
  }

  async exportAll() {
    const since = new Date(Date.now() - HISTORY_MS).toISOString();
    const [reports, votes] = await Promise.all([
      this.client.from('reports').select('*').gte('created_at', since),
      this.client.from('votes').select('*').gte('created_at', since),
    ]);
    if (reports.error || votes.error) throw new StoreError('network');
    return { reports: reports.data, votes: votes.data };
  }

  subscribe(onChange) {
    const channel = this.client.channel('flood-reports');
    for (const table of ['reports', 'votes']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, onChange);
    }
    channel.subscribe();
  }

  async createReport({ lat, lng, level, snapshot = null, observedAt = null }) {
    await this.requireAuth();
    const row = { lat, lng, level, snapshot };
    if (observedAt != null) row.observed_at = new Date(observedAt).toISOString();
    const { data, error } = await this.client.from('reports').insert(row).select().single();
    if (error) throw new StoreError(errorCode(error.message));
    return data;
  }

  async editReport(id, { lat, lng, level, observedAt, snapshot }) {
    await this.requireAuth();
    const row = { lat, lng, level, observed_at: new Date(observedAt).toISOString() };
    if (snapshot !== undefined) row.snapshot = snapshot;
    const { data, error } = await this.client.from('reports').update(row).eq('id', id).select().single();
    if (error) throw new StoreError(errorCode(error.message));
    return data;
  }

  // The trigger replaces this value with now(); the client only flags the withdrawal.
  async withdrawReport(id) {
    await this.requireAuth();
    const { error } = await this.client.from('reports').update({ withdrawn_at: new Date().toISOString() }).eq('id', id);
    if (error) throw new StoreError(errorCode(error.message));
  }

  async vote(reportId, value) {
    await this.requireAuth();
    const { error } = await this.client
      .from('votes')
      .upsert({ report_id: reportId, user_id: this.userId, value }, { onConflict: 'report_id,user_id' });
    if (error) throw new StoreError(error.code === '42501' ? 'own_report' : 'network');
  }
}

export function createStore(config, storage, getCaptcha = null) {
  return config.supabaseUrl && config.supabaseAnonKey
    ? new SupabaseStore(config.supabaseUrl, config.supabaseAnonKey, { turnstileSiteKey: config.turnstileSiteKey, getCaptcha })
    : new LocalStore(storage);
}
