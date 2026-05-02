import { useCartStore } from '../store';
import { Icon } from './Icon';
import type { Product } from '../types';

interface Props {
  product: Product;
}

export function ProductCard({ product }: Props) {
  const { addItem, removeItem, items } = useCartStore();
  const inCart = items.some((i) => i.productId === product.id);

  return (
    <div className="bg-white border border-ink-100 rounded-lg overflow-hidden">
      {/* Image */}
      <div className="relative aspect-[4/3] bg-parchment-100">
        <img
          src={product.imageUrl}
          alt={product.name}
          className="w-full h-full object-cover"
          loading="lazy"
        />
        <div className="absolute top-2 left-2 flex items-center gap-0.5 bg-ink-800/70 text-parchment-50 text-[11px] px-2 py-0.5 rounded font-body backdrop-blur-sm">
          <Icon name="cross" size={10} />
          {product.destination}
        </div>
      </div>

      {/* Content */}
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-display text-sm text-ink-800 leading-snug">
            {product.name}
          </h3>
          <span className="font-medium text-sm text-gold-700 shrink-0">
            ${product.price}
          </span>
        </div>

        <p className="text-[11px] text-ink-400 mt-0.5 mb-2">
          {product.shopName}
        </p>

        <p className="text-xs text-ink-600 leading-relaxed line-clamp-2 mb-2">
          {product.description}
        </p>

        {product.blessing && (
          <p className="text-[11px] italic text-gold-600 mb-2 border-l-2 border-gold-200 pl-2">
            {product.blessing}
          </p>
        )}

        <button
          onClick={() => inCart ? removeItem(product.id) : addItem(product)}
          className={`w-full py-1.5 rounded text-xs font-medium font-body transition-colors duration-200 ${
            inCart
              ? 'text-red-600 hover:bg-red-50 border border-red-200'
              : 'bg-gold-600 text-parchment-50 hover:bg-gold-500'
          }`}
        >
          {inCart ? 'Remove' : 'Add to cart'}
        </button>

        {product.buyUrl && (
          <a
            href={product.buyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full mt-1.5 py-1.5 rounded text-xs font-medium font-body text-center border border-ink-300 text-ink-700 hover:bg-ink-50 transition-colors duration-200"
          >
            Buy from {product.shopName}
            <Icon name="arrowUpRight" size={10} className="inline ml-1" />
          </a>
        )}
      </div>
    </div>
  );
}
