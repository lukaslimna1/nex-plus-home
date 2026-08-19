import React from "react";
import styles from "./SuppliersPanel.module.css";
import { ModuleCard } from "../ModuleCard/ModuleCard";
import {
  UsersThree,
  CurrencyCircleDollar,
  Truck,
  Star,
  Flask,
  CaretRight,
} from "@phosphor-icons/react";
import { MOCK_SUPPLIERS } from "../../data/mockHomeData";

const supplierAvatarThemes: Record<
  string,
  { bg: string; color: string; border: string }
> = {
  "sup-1": {
    bg: "rgba(228, 91, 79, 0.14)", // Nexus
    color: "#E45B4F",
    border: "rgba(228, 91, 79, 0.35)",
  },
  "sup-2": {
    bg: "rgba(176, 24, 98, 0.14)", // Pulso
    color: "#B01862",
    border: "rgba(176, 24, 98, 0.35)",
  },
  "sup-3": {
    bg: "rgba(255, 179, 0, 0.14)", // Incandescente
    color: "#FFB300",
    border: "rgba(255, 179, 0, 0.35)",
  },
  "sup-4": {
    bg: "rgba(47, 125, 217, 0.14)", // Boreal
    color: "#2F7DD9",
    border: "rgba(47, 125, 217, 0.35)",
  },
};

export function SuppliersPanel() {
  return (
    <ModuleCard
      title="Fornecedores"
      subtitle="Gestão completa de contatos, preços e histórico."
      icon={<UsersThree size={20} weight="duotone" />}
      themeColor="red"
      actionLabel="Abrir fornecedores"
    >
      {/* 6 Chips de Métricas Coloridos (KPIs Preservados da Parte 1B) */}
      <div className={styles.chipsGrid}>
        <div className={styles.chipItem}>
          <UsersThree size={13} className={styles.chipIconRed} />
          <span className={styles.chipLabel}>Fornecedores</span>
          <span className={styles.chipValue}>128</span>
        </div>
        <div className={styles.chipItem}>
          <UsersThree size={13} className={styles.chipIconPurple} />
          <span className={styles.chipLabel}>Contatos</span>
          <span className={styles.chipValue}>342</span>
        </div>
        <div className={styles.chipItem}>
          <CurrencyCircleDollar size={13} className={styles.chipIconBlue} />
          <span className={styles.chipLabel}>Preços ativos</span>
          <span className={styles.chipValue}>1.842</span>
        </div>
        <div className={styles.chipItem}>
          <Truck size={13} className={styles.chipIconGreen} />
          <span className={styles.chipLabel}>Fretes</span>
          <span className={styles.chipValue}>215</span>
        </div>
        <div className={styles.chipItem}>
          <Star size={13} weight="fill" className={styles.chipIconYellow} />
          <span className={styles.chipLabel}>Avaliações</span>
          <span className={styles.chipValue}>4,6</span>
        </div>
        <div className={styles.chipItem}>
          <Flask size={13} className={styles.chipIconPink} />
          <span className={styles.chipLabel}>Testes</span>
          <span className={styles.chipValue}>86</span>
        </div>
      </div>

      {/* Subheader */}
      <div className={styles.subHeader}>
        <span className={styles.subHeaderTitle}>
          Últimos fornecedores adicionados
        </span>
        <a className={styles.subHeaderLink}>
          <span>Ver todos</span>
          <CaretRight size={12} weight="bold" />
        </a>
      </div>

      {/* Lista de Fornecedores Recentes */}
      <div className={styles.suppliersList}>
        {MOCK_SUPPLIERS.map((s) => {
          const avatarTheme = supplierAvatarThemes[s.id] || {
            bg: "rgba(247, 242, 255, 0.10)",
            color: "#F7F2FF",
            border: "rgba(247, 242, 255, 0.20)",
          };

          return (
            <div key={s.id} className={styles.supplierRow}>
              <div className={styles.supplierLeft}>
                <div
                  className={styles.letterAvatar}
                  style={{
                    background: avatarTheme.bg,
                    color: avatarTheme.color,
                    border: `1px solid ${avatarTheme.border}`,
                  }}
                >
                  {s.initial}
                </div>
                <div className={styles.detailsCol}>
                  <span className={styles.nameText}>{s.name}</span>
                  <span className={styles.categoryText}>{s.category}</span>
                </div>
              </div>

              <div className={styles.rightCol}>
                <div
                  className={
                    s.status === "Em teste"
                      ? styles.statusIndicatorTest
                      : styles.statusIndicatorActive
                  }
                >
                  <div
                    className={
                      s.status === "Em teste" ? styles.dotAmber : styles.dotGreen
                    }
                  />
                  <span>{s.status}</span>
                </div>
                <span className={styles.timeText}>{s.updatedAt}</span>
              </div>
            </div>
          );
        })}
      </div>
    </ModuleCard>
  );
}
