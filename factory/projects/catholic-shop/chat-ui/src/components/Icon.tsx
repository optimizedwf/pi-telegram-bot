import type { Occasion } from '../types';
import type { SVGProps } from 'react';

const iconMap: Record<string, (props: SVGProps<SVGSVGElement>) => React.ReactElement> = {
  baptism: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M12 3v8" /><path d="M12 11c-3 0-5.5 1.5-5.5 4.5s2.5 4.5 5.5 4.5 5.5-1.5 5.5-4.5S15 11 12 11z" />
      <path d="M6 14c-1-.5-2 0-2 1.5s1.5 3 2 3" /><path d="M18 14c1-.5 2 0 2 1.5s-1.5 3-2 3" />
    </svg>
  ),
  first_communion: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="12" cy="7" r="4" /><path d="M8 11v6l4 4 4-4v-6" />
      <line x1="12" y1="11" x2="12" y2="15" />
    </svg>
  ),
  confirmation: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M12 3c-1.5 2-1.5 4-1.5 6" /><path d="M12 9c1.5 2 2.5 4 3 7" />
      <path d="M15 16c-1-2-3-3-3-3" /><path d="M12 13c-.5-2-1-4-3-7" />
      <path d="M9 16c1-2 3-3 3-3" />
    </svg>
  ),
  wedding: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="8" cy="8" r="2.5" /><circle cx="16" cy="8" r="2.5" />
      <path d="M8 10.5V18l4 3 4-3v-7.5" />
    </svg>
  ),
  ordination: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M12 3v18" /><path d="M8 6h8" /><path d="M8 10h8" />
      <path d="M12 17l-3 3h6l-3-3z" />
    </svg>
  ),
  healing: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M7 3h10l3 7-8 11-8-11 3-7z" />
      <line x1="12" y1="8" x2="12" y2="14" /><line x1="9" y1="11" x2="15" y2="11" />
    </svg>
  ),
  mourning: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M12 3v5" /><path d="M9 6l3-3 3 3" />
      <rect x="8" y="8" width="8" height="12" rx="2" /><path d="M12 12v4" />
    </svg>
  ),
  home_blessing: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 12l9-9 9 9" /><path d="M5 10v11h14V10" />
      <path d="M9 21v-7h6v7" /><circle cx="12" cy="15" r="1" fill="currentColor" />
    </svg>
  ),
  christmas: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <polygon points="12 2 15 9 22 9 16 14 18 21 12 17 6 21 8 14 2 9 9 9" />
    </svg>
  ),
  easter: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="12" cy="12" r="8" /><path d="M8 12h8" />
      <path d="M12 8v8" /><path d="M7 7l10 10" /><path d="M17 7L7 17" />
    </svg>
  ),
  just_browsing: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="12" cy="12" r="10" /><polygon points="12 6 12 12 17 12" />
      <circle cx="2" cy="2" r="1" fill="currentColor" /><circle cx="22" cy="7" r="1" fill="currentColor" />
      <circle cx="5" cy="20" r="1" fill="currentColor" /><circle cx="19" cy="19" r="1" fill="currentColor" />
    </svg>
  ),
  cross: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M12 3v18" /><path d="M6 9h12" />
    </svg>
  ),
  menu: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  ),
  cart: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6" />
    </svg>
  ),
  send: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  ),
  chevronLeft: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <polyline points="15 18 9 12 15 6" />
    </svg>
  ),
  chevronRight: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  ),
  arrowUpRight: (p) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <line x1="7" y1="17" x2="17" y2="7" /><polyline points="7 7 17 7 17 17" />
    </svg>
  ),
};

export type IconName = keyof typeof iconMap;

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  name: IconName | Occasion;
  size?: number;
}

export function Icon({ name, size = 20, className = '', ...rest }: IconProps) {
  const Svg = iconMap[name] ?? iconMap.cross;
  return (
    <span className={`inline-flex items-center justify-center shrink-0 ${className}`} style={{ width: size, height: size }}>
      <Svg width={size} height={size} {...rest} />
    </span>
  );
}

// Map occasions to icon names (identity function since they match)
export const occasionIcon = (o: Occasion): IconName => o;
