import React from "react";
import styles from "./MaxPanel.module.css";
import {
  Sparkle,
  CaretRight,
  CaretLeft,
  Eye,
  WarningCircle,
  Lightning,
  Bell,
  UsersThree,
  Tag,
  Flask,
  ShieldWarning,
  FileText,
  ShieldCheck,
  Scales,
  CheckCircle,
} from "@phosphor-icons/react";

interface MaxPanelProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export function MaxPanel({ isCollapsed, onToggleCollapse }: MaxPanelProps) {
  const priorityItems = [
    {
      id: "p1",
      title: "Revise 5 variações de preço",
      context: "Radar detectou mudanças relevantes",
      Icon: Tag,
      iconColor: "#F28C28", // Centelha
    },
    {
      id: "p2",
      title: "3 fornecedores aguardam retorno",
      context: "Contatos sem atualização recente",
      Icon: UsersThree,
      iconColor: "#E45B4F", // Nexus
    },
    {
      id: "p3",
      title: "Teste de amostra pendente",
      context: "Decisão operacional aberta",
      Icon: Flask,
      iconColor: "#2F7DD9", // Boreal
    },
    {
      id: "p4",
      title: "2 alertas críticos ativos",
      context: "Revisão recomendada agora",
      Icon: ShieldWarning,
      iconColor: "#FF1B1B", // Solar
    },
  ];

  const assistantActions = [
    {
      id: "a1",
      label: "Resumir operação",
      Icon: FileText,
      iconColor: "#2F7DD9", // Boreal
    },
    {
      id: "a2",
      label: "Analisar alertas",
      Icon: ShieldCheck,
      iconColor: "#FF1B1B", // Solar
    },
    {
      id: "a3",
      label: "Comparar preços",
      Icon: Scales,
      iconColor: "#F28C28", // Centelha
    },
    {
      id: "a4",
      label: "Revisar fornecedores",
      Icon: CheckCircle,
      iconColor: "#49A67C", // Éter
    },
  ];

  return (
    <aside
      className={`${styles.maxPanel} ${
        isCollapsed ? styles.maxPanelCollapsed : ""
      }`}
    >
      {/* Header do Painel MAX */}
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

        <div className={styles.headerRight}>
          {!isCollapsed && (
            <div className={styles.contextBadge}>
              <span className={styles.contextDot} />
              <span>Contexto · Home</span>
            </div>
          )}

          {/* Controle de Recolher/Expandir */}
          <button
            type="button"
            className={styles.toggleCollapseBtn}
            onClick={onToggleCollapse}
            aria-label={
              isCollapsed ? "Expandir painel MAX" : "Recolher painel MAX"
            }
            title={
              isCollapsed ? "Expandir painel MAX" : "Recolher painel MAX"
            }
          >
            {isCollapsed ? (
              <CaretLeft size={14} weight="bold" />
            ) : (
              <CaretRight size={14} weight="bold" />
            )}
          </button>
        </div>
      </div>

      {!isCollapsed && (
        <div className={styles.panelBody}>
          {/* Bloco 1: Em foco (Síntese + Sinais) */}
          <div className={styles.contextCard}>
            <div className={styles.cardHead}>
              <div className={styles.cardIconBoxBlue}>
                <Eye size={15} color="#2F7DD9" weight="duotone" />
              </div>
              <span className={styles.cardHeadTitle}>Em foco</span>
            </div>
            <p className={styles.cardText}>
              A operação está estável. Os 5 alertas críticos e 3 fornecedores
              sem retorno merecem sua atenção agora.
            </p>

            {/* Sinais em foco compactos */}
            <div className={styles.signalsRow}>
              <div className={styles.signalChipRed}>
                <Bell size={12} weight="bold" />
                <span>5 alertas críticos</span>
              </div>
              <div className={styles.signalChipAmber}>
                <UsersThree size={12} weight="bold" />
                <span>3 pedem atenção</span>
              </div>
              <div className={styles.signalChipGreen}>
                <Tag size={12} weight="bold" />
                <span>8 quedas de preço</span>
              </div>
            </div>
          </div>

          {/* Bloco 2: O que merece atenção (Prioridades com microcontexto) */}
          <div className={styles.contextCard}>
            <div className={styles.cardHead}>
              <div className={styles.cardIconBoxPurple}>
                <WarningCircle size={15} color="#B01862" weight="duotone" />
              </div>
              <span className={styles.cardHeadTitle}>
                O que merece atenção
              </span>
            </div>

            <div className={styles.prioritiesList}>
              {priorityItems.map((item) => {
                const { Icon, iconColor } = item;
                return (
                  <div key={item.id} className={styles.priorityItem}>
                    <div className={styles.priorityLeft}>
                      <div className={styles.priorityIconBox}>
                        <Icon size={14} color={iconColor} weight="duotone" />
                      </div>
                      <div className={styles.priorityTexts}>
                        <span className={styles.priorityTitle}>
                          {item.title}
                        </span>
                        <span className={styles.priorityContext}>
                          {item.context}
                        </span>
                      </div>
                    </div>
                    <CaretRight size={13} color="#8FA1B2" weight="bold" />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Bloco 3: Ações com MAX */}
          <div className={styles.contextCard}>
            <div className={styles.cardHead}>
              <div className={styles.cardIconBoxCentelha}>
                <Lightning size={15} color="#F28C28" weight="fill" />
              </div>
              <span className={styles.cardHeadTitle}>Ações com MAX</span>
            </div>

            <div className={styles.assistantActionsGrid}>
              {assistantActions.map((action) => {
                const { Icon, iconColor } = action;
                return (
                  <button
                    key={action.id}
                    type="button"
                    className={styles.assistantActionBtn}
                  >
                    <Icon
                      size={14}
                      color={iconColor}
                      weight="duotone"
                      className={styles.assistantActionIcon}
                    />
                    <span className={styles.assistantActionLabel}>
                      {action.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Disclaimer discreto */}
          <div className={styles.disclaimer}>
            MAX pode cometer erros. Verifique as informações.
          </div>
        </div>
      )}
    </aside>
  );
}
