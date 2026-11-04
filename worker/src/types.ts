/// <reference types="@cloudflare/workers-types" />

import type { ResumeDecision, ResumeReport } from './resume';

export interface Env {
  BUCKET: R2Bucket;
  DB: D1Database;
  COURT_CAMERA: DurableObjectNamespace;
  ASSETS: Fetcher;
  RETENTION_DAYS: string;
  /** Shared device secret. When unset, device-endpoint auth is disabled. */
  DEVICE_TOKEN?: string;
  /**
   * Cloudflare Email Sending. Optional on purpose: it needs an onboarded sending
   * domain, and until that exists the notifier must degrade to logging rather
   * than throwing inside the cron that also runs retention.
   */
  EMAIL?: { send(message: Record<string, unknown>): Promise<unknown> };
  /** Where alerts go. Free to send to, as a verified destination address. */
  ALERT_TO?: string;
  /**
   * Sender address. For Cloudflare Email Sending it must be on a domain
   * onboarded to the account; for Resend, leave it as their onboarding domain
   * until you verify one of your own.
   */
  ALERT_FROM?: string;
  /**
   * When set, alerts go via Resend instead of the Cloudflare binding. Exists
   * because Email Sending needs a domain on the account, which a *.workers.dev
   * deployment may not have -- unset it to switch back, no code change.
   */
  RESEND_API_KEY?: string;
  /**
   * Fine-grained PAT scoped to this repo only (issues, contents, pull requests).
   * Absent means production errors are emailed for a human instead of
   * investigated -- which is the correct degradation, not a broken state.
   */
  GITHUB_TOKEN?: string;
  /** "owner/name" of the repo the fixer works in. */
  GITHUB_REPO?: string;
}

export type RecordingStatus =
  | 'recording'
  | 'uploading'
  | 'ready'
  | 'expired'
  | 'failed';

export interface Recording {
  id: string;
  court_id: string;
  status: RecordingStatus;
  upload_id: string | null;
  object_key: string | null;
  bytes: number;
  purchased: number; // 0 | 1 — forward-compat hook for the payments phase
  started_at: number;
  stopped_at: number | null;
  created_at: number;
  /** Why this recording failed, when it did. NULL on every healthy row. */
  error: string | null;
  /** R2 key of the first-frame JPEG, or NULL when none was produced. */
  thumbnail_key: string | null;
  /**
   * Renewed by the agent's heartbeat while it still holds unsent parts on disk.
   * The stale sweep honours it, which is what stops a Pi buffering through a
   * network outage from returning to a multipart upload the sweep destroyed.
   */
  agent_claimed_at: number | null;
  /** 0 | 1 — capture was sealed early because the disk budget ran out. */
  truncated: number;
  /** Usable, but suspect (short for its duration, say). NULL when healthy. */
  warning: string | null;
  /** Shared by every segment of one match. NULL on rows predating segments. */
  session_id: string | null;
  /** 1-based position within the session; a power cut starts the next one. */
  segment: number;
  /**
   * When the operator pressed stop. Stamped before the command is relayed, so a
   * Pi returning from a power cut can tell that the match is already over.
   */
  stop_requested_at: number | null;
}

/**
 * The only legal transitions. `updateRecordingStatus` refuses anything not
 * listed here, which is what makes the state machine one-way in fact and not
 * just in the comments: a `failed` row can no longer be dragged back into
 * `uploading` by a stop command that arrives after the capture already died.
 */
export const STATUS_TRANSITIONS: Record<RecordingStatus, readonly RecordingStatus[]> = {
  recording: ['uploading', 'ready', 'failed'],
  uploading: ['ready', 'failed'],
  ready: ['expired'],
  expired: [],
  failed: [],
};

export interface Court {
  id: string;
  name: string | null;
  /**
   * Last value written by the DO's connect/close path. Not trustworthy on its
   * own — a Pi that loses power never sends a close, so this stays 1 forever.
   * Read presence through `isOnline()` instead, which also requires a recent
   * heartbeat.
   */
  online: number; // 0 | 1
  last_seen: number | null;
  created_at: number;
  /** NULL until a super-admin assigns the court. Unassigned courts belong to nobody. */
  venue_id: string | null;
  /** Version the agent reported on connect; NULL for a Pi on pre-heartbeat code. */
  agent_version: string | null;
  /** Latest `CourtHealth` from the heartbeat, as JSON. NULL until one arrives. */
  health_json: string | null;
  /**
   * Recordings STARTED before this are free to players; later ones are locked.
   * NULL means no paywall has been set and every recording is free.
   */
  free_until: number | null;
  /** What the court's QR sticker points at (/c/<qr_token>). NULL until printed. */
  qr_token: string | null;
}

/**
 * One match started from the court (or by staff). Owns the end time and the
 * private link; its recordings are the segments sharing `session_id`.
 */
export interface Match {
  session_id: string;
  court_id: string;
  /** The link's secret. The only way a player reaches this match's footage. */
  token: string;
  /** The end time chosen at start. Never moves. */
  booked_until: number;
  /** When auto-stop fires. */
  ends_at: number;
  started_by: 'player' | 'staff';
  created_at: number;
}

/**
 * Whether a player may have this recording without paying. Judged by when the
 * match started, so flipping the switch never takes back a video already handed
 * out -- and `purchased` wins regardless, which is the hook the payments phase
 * fills in.
 */
