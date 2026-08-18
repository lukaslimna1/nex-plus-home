import React from "react";
import styles from "./TopStatusBar.module.css";
import { Cpu, Database, Sparkle, ShieldCheck } from "@phosphor-icons/react";

export function TopStatusBar() {
  return (
    <header className={styles.topHeader}>
      <div className={styles.headingCol}>
        <h1 className={styles.title}>Início</h1>
        <p className={styles.subtitle}>Centro operacional inteligente do NEX+.</p>
      </div>

      <div className={styles.statusBadgesRow}>
        {/* Local-first */}
        <div className={`${styles.badgeCard} ${styles.badgeGreen}`}>
          <Cpu size={17} weight="duotone" />
          <div className={styles.badgeTexts}>
            <span className={styles.badgeTitle} style={{ color: "#4ade80" }}>
              Local-first
            </span>
          </div>
        </div>

        {/* PostgreSQL */}
        <div className={`${styles.badgeCard} ${styles.badgeBlue}`}>
          <Database size={17} weight="duotone" color="#60a5fa" />
          <div className={styles.badgeTexts}>
            <span className={styles.badgeTitle}>PostgreSQL</span>
            <span className={styles.badgeSub}>Saudável</span>
          </div>
        </div>

        {/* MAX */}
        <div className={`${styles.badgeCard} ${styles.badgePurple}`}>
          <Sparkle size={17} weight="fill" color="#c084fc" />
          <div className={styles.badgeTexts}>
            <span className={styles.badgeTitle}>MAX</span>
            <span className={styles.badgeSub}>Assistente ativo</span>
          </div>
        </div>

        {/* Sistema */}
        <div className={`${styles.badgeCard} ${styles.badgeCyan}`}>
          <ShieldCheck size={17} weight="duotone" color="#38bdf8" />
          <div className={styles.badgeTexts}>
            <span className={styles.badgeTitle}>Sistema</span>
            <span className={styles.badgeSub}>Tudo operacional</span>
          </div>
        </div>
      </div>
    </header>
  );
}
