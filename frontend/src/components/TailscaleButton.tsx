import type { SVGProps } from 'react';
import { Copy } from 'lucide-react';
import { Popover } from '@astryxdesign/core/Popover';
import { IconButton } from '@astryxdesign/core/IconButton';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import type { TailscaleStatus } from '../generated/protocol';
import { useStore } from '../state/store';

// Tailscale's nine-dot mark. Sized in em: WebKit collapses an unsized SVG flex item to 0x0.
function TailscaleGlyph(props: SVGProps<SVGSVGElement>) {
  const lit = new Set([3, 4, 5, 7]);
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" {...props}>
      {Array.from({ length: 9 }, (_, i) => (
        <circle key={i} cx={4 + (i % 3) * 8} cy={4 + Math.floor(i / 3) * 8} r={3} fillOpacity={lit.has(i) ? 1 : 0.3} />
      ))}
    </svg>
  );
}

function Details({ status }: { status: TailscaleStatus }) {
  if (status.state === 'starting')
    return (
      <Text color="secondary" className="btm-sans">
        Setting up tailscale serve…
      </Text>
    );
  if (status.state === 'error')
    return (
      <VStack gap={1} className="btm-sans">
        <Text>{status.message}</Text>
        <Text type="supporting">Retrying every 10 seconds.</Text>
      </VStack>
    );
  const copy = () => {
    const { showToast } = useStore.getState();
    const failed = () => showToast('Could not copy the tailnet address; select it to copy it', 'error');
    // Absent outside secure contexts, e.g. plain HTTP from another machine.
    if (!navigator.clipboard?.writeText) return failed();
    navigator.clipboard.writeText(status.url).then(() => showToast('Tailnet address copied', 'success'), failed);
  };
  return (
    <VStack gap={2} className="btm-sans">
      <HStack gap={1} vAlign="center">
        <Text type="code" className="break-all select-text">
          {status.url}
        </Text>
        <IconButton
          label="Copy address"
          tooltip="Copy address"
          variant="ghost"
          size="sm"
          icon={<Copy />}
          onClick={copy}
        />
      </HStack>
      <Text type="supporting">Other devices on your tailnet sign in with this server's access token.</Text>
    </VStack>
  );
}

/** The tailnet address of a server started with `--tailscale`. */
export function TailscaleButton() {
  const status = useStore((state) => state.tailscale);
  if (!status) return null;
  const label =
    status.state === 'serving' ? 'Tailnet' : status.state === 'error' ? 'Tailnet: not serving' : 'Tailnet: starting';
  return (
    <HStack gap={0.5} vAlign="center">
      <Popover label="Tailnet" placement="above" alignment="end" width={360} content={<Details status={status} />}>
        <IconButton
          label={label}
          tooltip={label}
          variant="ghost"
          size="sm"
          icon={<TailscaleGlyph opacity={status.state === 'serving' ? 1 : 0.5} />}
        />
      </Popover>
      {status.state === 'error' && <StatusDot variant="warning" label="Tailnet not serving" />}
    </HStack>
  );
}
