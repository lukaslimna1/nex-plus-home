import React, { useState } from "react";
import styles from "./FooterDock.module.css";
import {
  Sparkle,
  CaretUp,
  CaretDown,
  TrendDown,
  Bell,
  CheckCircle,
  Clock,
  ArrowRight,
} from "@phosphor-icons/react";

interface MaxActivity {
  id: string;
  title: string;
  subtitle: string;
  time: string;
  icon: React.ElementType;
  iconColor: string;
}

export function FooterDock() {
  const [isActivitiesOpen, setIsActivitiesOpen] = useState(false);

  const recentActivities: MaxActivity[] = [
    {
      id: "act-1",
      title: "Pesquisa de mercado finalizada",
      subtitle: "8 produtos com variação detectada no Mercado Livre",
      time: "Há 12 min",
      icon: CheckCircle,
      iconColor: "#49A67C", // Éter
    },
    {
      id: "act-2",
      title: "Monitoramento de fornecedores",
      subtitle: "Alerta emitido para Tech Parts Brasil",
      time: "Há 45 min",
      icon: Bell,
      iconColor: "#FF1B1B", // Solar
    },
    {
      id: "act-3",
      title: "Relatório de cotações gerado",
      subtitle: "Comparativo salvo e disponível para análise",
      time: "Há 2 horas",
      icon: Clock,
      iconColor: "#2F7DD9", // Boreal
    },
  ];

  return (
    <div className={styles.dockWrapper}>
      {/* Gaveta de Atividades Recentes do MAX (Expansão Local) */}
      {isActivitiesOpen && (
        <div className={styles.activitiesDrawer}>
          <div className={styles.drawerHeader}>
            <div className={styles.drawerTitleRow}>
              <Sparkle size={15} weight="fill" color="#B01862" />
              <span className={styles.drawerTitle}>
                Atividades recentes do MAX
              </span>
            </div>
            <span className={styles.drawerSubtitle}>
              Últimas ações e análises executadas
            </span>
          </div>

          <div className={styles.activitiesList}>
            {recentActivities.map((act) => {
              const { icon: ActIcon, iconColor } = act;
              return (
                <div key={act.id} className={styles.activityItem}>
                  <div className={styles.activityIconBox}>
                    <ActIcon size={14} color={iconColor} weight="duotone" />
                  </div>
                  <div className={styles.activityTexts}>
                    <span className={styles.activityTitle}>{act.title}</span>
                    <span className={styles.activitySubtitle}>
                      {act.subtitle}
                    </span>
                  </div>
                  <span className={styles.activityTime}>{act.time}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Dock Principal do MAX */}
      <footer className={styles.footerDock}>
        {/* Região Esquerda: Identidade MAX */}
        <div className={styles.leftSection}>
          <div className={styles.sparkleBox}>
            <Sparkle size={18} weight="fill" className={styles.sparkleIcon} />
          </div>
          <div className={styles.maxTitles}>
            <span className={styles.maxLabel}>MAX</span>
            <span className={styles.maxStatus}>Pronto para ajudar</span>
          </div>
        </div>

        {/* Região Central: Linha Principal de Comunicação Ativa do MAX */}
        <div className={styles.speechTrack}>
          <div className={styles.speechIconBox}>
            <TrendDown size={16} color="#49A67C" weight="bold" />
          </div>
          <div className={styles.speechTexts}>
            <span className={styles.speechPrimary}>
              “Terminei a análise que você pediu.”
            </span>
            <span className={styles.speechSecondary}>
              Encontrei 8 quedas de preço relevantes no Radar.
            </span>
          </div>
          <div className={styles.speechActionBadge}>
            <span>Ver resultado</span>
            <ArrowRight size={11} weight="bold" />
          </div>
        </div>

        {/* Região Direita: Ações & Expansão */}
        <div className={styles.rightSection}>
          <button type="button" className={styles.openChatBtn}>
            <Sparkle size={15} weight="fill" />
            <span>Abrir conversa com MAX</span>
          </button>

          <button
            type="button"
            className={styles.chevronBtn}
            onClick={() => setIsActivitiesOpen(!isActivitiesOpen)}
            aria-label={
              isActivitiesOpen
                ? "Recolher atividades do MAX"
                : "Expandir atividades do MAX"
            }
            title={
              isActivitiesOpen
                ? "Recolher atividades do MAX"
                : "Expandir atividades do MAX"
            }
          >
            {isActivitiesOpen ? (
              <CaretDown size={14} weight="bold" />
            ) : (
              <CaretUp size={14} weight="bold" />
            )}
          </button>
        </div>
      </footer>
    </div>
  );
}
