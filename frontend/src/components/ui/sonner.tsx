import { Toaster as Sonner, type ToasterProps } from 'sonner';

// btmux is always dark — the `.dark` class is set unconditionally in
// applyThemeVars. Every toast we raise goes through `showToast` → `toast.custom`
// (see state/store.tsx), rendering `ToastCard`, so this Toaster only needs to own
// positioning/stacking — no icons/closeButton/per-type colors, since ToastCard
// draws its own chrome.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      gap={10}
      style={{ '--width': '340px' } as React.CSSProperties}
      {...props}
    />
  );
};

export { Toaster };
