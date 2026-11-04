/** Shapes returned by the Worker API. Mirrors worker/src/types.ts. */

export interface Venue {
  id: string;
  name: string;
}

/** A venue as the super-admin sees it, with its booking grid. */
export interface FleetVenue extends Venue {
  created_at: number;
  timezone: string;
  slot_minutes: number;
}

export interface SessionUser {
  email: string;
  venue: Venue;
  /**
   * Decides only whether the UI offers /super. Every super route re-checks the
   * flag server-side, so flipping this in devtools gets you an empty page.
   */
  isSuperadmin: boolean;
}

export interface Court {
  courtId: string;
  name: string | null;
  /** Derived from a recent heartbeat, not from a stored flag. */
  online: boolean;
  lastSeen: number | null;
  agentVersion: string | null;
  /** Recordings started before this are free to players. Null: no paywall set. */
  freeUntil: number | null;
}

export interface CourtsResponse {
  /**
   * Cameras belonging to the signed-in admin's venue — and only those. There is
   * no longer an `unassigned` list here: letting a club see and adopt any
   * unclaimed camera in the fleet was the bug, not the feature.
   */
  courts: Court[];
  /** End times on the venue's booking grid, soonest first. */
  endOptions: EndOption[];
}

export interface EndOption {
  at: number;
  /** "20:30" in the venue's local time. */
  label: string;
}

/** A court as the super-admin sees it, with its venue mapping exposed. */
export interface FleetCourt extends Court {
  venueId: string | null;
  venueName: string | null;
}

/** A non-terminal recording, flagged if the sweep would collect it now. */
export interface ActiveRecording extends Recording {
  stale: boolean;
}

/** A recording as the super-admin sees it, with its court's venue attached. */
export interface FleetRecording extends Recording {
  venue_id: string | null;
}

export interface FleetOverview {
  venues: FleetVenue[];
  courts: FleetCourt[];
  active: ActiveRecording[];
  /** Every recording in the fleet, newest first — including finished ones. */
  recordings: FleetRecording[];
  engagement: CourtEngagement[];
}

/** Whether players open and keep their videos, per court. All-time counts. */
export interface CourtEngagement {
  court_id: string;
  recordings: number;
  /** Recordings with at least one player download — the experiment's answer. */
  downloaded_recordings: number;
  views: number;
  downloads: number;
  /** Share pages opened for a recording past the free period. */
  locked_views: number;
  admin_downloads: number;
  /** Matches players started from the court's QR code. */
  player_matches: number;
  /** Of those, how many had their link sent on. */
  shared_matches: number;
}

export type RecordingStatus =
  | 'recording'
  | 'uploading'
  | 'ready'
  | 'expired'
  | 'failed';

/** D1 rows are passed through unchanged, hence snake_case. */
export interface Recording {
  id: string;
  court_id: string;
  status: RecordingStatus;
  bytes: number;
  purchased: number;
  started_at: number;
  stopped_at: number | null;
  created_at: number;
  /** Why it failed. Null on every healthy row. */
  error: string | null;
  /** R2 key of the first-frame JPEG; null when none has been generated. */
  thumbnail_key: string | null;
}

/** Where players give up, per court. Counts are distinct visits, then distinct matches. */
export interface CourtFunnel {
  court_id: string;
  scans: number;
  scans_ready: number;
  scans_busy: number;
  scans_offline: number;
  scans_returning: number;
  start_attempts: number;
  start_failed: Record<string, number>;
  started: number;
  shared: number;
  shared_by: Record<string, number>;
  opened_by_others: number;
  stopped_manual: number;
  stopped_auto: number;
  returned_ready: number;
  played: number;
  watched_30s: number;
  downloaded: number;
  locked_views: number;
  feedback_up: number;
  feedback_down: number;
  comments: { rating: number; comment: string; created_at: number }[];
}

export interface FunnelResponse {
  days: 7 | 30;
  since: number;
  courts: CourtFunnel[];
}

export interface ShareLink {
  token: string;
  url: string;
  expiresAt: number;
}

// --- company spending (super-admin only) ---

export const EXPENSE_CATEGORIES = [
  'hardware',
  'cloud',
  'software',
  'services',
  'legal',
  'other',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/**
 * A raw D1 row. Amounts are integer EUR cents including VAT; negative is a
 * refund. The original currency is set only for a purchase not made in euros,
 * and then `amount_original_cents` is in that currency's minor units.
 */
export interface Expense {
  id: string;
  /** `YYYY-MM-DD`: the day on the invoice, not when it was entered. */
  date: string;
  vendor: string;
  description: string;
  /** Typed as a string: an unknown category from the server still renders. */
  category: string;
  amount_cents: number;
  currency_original: string | null;
  amount_original_cents: number | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export interface ExpensesResponse {
  /** Newest first. */
  expenses: Expense[];
  totals: {
    allCents: number;
    byCategory: Record<string, number>;
    /** Keyed `YYYY-MM`. */
    byMonth: Record<string, number>;
  };
}

export interface ExpenseInput {
  date: string;
  vendor: string;
  description: string;
  category: ExpenseCategory;
  amountCents: number;
  currencyOriginal?: string | null;
  amountOriginalCents?: number | null;
  notes?: string | null;
}
