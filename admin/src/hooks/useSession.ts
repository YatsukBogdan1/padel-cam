import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api/client';
import type { SessionUser } from '../api/types';

type Status = 'checking' | 'signed-in' | 'signed-out';

/**
 * Owns who is signed in. The session itself lives in an HttpOnly cookie, so the
 * browser cannot read it — `checking` covers the round trip that asks the
 * Worker whether that cookie is still valid.
 */
export function useSession() {
  const [user, setUser] = useState<SessionUser>();
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    api
      .me()
      .then((me) => {
        setUser(me);
        setStatus('signed-in');
      })
      .catch(() => setStatus('signed-out'));
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const me = await api.login(email, password);
    setUser(me);
    setStatus('signed-in');
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setUser(undefined);
    setStatus('signed-out');
  }, []);

  /** Call when any request 401s, so an expired session drops to the login form. */
  const handleApiError = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) {
      setUser(undefined);
      setStatus('signed-out');
    }
  }, []);

  return { user, status, signIn, signOut, handleApiError };
}
