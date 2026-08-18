import React from "react";
import styles from "./SuppliersPanel.module.css";
import { ModuleCard } from "../ModuleCard/ModuleCard";
import {
  UsersThree,
  CurrencyCircleDollar,
  Truck,
  Star,
  Flask,
} from "@phosphor-icons/react";
import { MOCK_SUPPLIERS } from "../../data/mockHomeData";

export function SuppliersPanel() {
  return (
    <ModuleCard
      title="Fornecedores"
      subtitle="Gestão completa de contatos, preços e histórico."
      icon={<UsersThree size={22} weight="duotone" />}
      themeColor="red"
      actionLabel="Abrir fornecedores"
    >
      {/* 6 Chips de Métricas Coloridos */}
      <div className={styles.chipsGrid}>
        <div className={styles.chipItem}>
          <UsersThree size={14} className={styles.chipIconRed} />
          <span className={styles.chipLabel}>Fornecedores</span>
          <span className={styles.chipValue}>128</span>
        </div>
        <div className={styles.chipItem}>
          <UsersThree size={14} className={styles.chipIconPurple} />
          <span className={styles.chipLabel}>Contatos</span>
          <span className={styles.chipValue}>342</span>
        </div>
        <div className={styles.chipItem}>
          <CurrencyCircleDollar size={14} className={styles.chipIconBlue} />
          <span className={styles.chipLabel}>Preços ativos</span>
          <span className={styles.chipValue}>1.842</span>
        </div>
        <div className={styles.chipItem}>
          <Truck size={14} className={styles.chipIconGreen} />
          <span className={styles.chipLabel}>Fretes</span>
          <span className={styles.chipValue}>215</span>
        </div>
        <div className={styles.chipItem}>
          <Star size={14} weight="fill" className={styles.chipIconYellow} />
          <span className={styles.chipLabel}>Avaliações</span>
          <span className={styles.chipValue}>4,6</span>
        </div>
        <div className={styles.chipItem}>
          <Flask size={14} className={styles.chipIconPink} />
          <span className={styles.chipLabel}>Testes</span>
          <span className={styles.chipValue}>86</span>
        </div>
      </div>

      {/* Subheader */}
      <div className={styles.subHeader}>
        <span className={styles.subHeaderTitle}>
          Últimos fornecedores adicionados
        </span>
        <a className={styles.subHeaderLink}>Ver todos</a>
      </div>

      {/* Lista de Fornecedores Recentes */}
      <div className={styles.suppliersList}>
        {MOCK_SUPPLIERS.map((s) => (
          <div key={s.id} className={styles.supplierRow}>
            <div className={styles.supplierLeft}>
              <div
                className={styles.letterAvatar}
                style={{
                  background: `${s.themeColor}1a`,
                  color: s.themeColor,
                  border: `1px solid ${s.themeColor}4d`,
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
        ))}
      </div>
    </ModuleCard>
  );
}
