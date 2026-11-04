import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { ShareLink } from '@/api/types';
import { formatDateTime } from '@/lib/format';

interface Props {
  share: ShareLink | undefined;
  onClose: () => void;
}

/** Render the share URL as an SVG QR code the player scans with a phone camera. */
function useQrSvg(url: string | undefined): string | undefined {
  return useMemo(() => {
    if (!url) return undefined;
    const qr = qrcode(0, 'M'); // 0 = auto-size, M = ~15% error correction
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }, [url]);
}

export function ShareDialog({ share, onClose }: Props) {
  const svg = useQrSvg(share?.url);
  const [copied, setCopied] = useState(false);

  useEffect(() => setCopied(false), [share?.token]);

  async function copyLink() {
    if (!share) return;
    await navigator.clipboard.writeText(share.url);
    setCopied(true);
  }

  return (
    <Dialog open={Boolean(share)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share with the player</DialogTitle>
          <DialogDescription>
            {share
              ? `Anyone with this link can download the video until ${formatDateTime(share.expiresAt)}.`
              : null}
          </DialogDescription>
        </DialogHeader>

        {svg && (
          <div
            className="mx-auto w-56 rounded-lg bg-white p-3 [&>svg]:h-full [&>svg]:w-full"
            // qrcode-generator emits a self-contained <svg> string.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        )}

        <div className="flex gap-2">
          <Input readOnly value={share?.url ?? ''} onFocus={(e) => e.target.select()} />
          <Button variant="outline" size="icon" onClick={copyLink} aria-label="Copy link">
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
