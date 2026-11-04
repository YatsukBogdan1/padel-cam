import { LogOut, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SessionUser } from '@/api/types';

interface Props {
  user: SessionUser;
  onSignOut: () => void;
  onOpenSuper: () => void;
}

export function Header({ user, onSignOut, onOpenSuper }: Props) {
  return (
    <header className="flex items-start justify-between gap-4 border-b pb-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{user.venue.name}</h1>
        <p className="text-muted-foreground text-sm">{user.email}</p>
      </div>
      <div className="flex shrink-0 gap-2">
        {user.isSuperadmin && (
          <Button variant="outline" size="sm" onClick={onOpenSuper}>
            <Settings2 />
            Fleet
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onSignOut}>
          <LogOut />
          Sign out
        </Button>
      </div>
    </header>
  );
}
