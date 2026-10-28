import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { BusinessError, instant, type Draft, type ScheduleItem, type ScheduleRequest } from './domain.js';

/** Confirmations are deliberately excluded: adding user consent upgrades the same draft. */
function fingerprint(request: ScheduleRequest): string {
  const items = request.items.map(item => ({
    materialId: item.materialId, channel: item.channel,
    requestedAt: instant(item.requestedAt), hardTime: item.hardTime,
  })).sort((a, b) => a.materialId.localeCompare(b.materialId));
  return createHash('sha256').update(JSON.stringify(items)).digest('hex');
}

export class DraftStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS requests (
        request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES requests(request_id),
        materialId TEXT NOT NULL, channel TEXT NOT NULL,
        requestedAt TEXT NOT NULL, suggestedAt TEXT NOT NULL,
        instant TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('confirmed', 'pending_confirmation')),
        UNIQUE(request_id, materialId)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS confirmed_channel_slot
        ON drafts(channel, instant) WHERE status = 'confirmed';
    `);
  }

  close(): void { this.db.close(); }

  list(): Draft[] {
    return this.db.prepare('SELECT id, materialId, channel, requestedAt, suggestedAt, status FROM drafts ORDER BY rowid')
      .all() as unknown as Draft[];
  }

  registerRequest(request: ScheduleRequest): void {
    const hash = fingerprint(request);
    this.db.prepare('INSERT OR IGNORE INTO requests(request_id, fingerprint) VALUES (?, ?)').run(request.requestId, hash);
    const row = this.db.prepare('SELECT fingerprint FROM requests WHERE request_id = ?').get(request.requestId);
    if (row?.fingerprint !== hash) throw new BusinessError('IDEMPOTENCY_CONFLICT', 'The requestId was already used with different base items');
  }

  isOccupied(channel: string, at: string, requestId: string, materialId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM drafts WHERE channel = ? AND instant = ? AND status = 'confirmed'
      AND NOT (request_id = ? AND materialId = ?)`).get(channel, instant(at), requestId, materialId);
  }

  /** BEGIN IMMEDIATE serializes the live checks and write across database connections. */
  save(request: ScheduleRequest, item: ScheduleItem, suggestedAt: string, status: Draft['status'],
    validateLive: () => void): { draft: Draft; duplicate: boolean } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.registerRequest(request);
      validateLive();
      const old = this.db.prepare(`SELECT id, materialId, channel, requestedAt, suggestedAt, status
        FROM drafts WHERE request_id = ? AND materialId = ?`).get(request.requestId, item.materialId) as unknown as Draft | undefined;
      if (old?.status === 'confirmed' && instant(old.suggestedAt) !== instant(suggestedAt)) {
        throw new BusinessError('DRAFT_ALREADY_CONFIRMED', 'An already confirmed draft cannot be rescheduled through an idempotent save');
      }
      if (old?.status === 'confirmed' || (old && instant(old.suggestedAt) === instant(suggestedAt) && old.status === status)) {
        this.db.exec('COMMIT');
        return { draft: old, duplicate: true };
      }
      if (this.isOccupied(item.channel, suggestedAt, request.requestId, item.materialId)) {
        throw new BusinessError('SLOT_CONFLICT', 'The suggested channel/time is already reserved; query slots again', true);
      }
      const draft: Draft = {
        id: old?.id ?? randomUUID(), materialId: item.materialId, channel: item.channel,
        requestedAt: old?.requestedAt ?? item.requestedAt, suggestedAt, status,
      };
      if (old) {
        this.db.prepare('UPDATE drafts SET suggestedAt = ?, instant = ?, status = ? WHERE id = ?')
          .run(suggestedAt, instant(suggestedAt), status, old.id);
      } else {
        this.db.prepare(`INSERT INTO drafts(id, request_id, materialId, channel, requestedAt, suggestedAt, instant, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(draft.id, request.requestId, item.materialId,
          item.channel, item.requestedAt, suggestedAt, instant(suggestedAt), status);
      }
      this.db.exec('COMMIT');
      return { draft, duplicate: false };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
