import type {
  Court,
  CourtsResponse,
  Expense,
  ExpenseInput,
  ExpensesResponse,
  FleetOverview,
  Recording,
  SessionUser,
  ShareLink,
  Venue,
  FunnelResponse,
} from './types';

/** An API error carrying the HTTP status, so callers can branch on 401. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status);
  }
  // A DELETE answers 204 with no body; parsing it would throw on success.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  // --- session ---
  me: () => request<SessionUser>('/api/auth/me'),

  login: (email: string, password: string) =>
    request<SessionUser>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  // --- cameras ---
  courts: () => request<CourtsResponse>('/api/courts'),

  // --- recordings ---
  recordings: () => request<Recording[]>('/api/recordings'),

  /** Without `bookedUntil` the match runs until stopped, capped server-side at 3 h. */
  startRecording: (courtId: string, bookedUntil?: number) =>
    request<Recording>('/api/recordings/start', {
      method: 'POST',
      body: JSON.stringify({ courtId, bookedUntil }),
    }),

  stopRecording: (recordingId: string) =>
    request<Recording>('/api/recordings/stop', {
      method: 'POST',
      body: JSON.stringify({ recordingId }),
    }),

  createShare: (recordingId: string) =>
    request<ShareLink>(`/api/recordings/${recordingId}/share`, { method: 'POST' }),

  downloadUrl: (recordingId: string) => `/api/recordings/${recordingId}/download`,

  thumbnailUrl: (recordingId: string) => `/api/recordings/${recordingId}/thumbnail`,
};

/**
 * Fleet-wide operations. Every one of these 404s for an account without the
 * super-admin flag, so the client never has to guard them beyond hiding the UI.
 */
export const superApi = {
  overview: () => request<FleetOverview>('/api/super/overview'),

  funnel: (days: 7 | 30) => request<FunnelResponse>(`/api/super/funnel?days=${days}`),

  createVenue: (id: string, name: string) =>
    request<Venue>('/api/super/venues', {
      method: 'POST',
      body: JSON.stringify({ id, name }),
    }),

  /** `venueId: null` unassigns the court, making it invisible to every club. */
  assignCourt: (courtId: string, venueId: string | null) =>
    request<Court>(`/api/super/courts/${encodeURIComponent(courtId)}`, {
      method: 'POST',
      body: JSON.stringify({ venueId }),
    }),

  renameCourt: (courtId: string, name: string | null) =>
    request<Court>(`/api/super/courts/${encodeURIComponent(courtId)}`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  /** Epoch ms; `null` removes the paywall so every recording is free. */
  setFreeUntil: (courtId: string, freeUntil: number | null) =>
    request<Court>(`/api/super/courts/${encodeURIComponent(courtId)}`, {
      method: 'POST',
      body: JSON.stringify({ freeUntil }),
    }),

  setVenueSchedule: (venueId: string, timezone: string, slotMinutes: number) =>
    request<{ id: string }>(`/api/super/venues/${encodeURIComponent(venueId)}`, {
      method: 'POST',
      body: JSON.stringify({ timezone, slotMinutes }),
    }),

  /** A document, not JSON: opened in a new tab and printed. */
  qrCardUrl: (courtId: string) => `/api/super/courts/${encodeURIComponent(courtId)}/qr`,

  deleteCourt: (courtId: string) =>
    request<{ deleted: true }>(`/api/super/courts/${encodeURIComponent(courtId)}`, {
      method: 'DELETE',
    }),

  /** Omit `ids` to collect exactly what the nightly sweep would. */
  cleanup: (ids?: string[]) =>
    request<{ cleaned: string[]; count: number }>('/api/super/recordings/cleanup', {
      method: 'POST',
      body: JSON.stringify(ids ? { ids } : {}),
    }),

  purgeRecording: (recordingId: string) =>
    request<{ purged: true }>(`/api/super/recordings/${recordingId}`, {
      method: 'DELETE',
    }),

  // --- company spending ---
  expenses: () => request<ExpensesResponse>('/api/super/expenses'),

  createExpense: (input: ExpenseInput) =>
    request<{ expense: Expense }>('/api/super/expenses', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** Partial: only the fields present change. `null` clears an optional field. */
  updateExpense: (id: string, patch: Partial<ExpenseInput>) =>
    request<{ expense: Expense }>(`/api/super/expenses/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteExpense: (id: string) =>
    request<void>(`/api/super/expenses/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

/**
 * A court is busy while one of its recordings is still in flight. `uploading`
 * counts: the camera has stopped but the row is not finished, and offering
 * Start again there would open a second multipart upload against a camera that
 * is still draining the first.
 */
export function activeRecordingFor(
  court: Court,
  recordings: Recording[],
): Recording | undefined {
  return recordings.find(
    (r) =>
      r.court_id === court.courtId &&
      (r.status === 'recording' || r.status === 'uploading'),
  );
}
