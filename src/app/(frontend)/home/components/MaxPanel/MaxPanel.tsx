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
          <div className={styles.sparkleBox}>
            <Sparkle size={20} weight="fill" className={styles.sparkleIcon} />
          </div>
          {!isCollapsed && (
            <div className={styles.headerTitles}>
              <h3 className={styles.title}>MAX</h3>
              <p className={styles.subtitle}>Seu assistente estratégico</p>
            </div>
          )}
        </div>

        <button
          type="button"
          className={styles.collapseBtn}
          onClick={onToggleCollapse}
          aria-label={isCollapsed ? "Expandir painel MAX" : "Recolher painel MAX"}
          title={isCollapsed ? "Expandir painel MAX" : "Recolher painel MAX"}
        >
          <ArrowsOutSimple size={16} weight="bold" />
        </button>
      </div>

      {!isCollapsed && (
        <div className={styles.panelBody}>
          {/* Bloco 1: Resumo Contextual */}
          <div className={styles.contextCard}>
            <div className={styles.cardHead}>
              <div className={styles.cardIconBoxBlue}>
                <CheckSquareOffset size={15} color="#60a5fa" weight="bold" />
              </div>
              <span className={styles.cardHeadTitle}>Resumo</span>
            </div>
            <p className={styles.cardText}>
              Você tem 17 itens pendentes, 23 alertas ativos e 5 oportunidades
              detectadas. Seu sistema está saudável e pronto para novas análises.
            </p>
            {/* Sparkline de onda roxa */}
            <div className={styles.waveContainer}>
              <svg className={styles.waveChart} viewBox="0 0 260 30" fill="none">
                <path
                  d="M 2 20 Q 22 6, 45 22 T 90 12 T 135 24 T 180 8 T 225 18 T 258 4"
                  stroke="#c084fc"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <circle cx="258" cy="4" r="3" fill="#c084fc" />
              </svg>
            </div>
          </div>

          {/* Bloco 2: Sugestões Inteligentes */}
          <div className={styles.contextCard}>
            <div className={styles.cardHead}>
              <div className={styles.cardIconBoxPurple}>
                <Sparkle size={15} color="#c084fc" weight="fill" />
              </div>
              <span className={styles.cardHeadTitle}>Sugestões inteligentes</span>
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
                        size={15}
                        color={sug.color}
                        weight="bold"
                      />
                      <span className={styles.suggestionText}>{sug.title}</span>
                    </div>
                    <CaretRight size={13} color="#64748b" weight="bold" />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Bloco 3: Ações Rápidas */}
          <div className={styles.contextCard}>
            <div className={styles.cardHead}>
              <div className={styles.cardIconBoxAmber}>
                <Sparkle size={15} color="#f59e0b" weight="fill" />
              </div>
              <span className={styles.cardHeadTitle}>Ações rápidas</span>
            </div>

            <div className={styles.quickActionsGrid}>
              <button type="button" className={styles.quickActionBtn}>
                <UsersThree size={14} color="#f43f5e" weight="bold" />
                <span>Novo fornecedor</span>
              </button>
              <button type="button" className={styles.quickActionBtn}>
                <Package size={14} color="#fbbf24" weight="bold" />
                <span>Novo produto</span>
              </button>
              <button type="button" className={styles.quickActionBtn}>
                <Receipt size={14} color="#60a5fa" weight="bold" />
                <span>Nova cotação</span>
              </button>
              <button type="button" className={styles.quickActionBtn}>
                <Bell size={14} color="#f87171" weight="bold" />
                <span>Novo alerta</span>
              </button>
            </div>
          </div>

          <div className={styles.disclaimer}>
            MAX pode cometer erros. Verifique as informações.
          </div>
        </div>
      )}
    </aside>
  );
}
