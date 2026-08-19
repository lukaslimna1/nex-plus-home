import React from "react";
import styles from "./TopStatusBar.module.css";
import { HardDrives, Database, Sparkle, ShieldCheck } from "@phosphor-icons/react";

export function TopStatusBar() {
  return (
    <header className={styles.topHeader}>
      <div className={styles.headingCol}>
        <h1 className={styles.title}>Início</h1>
        <p className={styles.subtitle}>Centro operacional inteligente do NEX+.</p>
      </div>

      <div className={styles.statusBadgesRow}>
        {/* Local-first */}
        <div className={`${styles.badgeCard} ${styles.badgeEther}`}>
          <div className={styles.iconContainer}>
            <HardDrives size={19} weight="duotone" />
          </div>
          <div className={styles.badgeTexts}>
            <span className={styles.badgeTitle}>Local-first</span>
          </div>
        </div>

        {/* PostgreSQL */}
        <div className={`${styles.badgeCard} ${styles.badgeBoreal}`}>
          <div className={styles.iconContainer}>
            <Database size={19} weight="duotone" />
          </div>
          <div className={styles.badgeTexts}>
            <span className={styles.badgeTitle}>PostgreSQL</span>
            <span className={styles.badgeSub}>Saudável</span>
          </div>
        </div>

        {/* MAX */}
        <div className={`${styles.badgeCard} ${styles.badgeArcana}`}>
          <div className={styles.iconContainer}>
            <Sparkle size={19} weight="fill" />
          </div>
          <div className={styles.badgeTexts}>
            <span className={styles.badgeTitle}>MAX</span>
            <span className={styles.badgeSub}>Assistente ativo</span>
          </div>
        </div>

        {/* Sistema */}
        <div className={`${styles.badgeCard} ${styles.badgeFoton}`}>
          <div className={styles.iconContainer}>
            <ShieldCheck size={19} weight="duotone" />
          </div>
          <div className={styles.badgeTexts}>
            <span className={styles.badgeTitle}>Sistema</span>
            <span className={styles.badgeSub}>Tudo operacional</span>
          </div>
        </div>
      </div>
    </header>
  );
}
