import React from "react";
import styles from "./MainHero.module.css";
import {
  UsersThree,
  Package,
  Bell,
  CheckSquareOffset,
} from "@phosphor-icons/react";
import { MOCK_METRICS } from "../../data/mockHomeData";

export function MainHero() {
  const metricConfigs = [
    {
      Icon: UsersThree,
      iconColor: "#E45B4F", // Nexus
      boxBg: "rgba(228, 91, 79, 0.12)",
      boxBorder: "rgba(228, 91, 79, 0.25)",
    },
    {
      Icon: Package,
      iconColor: "#F28C28", // Centelha
      boxBg: "rgba(242, 140, 40, 0.12)",
      boxBorder: "rgba(242, 140, 40, 0.25)",
    },
    {
      Icon: Bell,
      iconColor: "#FF1B1B", // Solar
      boxBg: "rgba(255, 27, 27, 0.12)",
      boxBorder: "rgba(255, 27, 27, 0.25)",
    },
    {
      Icon: CheckSquareOffset,
      iconColor: "#2F7DD9", // Boreal
      boxBg: "rgba(47, 125, 217, 0.12)",
      boxBorder: "rgba(47, 125, 217, 0.25)",
    },
  ];

  return (
    <section className={styles.heroBanner}>
      <div className={styles.greetingBlock}>
        <div className={styles.greetingTexts}>
          <h2 className={styles.greetingTitle}>Bom dia, Daniel!</h2>
          <p className={styles.greetingSubtitle}>
            Aqui está o resumo da sua operação.
            <br />
            Dados de exemplo para demonstração.
          </p>
        </div>
      </div>

      <div className={styles.metricsGroup}>
        {MOCK_METRICS.map((m, idx) => {
          const config = metricConfigs[idx];
          const { Icon, iconColor, boxBg, boxBorder } = config;
          const trendClass =
            m.trendType === "positive"
              ? styles.metricTrendPositive
              : m.trendType === "warning"
              ? styles.metricTrendWarning
              : styles.metricTrendNeutral;

          return (
            <div key={m.id} className={styles.metricItem}>
              <div
                className={styles.metricIconBox}
                style={{
                  background: boxBg,
                  borderColor: boxBorder,
                }}
              >
                <Icon size={19} color={iconColor} weight="duotone" />
              </div>
              <div className={styles.metricData}>
                <span className={styles.metricLabel}>{m.label}</span>
                <span className={styles.metricValue}>{m.value}</span>
                <span className={trendClass}>{m.trendText}</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
