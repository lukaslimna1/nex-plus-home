/* ========================================================================= */
/* NEX+ Home · Tipos e Interfaces do Shell v0.1                              */
/* ========================================================================= */

export type NavigationItemId =
  | "home"
  | "max"
  | "suppliers"
  | "radar"
  | "tools"
  | "settings";

export interface NavigationItem {
  id: NavigationItemId;
  label: string;
  badge?: string | number;
}

export interface SupplierItem {
  id: string;
  name: string;
  category: string;
  status: "Ativo" | "Em teste" | "Inativo";
  initial: string;
  updatedAt: string;
  themeColor: string;
}

export interface RadarProductItem {
  id: string;
  name: string;
  marketplace: "Mercado Livre" | "Shopee" | "Amazon" | "Outros";
  priceFormatted: string;
  variationPercentage: string;
  isDiscount: boolean;
  productType: "headphone" | "tshirt" | "watch" | "bottle";
}

export interface ToolItem {
  id: string;
  title: string;
  description: string;
  iconName: "calculator" | "markup" | "freight" | "compare" | "taxes" | "currency";
  accentColor: string;
}

export interface QuickMetric {
  id: string;
  label: string;
  value: string | number;
  trendText: string;
  trendType: "positive" | "warning" | "neutral";
  accentColor: string;
}

export interface MaxSuggestion {
  id: string;
  title: string;
  category: string;
  color: string;
}

export interface NotificationTrackItem {
  id: string;
  title: string;
  subtitle: string;
  type: "deadline" | "alert" | "backup" | "sync";
  iconColor: string;
}
