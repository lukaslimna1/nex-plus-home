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
  const toolThemes: Record<
    string,
    {
      Icon: React.ElementType;
      iconColor: string;
      boxBg: string;
      boxBorder: string;
      cardClass: string;
    }
  > = {
    calculator: {
      Icon: Calculator,
      iconColor: "#B01862", // Pulso
      boxBg: "rgba(176, 24, 98, 0.14)",
      boxBorder: "rgba(176, 24, 98, 0.28)",
      cardClass: styles.toolCalculadora,
    },
    markup: {
      Icon: CurrencyCircleDollar,
      iconColor: "#F28C28", // Centelha
      boxBg: "rgba(242, 140, 40, 0.14)",
      boxBorder: "rgba(242, 140, 40, 0.28)",
      cardClass: styles.toolMarkup,
    },
    freight: {
      Icon: Truck,
      iconColor: "#49A67C", // Éter
      boxBg: "rgba(73, 166, 124, 0.14)",
      boxBorder: "rgba(73, 166, 124, 0.28)",
      cardClass: styles.toolFreight,
    },
    compare: {
      Icon: Scales,
      iconColor: "#FFB300", // Incandescente
      boxBg: "rgba(255, 179, 0, 0.14)",
      boxBorder: "rgba(255, 179, 0, 0.28)",
      cardClass: styles.toolCompare,
    },
    taxes: {
      Icon: Receipt,
      iconColor: "#E45B4F", // Nexus
      boxBg: "rgba(228, 91, 79, 0.14)",
      boxBorder: "rgba(228, 91, 79, 0.28)",
      cardClass: styles.toolTaxes,
    },
    currency: {
      Icon: ArrowsClockwise,
      iconColor: "#2F7DD9", // Boreal
      boxBg: "rgba(47, 125, 217, 0.14)",
      boxBorder: "rgba(47, 125, 217, 0.28)",
      cardClass: styles.toolCurrency,
    },
  };

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
          const theme = toolThemes[t.iconName] || {
            Icon: Wrench,
            iconColor: "#F7F2FF",
            boxBg: "rgba(247, 242, 255, 0.10)",
            boxBorder: "rgba(247, 242, 255, 0.20)",
            cardClass: "",
          };
          const { Icon, iconColor, boxBg, boxBorder, cardClass } = theme;

          return (
            <div key={t.id} className={`${styles.toolBox} ${cardClass}`}>
              <div
                className={styles.toolIconBox}
                style={{
                  background: boxBg,
                  borderColor: boxBorder,
                }}
              >
                <Icon size={20} color={iconColor} weight="duotone" />
              </div>
              <span className={styles.toolTitle}>{t.title}</span>
              <span className={styles.toolDesc}>{t.description}</span>
            </div>
          );
        })}
      </div>
    </ModuleCard>
  );
}
