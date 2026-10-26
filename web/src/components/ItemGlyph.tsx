import type { ReactElement } from 'react';
import type { ItemCategory } from '../api';

/** Simple pictograms, one per item category, drawn on a 24px grid. */
const GLYPHS: Record<ItemCategory, ReactElement> = {
  weapon: <path d="M2.5 12.5h13.5l1.5-1.5h4v2.2l-3.4.8-.8 3h-2.6l-.9-2H8.6l-2.1 3.5H3.7l1.6-3.5H2.5z" />,
  ammo: (
    <>
      <path d="M9 21V10c0-3 1.3-5.5 3-7 1.7 1.5 3 4 3 7v11z" />
      <path d="M9 16.5h6" />
    </>
  ),
  attachment: (
    <>
      <circle cx="12" cy="12" r="6.5" />
      <path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5" />
    </>
  ),
  armor: (
    <>
      <path d="M4 16c0-5 3.6-9 8-9s8 4 8 9z" />
      <path d="M8.5 16v3.5h7V16" />
    </>
  ),
  clothing: <path d="M8.5 4 3.5 7l2 4 2-1v10h9V10l2 1 2-4-5-3c-.6 1.4-2 2.4-3.5 2.4S9.1 5.4 8.5 4z" />,
  medical: <path d="M9 3.5h6v5.5h5.5v6H15v5.5H9V15H3.5V9H9z" />,
  food: (
    <>
      <rect x="6" y="4" width="12" height="16" rx="2" />
      <path d="M6 8.5h12M6 15.5h12" />
    </>
  ),
  tool: (
    <>
      <path d="m12.5 4.5 7 7-2.5 2.5-7-7z" />
      <path d="M10.6 9.4 4 16l3 3 6.6-6.6" />
    </>
  ),
  resource: (
    <>
      <circle cx="8" cy="15.5" r="3.5" />
      <circle cx="16" cy="15.5" r="3.5" />
      <circle cx="12" cy="8.5" r="3.5" />
    </>
  ),
  building: (
    <>
      <path d="M5.5 21V3.5h13V21M3 21h18" />
      <circle cx="15" cy="12.5" r="1" />
    </>
  ),
  explosive: (
    <>
      <rect x="4" y="9.5" width="16" height="10.5" rx="1.5" />
      <path d="M12 9.5V7c0-1.6 1.1-2.7 2.7-2.7H17M19.5 2.5l.8 1.4M21.5 5l-1.5.4" />
    </>
  ),
  misc: (
    <>
      <path d="M3.5 7.5 12 3.5l8.5 4v9L12 20.5l-8.5-4z" />
      <path d="m3.5 7.5 8.5 4 8.5-4M12 11.5v9" />
    </>
  ),
};

export function ItemGlyph({ category, className }: { category: ItemCategory; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[category] ?? GLYPHS.misc}
    </svg>
  );
}
