import { useCallback, useEffect, useState } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { LoginForm } from '@/components/auth/LoginForm';
import { CameraSection } from '@/components/cameras/CameraSection';
import { Header } from '@/components/layout/Header';
import { RecordingsSection } from '@/components/recordings/RecordingsSection';
import { ShareDialog } from '@/components/recordings/ShareDialog';
import { SUPER_TAB_PATHS, SuperPanel, type SuperTab } from '@/components/super/SuperPanel';
import { useDashboard } from '@/hooks/useDashboard';
import { useSession } from '@/hooks/useSession';

const SUPER_PATH = SUPER_TAB_PATHS.fleet;

/** Which super-admin tab a path names, or undefined for a non-super path. */
function superTabFor(path: string): SuperTab | undefined {
  const normalized = path.replace(/\/+$/, '') || '/';
  return (Object.keys(SUPER_TAB_PATHS) as SuperTab[]).find(
    (t) => SUPER_TAB_PATHS[t] === normalized,
  );
}

/**
 * Path-based, not a router library: there are only a handful of pages. Each
 * real SPA path has an explicit `.get(path, h.serveAppShell)` in
 * worker/src/index.ts -- never `not_found_handling`, which breaks share links --
 * so /super and /super/finance survive a hard reload.
 */
function usePath(): [string, (next: string) => void] {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((next: string) => {
    window.history.pushState({}, '', next);
    setPath(next);
  }, []);

  return [path, navigate];
}

export function App() {
  const { user, status, signIn, signOut, handleApiError } = useSession();
  const [path, navigate] = usePath();

  // A non-super account that lands on /super gets the venue dashboard rather
  // than an error: the page's existence is not something a club admin needs
  // confirmed, which is also why the API answers 404 rather than 403.
  const superTab = user?.isSuperadmin === true ? superTabFor(path) : undefined;

  return (
    <>
      {status === 'checking' && <div className="min-h-svh" />}
      {status === 'signed-out' && <LoginForm onSignIn={signIn} />}
      {status === 'signed-in' &&
        user &&
        (superTab ? (
          <SuperPanel
            email={user.email}
            tab={superTab}
            onApiError={handleApiError}
            onNavigate={navigate}
            onLeave={() => navigate('/')}
          />
        ) : (
          <Dashboard
            user={user}
            onSignOut={signOut}
            onApiError={handleApiError}
            onOpenSuper={() => navigate(SUPER_PATH)}
          />
        ))}
      <Toaster />
    </>
  );
}

type DashboardProps = {
  user: NonNullable<ReturnType<typeof useSession>['user']>;
  onSignOut: () => void;
  onApiError: (error: unknown) => void;
  onOpenSuper: () => void;
};

/**
 * Split from App so the polling in useDashboard only ever runs while signed in —
 * mounting it under the `signed-in` branch is what stops it firing 401s at the
 * login screen.
 */
function Dashboard({ user, onSignOut, onApiError, onOpenSuper }: DashboardProps) {
  const {
    courts,
    endOptions,
    recordings,
    busy,
    share,
    closeShare,
    startRecording,
    stopRecording,
    shareRecording,
  } = useDashboard(onApiError);

  return (
    <div className="mx-auto grid max-w-4xl gap-10 p-6 md:p-10">
      <Header user={user} onSignOut={onSignOut} onOpenSuper={onOpenSuper} />

      <CameraSection
        courts={courts}
        endOptions={endOptions}
        recordings={recordings ?? []}
        busy={busy}
        onStart={startRecording}
        onStop={stopRecording}
      />

      <RecordingsSection recordings={recordings} busy={busy} onShare={shareRecording} />

      <ShareDialog share={share} onClose={closeShare} />
    </div>
  );
}
