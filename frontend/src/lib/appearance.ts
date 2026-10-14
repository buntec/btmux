import { Moon, Sun, SunMoon } from 'lucide-react';
import type { Appearance } from '../state/types';

export const APPEARANCES: { value: Appearance; label: string; icon: typeof Sun }[] = [
  { value: 'auto', label: 'Auto', icon: SunMoon },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
];
