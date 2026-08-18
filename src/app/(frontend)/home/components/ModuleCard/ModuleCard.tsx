import React from "react";
import styles from "./ModuleCard.module.css";
import { ArrowRight } from "@phosphor-icons/react";

interface ModuleCardProps {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  themeColor: "red" | "amber" | "purple";
  actionLabel: string;
  onActionClick?: () => void;
  children: React.ReactNode;
}

export function ModuleCard({
  title,
  subtitle,
  icon,
  themeColor,
  actionLabel,
  onActionClick,
  children,
}: ModuleCardProps) {
  const borderClass =
    themeColor === "red"
      ? styles.borderRed
      : themeColor === "amber"
      ? styles.borderAmber
      : styles.borderPurple;

  const iconClass =
    themeColor === "red"
      ? styles.iconRed
      : themeColor === "amber"
      ? styles.iconAmber
      : styles.iconPurple;

  const btnClass =
    themeColor === "red"
      ? styles.btnRed
      : themeColor === "amber"
      ? styles.btnAmber
      : styles.btnPurple;

  return (
    <div className={`${styles.moduleCard} ${borderClass}`}>
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {/* Header do Card */}
        <div className={styles.cardHeader}>
          <div className={`${styles.iconBox} ${iconClass}`}>{icon}</div>
          <div className={styles.headerTexts}>
            <h3 className={styles.title}>{title}</h3>
            <p className={styles.subtitle}>{subtitle}</p>
          </div>
        </div>

        {/* Conteúdo Interno Específico do Módulo */}
        {children}
      </div>

      {/* Botão de Rodapé */}
      <button
        type="button"
        className={`${styles.actionButton} ${btnClass}`}
        onClick={onActionClick}
      >
        <span>{actionLabel}</span>
        <ArrowRight size={14} weight="bold" />
      </button>
    </div>
  );
}