export function isFree(
  rec: Pick<Recording, 'started_at' | 'purchased'>,
  court: Pick<Court, 'free_until'> | null,
): boolean {
  if (rec.purchased === 1) return true;
  if (!court || court.free_until === null) return true;
  return rec.started_at < court.free_until;
}

/** What players did with a recording. See migration 0006 for why it is anonymous. */
export type RecordingEventKind =
  | 'view'
  | 'download'
  | 'locked_view'
  | 'admin_download'
  /** The starter tapped "Send to your group" -- the link left the browser. */
  | 'share';

/** Telemetry a camera reports with each heartbeat. Every field is best-effort. */
export interface CourtHealth {
  /** Free bytes on the spool filesystem. */
  diskFreeBytes?: number;
  /** Fraction of the recording's disk budget currently used, 0..1. */
  diskBudgetUsed?: number;
  /** Parts captured but not yet uploaded, across all sessions on disk. */
  pendingParts?: number;
  pendingBytes?: number;
  /** SoC temperature in °C, and the Pi's throttling bitmask. */
  tempC?: number;
  throttled?: string;
  uptimeSec?: number;
}

/** How often the agent sends `{type:'heartbeat'}` while connected. */
export const HEARTBEAT_MS = 30_000;

/**
 * Presence expires after three missed heartbeats. This is the whole fix for
 * "court-1 has been online since March": nothing has to notice the camera
 * left, because online is computed from `last_seen` on every read rather than
 * latched by an event that a dead Pi never sends.
 */
export const PRESENCE_TTL_MS = 3 * HEARTBEAT_MS;

export function isOnline(
  court: Pick<Court, 'online' | 'last_seen' | 'agent_version'>,
  now = Date.now(),
): boolean {
  if (court.online !== 1) return false;
  // No compatibility branch here any more. It used to trust the stored flag for
  // a court reporting no version, which meant `padel-club-court-1` read online
  // for twelve hours after it fell off the network -- the exact bug presence
  // expiry was added to fix. A court that does not heartbeat is offline, and a
  // Pi on pre-heartbeat code IS effectively offline: it cannot be commanded.
  return court.last_seen !== null && now - court.last_seen < PRESENCE_TTL_MS;
}

export interface Venue {
  id: string;
  name: string;
  created_at: number;
  /** IANA zone the booking grid is in. Workers run in UTC. */
  timezone: string;
  /** Length of the club's booking slots; end times are offered on this grid. */
  slot_minutes: number;
}

export interface Admin {
  id: string;
  venue_id: string;
  email: string;
  password_hash: string;
  created_at: number;
  /** 0 | 1. Grantable only by worker/scripts/grant-super.mjs, never over HTTP. */
  is_superadmin: number;
}

export interface Session {
  token: string;
  admin_id: string;
  expires_at: number;
  created_at: number;
}

export interface ShareLink {
  token: string;
  recording_id: string;
  created_by: string | null;
  expires_at: number | null;
  revoked: number; // 0 | 1
  created_at: number;
}

/** A completed R2 multipart part, reported by the camera agent. */
export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/**
 * A command before the relay stamps it with a commandId. `Omit` over a union
 * distributes into something unusable here, so the input shape is spelled out.
 */
export type CameraCommandInput =
  | { type: 'start'; recordingId: string; sessionId: string | null; segment: number }
  | { type: 'stop'; recordingId: string };

/** Commands the Worker/DO push down to a connected camera over the WebSocket. */
export type CameraCommand =
  | { type: 'start'; recordingId: string; sessionId: string | null; segment: number; commandId: string }
  | { type: 'stop'; recordingId: string; commandId: string }
  /** Answer to a heartbeat. Its absence is how the agent detects a half-open socket. */
  | { type: 'heartbeat-ack' }
  /** What to do with each segment a returning camera reported in `hello`. */
  | { type: 'resume-plan'; items: ResumeDecision[] };

/** Messages a camera sends up over the WebSocket. */
export type CameraMessage =
  | { type: 'status'; recordingId: string; patch: Partial<Recording> }
  /**
   * Sent once on connect. `resume` declares every segment still spooled on the
   * Pi, which is how a camera returning from a power cut hands the decision --
   * finish it, throw it away, or carry on recording -- back to the server.
   */
  | { type: 'hello'; version: string; resume?: ResumeReport[] }
  /**
   * Liveness, every HEARTBEAT_MS. Also what keeps the venue's NAT flow open.
   * `claims` renews the lease on recordings the camera still holds bytes for,
   * without which the stale sweep would abort the upload mid-outage.
   */
  | { type: 'heartbeat'; claims?: string[]; health?: CourtHealth }
  /**
   * Confirms the agent actually received a command. `ws.send()` succeeding
   * proves nothing about a half-open socket, so start waits for this before
   * reporting success to the operator.
   */
  | { type: 'ack'; commandId: string; ok: boolean; error?: string };

export const EXPENSE_CATEGORIES = [
  'hardware',
  'cloud',
  'software',
  'services',
  'legal',
  'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** A company purchase (migration 0009). Raw D1 row, as the API returns it. */
export interface Expense {
  id: string;
  /** Purchase date, YYYY-MM-DD. A calendar date, not a timestamp. */
  date: string;
  vendor: string;
  description: string;
  category: ExpenseCategory;
  /** EUR incl. VAT, integer cents; negative for a refund. */
  amount_cents: number;
  /** ISO 4217 code when paid in another currency; NULL when EUR. */
  currency_original: string | null;
  amount_original_cents: number | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}
