import { useState } from 'react';
import type { KitItem } from '../api';
import { formatAmount } from '../format';
import { ItemGlyph } from './ItemGlyph';

function ItemIcon({ item, iconUrl }: { item: KitItem; iconUrl: string | null }) {
  const [failed, setFailed] = useState(false);
  if (iconUrl && !failed) {
    return (
      <img
        className="slot__img"
        src={iconUrl.replace('{shortname}', encodeURIComponent(item.shortname))}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }
  return <ItemGlyph category={item.category} className="slot__glyph" />;
}

/** Kit contents drawn like Rust inventory slots, with the stack size in the corner. */
export function Inventory({ items, iconUrl, compact = false }: { items: KitItem[]; iconUrl: string | null; compact?: boolean }) {
  return (
    <ul className={compact ? 'inventory inventory--compact' : 'inventory'} aria-label="Kit contents">
      {items.map((item) => (
        <li key={`${item.shortname}-${item.amount}`} className={`slot slot--${item.category}`} title={`${item.name} x${formatAmount(item.amount)}`}>
          <ItemIcon item={item} iconUrl={iconUrl} />
          <span className="slot__name">{item.name}</span>
          {item.amount > 1 && <span className="slot__amount">×{formatAmount(item.amount)}</span>}
        </li>
      ))}
    </ul>
  );
}
