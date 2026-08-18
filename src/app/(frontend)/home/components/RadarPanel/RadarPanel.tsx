import React, { useState } from "react";
import styles from "./RadarPanel.module.css";
import { ModuleCard } from "../ModuleCard/ModuleCard";
import {
  Crosshair,
  Storefront,
  Package,
  Headphones,
  TShirt,
  Watch,
  Drop,
} from "@phosphor-icons/react";
import { MOCK_RADAR_PRODUCTS } from "../../data/mockHomeData";

export function RadarPanel() {
  const [activeTab, setActiveTab] = useState("Mercado Livre");

  return (
    <ModuleCard
      title="Radar de Compra"
      subtitle="Monitoramento de marketplaces e tendências."
      icon={<Crosshair size={22} weight="duotone" />}
      themeColor="amber"
      actionLabel="Ver radar completo"
    >
      {/* Tabs dos Marketplaces */}
      <div className={styles.tabsRow}>
        <button
          type="button"
          className={`${styles.tabButton} ${
            activeTab === "Mercado Livre" ? styles.tabButtonActive : ""
          }`}
          onClick={() => setActiveTab("Mercado Livre")}
        >
          <Storefront size={13} color="#fbbf24" />
          <span>Mercado Livre</span>
        </button>

        <button
          type="button"
          className={`${styles.tabButton} ${
            activeTab === "Shopee" ? styles.tabButtonActive : ""
          }`}
          onClick={() => setActiveTab("Shopee")}
        >
          <Package size={13} color="#f97316" />
          <span>Shopee</span>
        </button>

        <button
          type="button"
          className={`${styles.tabButton} ${
            activeTab === "Amazon" ? styles.tabButtonActive : ""
          }`}
          onClick={() => setActiveTab("Amazon")}
        >
          <span style={{ fontWeight: 800, fontSize: "0.75rem", color: "#60a5fa" }}>a</span>
          <span>Amazon</span>
        </button>

        <button
          type="button"
          className={`${styles.tabButton} ${
            activeTab === "Outros" ? styles.tabButtonActive : ""
          }`}
          onClick={() => setActiveTab("Outros")}
        >
          <span>Outros</span>
        </button>
      </div>

      {/* Header da Tabela */}
      <div className={styles.tableHeader}>
        <span>Produtos monitorados</span>
        <div className={styles.headerMetrics}>
          <span>Preço</span>
          <span>Variação</span>
        </div>
      </div>

      {/* Lista de Produtos Monitorados */}
      <div className={styles.productsList}>
        {MOCK_RADAR_PRODUCTS.map((p) => {
          const ProductIcon =
            p.productType === "headphone"
              ? Headphones
              : p.productType === "tshirt"
              ? TShirt
              : p.productType === "watch"
              ? Watch
              : Drop;

          return (
            <div key={p.id} className={styles.productRow}>
              <div className={styles.productLeft}>
                <div className={styles.thumbBox}>
                  <ProductIcon size={16} />
                </div>
                <div className={styles.infoCol}>
                  <span className={styles.productName}>{p.name}</span>
                  <span className={styles.marketplaceName}>{p.marketplace}</span>
                </div>
              </div>

              <div className={styles.priceRightCol}>
                <span className={styles.priceText}>{p.priceFormatted}</span>
                <div className={styles.sparklineBlock}>
                  <span
                    className={p.isDiscount ? styles.trendGreen : styles.trendRed}
                  >
                    {p.isDiscount ? "↓" : "↑"} {p.variationPercentage}
                  </span>
                  {/* Sparkline SVG Discreta */}
                  <svg width="34" height="14" viewBox="0 0 34 14">
                    <path
                      d={
                        p.isDiscount
                          ? "M1 3 Q 7 1, 13 8 T 23 5 T 33 11"
                          : "M1 11 Q 7 9, 13 4 T 23 7 T 33 2"
                      }
                      fill="none"
                      stroke={p.isDiscount ? "#4ade80" : "#f87171"}
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </ModuleCard>
  );
}
