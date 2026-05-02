export interface Product {
  id: string;
  name: string;
  shop: string;
  shopName: string;
  destination: string;
  price: number;
  currency: string;
  imageUrl: string;
  description: string;
  provenance: string;
  materials: string[];
  blessing: string;
  category: string;
  inStock: boolean;
  leadTime?: string;
  buyUrl?: string;
}

export interface CartItem {
  productId: string;
  product: Product;
  quantity: number;
  addedFromConversationId?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  productCards?: Product[];
  timestamp: number;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  productCount: number;
  occasion?: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  preferences?: UserPreferences;
}

export interface UserPreferences {
  favoriteDestinations?: string[];
  preferredBudget?: 'modest' | 'standard' | 'premium';
  liturgicalCalendar?: boolean;
  savedRecipients?: Recipient[];
}

export interface Recipient {
  name: string;
  relationship: string;
  occasions?: string[];
  notes?: string;
}

export type Occasion = 
  | 'baptism' 
  | 'first_communion' 
  | 'confirmation' 
  | 'wedding' 
  | 'ordination'
  | 'healing'
  | 'mourning'
  | 'home_blessing'
  | 'Christmas'
  | 'Easter'
  | 'just_browsing';

export const OCCASION_LABELS: Record<Occasion, { label: string; icon: string }> = {
  baptism:           { label: 'Baptism',           icon: 'baptism' },
  first_communion:   { label: 'First Communion',   icon: 'first_communion' },
  confirmation:      { label: 'Confirmation',      icon: 'confirmation' },
  wedding:           { label: 'Wedding',           icon: 'wedding' },
  ordination:        { label: 'Ordination',        icon: 'ordination' },
  healing:           { label: 'Healing',           icon: 'healing' },
  mourning:          { label: 'In Memoriam',       icon: 'mourning' },
  home_blessing:     { label: 'Home Blessing',     icon: 'home_blessing' },
  Christmas:         { label: 'Christmas',         icon: 'christmas' },
  Easter:            { label: 'Easter',            icon: 'easter' },
  just_browsing:     { label: 'Just Browsing',     icon: 'just_browsing' },
};

export const DESTINATIONS = [
  { id: 'assisi',    name: 'Assisi',    icon: 'just_browsing', description: 'The peaceful hills of St. Francis' },
  { id: 'lourdes',   name: 'Lourdes',   icon: 'healing',      description: 'Where healing waters flow' },
  { id: 'krakow',    name: 'Kraków',    icon: 'confirmation', description: 'City of Divine Mercy' },
  { id: 'fatima',    name: 'Fátima',    icon: 'easter',       description: 'Our Lady\'s garden' },
  { id: 'guadalupe', name: 'Guadalupe', icon: 'cross',        description: 'The miraculous tilma' },
  { id: 'jerusalem', name: 'Jerusalem', icon: 'ordination',   description: 'The Holy City' },
];
