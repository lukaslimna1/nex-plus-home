import React from "react";
import styles from "./MaxPanel.module.css";
import {
  Sparkle,
  ArrowsOutSimple,
  CaretRight,
  CheckSquareOffset,
  CheckCircle,
  UsersThree,
  Receipt,
  ShieldCheck,
  Package,
  Bell,
} from "@phosphor-icons/react";
import { MOCK_MAX_SUGGESTIONS } from "../../data/mockHomeData";

interface MaxPanelProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export function MaxPanel({ isCollapsed, onToggleCollapse }: MaxPanelProps) {
  return (
    <aside
      className={`${styles.maxPanel} ${
        isCollapsed ? styles.maxPanelCollapsed : ""
      }`}
    >
      <div className={styles.headerRow}>
        <div className={styles.titleArea}>
          {!isCollapsed && (
            <h3 className={styles.title}>MAX</h3>
          )}
        </div>

        <button
          type="button"
          className={styles.collapseBtn}
          onClick={onToggleCollapse}
          aria-label={isCollapsed ? "Expandir painel MAX" : "Recolher painel MAX"}
          title={isCollapsed ? "Expandir painel MAX" : "Recolher painel MAX"}
        >
          <ArrowsOutSimple size={16} />
        </button>
      </div>

      {!isCollapsed && (
        <>
          <p className={styles.tagline}>Seu assistente estratégico</p>

          {/* Bloco 1: Resumo Contextual */}
          <div className={styles.contextCard}>
            <div className={styles.cardHead}>
              <CheckSquareOffset size={16} color="#60a5fa" weight="bold" />
              <span>Resumo</span>
            </div>
            <p className={styles.cardText}>
              Você tem 17 itens pendentes, 23 alertas ativos e 5 oportunidades
              detectadas. Seu sistema está saudável e pronto para novas análises.
            </p>
          </div>

          {/* Bloco 2: Sugestões Inteligentes */}
          <div className={styles.contextCard}>
            <div className={styles.cardHead}>
              <Sparkle size={16} color="#c084fc" weight="duotone" />
              <span>Sugestões inteligentes</span>
            </div>

            <div className={styles.suggestionsList}>
              {MOCK_MAX_SUGGESTIONS.map((sug, index) => {
                const IconComponent =
                  index === 0
                    ? CheckCircle
                    : index === 1
                    ? UsersThree
                    : index === 2
                    ? Receipt
                    : ShieldCheck;

                return (
                  <div key={sug.id} className={styles.suggestionItem}>
                    <div className={styles.suggestionLeft}>
                      <IconComponent
                        size={14}
                        color={sug.color}
                        weight="bold"
                      />
                      <span>{sug.title}</span>
                    </div>
                    <CaretRight size={11} color="#64748b" />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Bloco 3: Ações Rápidas */}
          <div className={styles.contextCard}>
            <div className={styles.cardHead}>
              <Sparkle size={16} color="#f59e0b" weight="fill" />
              <span>Ações rápidas</span>
            </div>

            <div className={styles.quickActionsGrid}>
              <button type="button" className={styles.quickActionBtn}>
                <UsersThree size={13} color="#f43f5e" />
                <span>Novo fornecedor</span>
              </button>
              <button type="button" className={styles.quickActionBtn}>
                <Package size={13} color="#fbbf24" />
                <span>Novo produto</span>
              </button>
              <button type="button" className={styles.quickActionBtn}>
                <Receipt size={13} color="#60a5fa" />
                <span>Nova cotação</span>
              </button>
              <button type="button" className={styles.quickActionBtn}>
                <Bell size={13} color="#f87171" />
                <span>Novo alerta</span>
              </button>
            </div>
          </div>

          {/* Disclaimer do MAX — sem input de chat aqui */}
          <div className={styles.disclaimer}>
            MAX pode cometer erros. Verifique as informações.
          </div>
        </>
      )}
    </aside>
  );
}
