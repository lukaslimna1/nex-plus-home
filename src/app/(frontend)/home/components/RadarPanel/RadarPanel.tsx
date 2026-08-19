import React, { useState } from "react";
import styles from "./RadarPanel.module.css";
import { ModuleCard } from "../ModuleCard/ModuleCard";
import {
  Crosshair,
  Storefront,
  Bag,
  ShoppingCartSimple,
  CirclesFour,
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
          <Storefront
            size={16}
            color={activeTab === "Mercado Livre" ? "#FFB300" : "#FFB300"}
            weight={activeTab === "Mercado Livre" ? "fill" : "regular"}
          />
          <span>Mercado Livre</span>
        </button>

        <button
          type="button"
          className={`${styles.tabButton} ${
            activeTab === "Shopee" ? styles.tabButtonActive : ""
          }`}
          onClick={() => setActiveTab("Shopee")}
        >
          <Bag
            size={16}
            color={activeTab === "Shopee" ? "#F28C28" : "#E45B4F"}
            weight={activeTab === "Shopee" ? "fill" : "regular"}
          />
          <span>Shopee</span>
        </button>

        <button
          type="button"
          className={`${styles.tabButton} ${
            activeTab === "Amazon" ? styles.tabButtonActive : ""
          }`}
          onClick={() => setActiveTab("Amazon")}
        >
          <ShoppingCartSimple
            size={16}
            color={activeTab === "Amazon" ? "#719BB9" : "#719BB9"}
            weight={activeTab === "Amazon" ? "fill" : "regular"}
          />
          <span>Amazon</span>
        </button>

        <button
          type="button"
          className={`${styles.tabButton} ${
            activeTab === "Outros" ? styles.tabButtonActive : ""
          }`}
          onClick={() => setActiveTab("Outros")}
        >
          <CirclesFour
            size={16}
            color={activeTab === "Outros" ? "#F7F2FF" : "#8FA1B2"}
            weight={activeTab === "Outros" ? "fill" : "regular"}
          />
          <span>Outros</span>
        </button>
      </div>

      {/* Header da Tabela alinhado em grid */}
      <div className={styles.tableHeader}>
        <span>Produtos monitorados</span>
        <span className={styles.headerPrice}>Preço</span>
        <span className={styles.headerVariation}>Variação</span>
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
              {/* Informações do Produto */}
              <div className={styles.productLeft}>
                <div className={styles.thumbBox}>
                  <ProductIcon size={17} weight="duotone" />
                </div>
                <div className={styles.infoCol}>
                  <span className={styles.productName}>{p.name}</span>
                  <span className={styles.marketplaceName}>{p.marketplace}</span>
                </div>
              </div>

              {/* Preço Alinhado */}
              <div className={styles.priceCol}>
                <span className={styles.priceText}>{p.priceFormatted}</span>
              </div>

              {/* Variação + Sparkline */}
              <div className={styles.variationCol}>
                <span
                  className={
                    p.isDiscount ? styles.trendPillDiscount : styles.trendPillHike
                  }
                >
                  {p.isDiscount ? "↓" : "↑"} {p.variationPercentage}
                </span>

                {/* Sparkline SVG 44x15 */}
                <svg
                  width="44"
                  height="15"
                  viewBox="0 0 44 15"
                  className={styles.sparklineSvg}
                >
                  <path
                    d={
                      p.isDiscount
                        ? "M2 3 Q 12 2, 20 9 T 32 5 T 42 12"
                        : "M2 12 Q 12 11, 20 5 T 32 8 T 42 3"
                    }
                    fill="none"
                    stroke={p.isDiscount ? "#49A67C" : "#FF1B1B"}
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
            </div>
          );
        })}
      </div>
    </ModuleCard>
  );
}
