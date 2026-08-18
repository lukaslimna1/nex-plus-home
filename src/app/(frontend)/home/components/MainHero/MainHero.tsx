import React from "react";
import styles from "./MainHero.module.css";
import { UsersThree, Package, Bell, CheckSquareOffset } from "@phosphor-icons/react";
import { MOCK_METRICS } from "../../data/mockHomeData";

export function MainHero() {
  const metricIcons = [
    { Icon: UsersThree, color: "#F43F5E" },
    { Icon: Package, color: "#FB923C" },
    { Icon: Bell, color: "#F87171" },
    { Icon: CheckSquareOffset, color: "#60A5FA" },
  ];

  return (
    <section className={styles.heroBanner}>
      <div className={styles.greetingBlock}>
        <div className={styles.greetingIcon}>N</div>
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
          const { Icon, color } = metricIcons[idx];
          const trendClass =
            m.trendType === "positive"
              ? styles.metricTrendPositive
              : m.trendType === "warning"
              ? styles.metricTrendWarning
              : styles.metricTrendNeutral;

          return (
            <div key={m.id} className={styles.metricItem}>
              <div className={styles.metricIconBox}>
                <Icon size={17} color={color} />
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
