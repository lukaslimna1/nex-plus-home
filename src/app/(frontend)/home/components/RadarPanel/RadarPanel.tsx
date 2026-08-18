import React, { useState } from "react";
import styles from "./RadarPanel.module.css";
import { ModuleCard } from "../ModuleCard/ModuleCard";
import {
  Crosshair,
  Storefront,
  Bag,
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
      icon={<Crosshair size={20} weight="duotone" />}
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
          <Storefront size={13} color="#fbbf24" weight="fill" />
          <span>Mercado Livre</span>
        </button>

        <button
          type="button"
          className={`${styles.tabButton} ${
            activeTab === "Shopee" ? styles.tabButtonActive : ""
          }`}
          onClick={() => setActiveTab("Shopee")}
        >
          <Bag size={13} color="#f97316" weight="fill" />
          <span>Shopee</span>
        </button>

        <button
          type="button"
          className={`${styles.tabButton} ${
            activeTab === "Amazon" ? styles.tabButtonActive : ""
          }`}
          onClick={() => setActiveTab("Amazon")}
        >
          <span className={styles.amazonLogo}>a</span>
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
                  <ProductIcon size={15} />
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
                  {/* Sparkline SVG refinada */}
                  <svg width="32" height="12" viewBox="0 0 32 12">
                    <path
                      d={
                        p.isDiscount
                          ? "M1 2 Q 8 1, 14 7 T 22 4 T 31 10"
                          : "M1 10 Q 8 9, 14 4 T 22 7 T 31 2"
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
