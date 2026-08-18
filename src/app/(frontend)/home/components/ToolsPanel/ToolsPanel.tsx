import React from "react";
import styles from "./ToolsPanel.module.css";
import { ModuleCard } from "../ModuleCard/ModuleCard";
import {
  Wrench,
  Calculator,
  CurrencyCircleDollar,
  Truck,
  Scales,
  Receipt,
  ArrowsClockwise,
} from "@phosphor-icons/react";
import { MOCK_TOOLS } from "../../data/mockHomeData";

export function ToolsPanel() {
  return (
    <ModuleCard
      title="Ferramentas"
      subtitle="Utilitários e cálculos para decisões inteligentes."
      icon={<Wrench size={20} weight="duotone" />}
      themeColor="purple"
      actionLabel="Abrir ferramentas"
    >
      {/* Grid 2x3 de Ferramentas */}
      <div className={styles.toolsGrid}>
        {MOCK_TOOLS.map((t) => {
          const IconComponent =
            t.iconName === "calculator"
              ? Calculator
              : t.iconName === "markup"
              ? CurrencyCircleDollar
              : t.iconName === "freight"
              ? Truck
              : t.iconName === "compare"
              ? Scales
              : t.iconName === "taxes"
              ? Receipt
              : ArrowsClockwise;

          return (
            <div key={t.id} className={styles.toolBox}>
              <IconComponent
                size={19}
                style={{ color: t.accentColor }}
                className={styles.toolIcon}
                weight="duotone"
              />
              <span className={styles.toolTitle}>{t.title}</span>
              <span className={styles.toolDesc}>{t.description}</span>
            </div>
          );
        })}
      </div>
    </ModuleCard>
  );
}
