/* ========================================================================= */
/* MOCK UI DATA — Dados estáticos de demonstração visual da UI Home v0.1     */
/* NÃO conectar a banco de dados nem IA real neste escopo.                   */
/* ========================================================================= */

import {
  SupplierItem,
  RadarProductItem,
  ToolItem,
  QuickMetric,
  MaxSuggestion,
  NotificationTrackItem,
} from "../types/home.types";

export const MOCK_METRICS: QuickMetric[] = [
  {
    id: "suppliers",
    label: "Fornecedores ativos",
    value: 128,
    trendText: "↗ +12% vs semana passada",
    trendType: "positive",
    accentColor: "#F43F5E",
  },
  {
    id: "products",
    label: "Produtos monitorados",
    value: 532,
    trendText: "↗ +18% vs semana passada",
    trendType: "positive",
    accentColor: "#FB923C",
  },
  {
    id: "alerts",
    label: "Alertas ativos",
    value: 23,
    trendText: "↘ 5 críticos",
    trendType: "warning",
    accentColor: "#F87171",
  },
  {
    id: "pending",
    label: "Itens pendentes",
    value: 17,
    trendText: "↗ 3 decisões",
    trendType: "neutral",
    accentColor: "#60A5FA",
  },
];

export const MOCK_SUPPLIERS: SupplierItem[] = [
  {
    id: "sup-1",
    name: "Prime Cast Import",
    category: "Eletrônicos",
    status: "Ativo",
    initial: "S",
    updatedAt: "há 2 h",
    themeColor: "#F43F5E",
  },
  {
    id: "sup-2",
    name: "Global Box Solutions",
    category: "Embalagens",
    status: "Ativo",
    initial: "B",
    updatedAt: "há 5 h",
    themeColor: "#A855F7",
  },
  {
    id: "sup-3",
    name: "Tech Parts Brasil",
    category: "Componentes",
    status: "Em teste",
    initial: "T",
    updatedAt: "há 1 dia",
    themeColor: "#F59E0B",
  },
  {
    id: "sup-4",
    name: "Distribuidora Alvo",
    category: "Utilidades",
    status: "Ativo",
    initial: "N",
    updatedAt: "há 2 dias",
    themeColor: "#3B82F6",
  },
];

export const MOCK_RADAR_PRODUCTS: RadarProductItem[] = [
  {
    id: "rad-1",
    name: "Fone Bluetooth Pro X",
    marketplace: "Mercado Livre",
    priceFormatted: "R$ 149,90",
    variationPercentage: "4%",
    isDiscount: true,
    productType: "headphone",
  },
  {
    id: "rad-2",
    name: "Camiseta Dry Fit",
    marketplace: "Shopee",
    priceFormatted: "R$ 39,90",
    variationPercentage: "6%",
    isDiscount: false,
    productType: "tshirt",
  },
  {
    id: "rad-3",
    name: "Smartwatch Fit S2",
    marketplace: "Amazon",
    priceFormatted: "R$ 229,90",
    variationPercentage: "3%",
    isDiscount: true,
    productType: "watch",
  },
  {
    id: "rad-4",
    name: "Garrafa Térmica 1L",
    marketplace: "Mercado Livre",
    priceFormatted: "R$ 89,90",
    variationPercentage: "2%",
    isDiscount: false,
    productType: "bottle",
  },
];

export const MOCK_TOOLS: ToolItem[] = [
  {
    id: "tool-1",
    title: "Calculadora de preço",
    description: "Calcule preços e margens",
    iconName: "calculator",
    accentColor: "#A855F7",
  },
  {
    id: "tool-2",
    title: "Margem & markup",
    description: "Analise margens ideais",
    iconName: "markup",
    accentColor: "#F59E0B",
  },
  {
    id: "tool-3",
    title: "Cálculo de frete",
    description: "Simule custos logísticos",
    iconName: "freight",
    accentColor: "#10B981",
  },
  {
    id: "tool-4",
    title: "Comparador de produtos",
    description: "Compare produtos e preços",
    iconName: "compare",
    accentColor: "#EAB308",
  },
  {
    id: "tool-5",
    title: "Simulador de impostos",
    description: "Estime tributos e taxas",
    iconName: "taxes",
    accentColor: "#EC4899",
  },
  {
    id: "tool-6",
    title: "Conversor de moeda",
    description: "Cotações e conversões",
    iconName: "currency",
    accentColor: "#06B6D4",
  },
];

export const MOCK_MAX_SUGGESTIONS: MaxSuggestion[] = [
  {
    id: "sug-1",
    title: "Revise 5 variações de preço",
    category: "Radar",
    color: "#A855F7",
  },
  {
    id: "sug-2",
    title: "Negocie com 3 fornecedores",
    category: "Fornecedores",
    color: "#F43F5E",
  },
  {
    id: "sug-3",
    title: "Teste de amostra pendente",
    category: "Operacional",
    color: "#10B981",
  },
  {
    id: "sug-4",
    title: "Acompanhe 2 alertas críticos",
    category: "Sistema",
    color: "#F87171",
  },
];

export const MOCK_NOTIFICATIONS: NotificationTrackItem[] = [
  {
    id: "notif-1",
    title: "Revisar projeto Dualidade",
    subtitle: "Prazo em 30 min",
    type: "deadline",
    iconColor: "#F43F5E",
  },
  {
    id: "notif-2",
    title: "2 alertas críticos",
    subtitle: "Precisam da sua atenção",
    type: "alert",
    iconColor: "#F59E0B",
  },
  {
    id: "notif-3",
    title: "Backup automático",
    subtitle: "Próximo em 12 min",
    type: "backup",
    iconColor: "#10B981",
  },
  {
    id: "notif-4",
    title: "Sincronização de dados",
    subtitle: "Última: há 2 min",
    type: "sync",
    iconColor: "#38BDF8",
  },
];
