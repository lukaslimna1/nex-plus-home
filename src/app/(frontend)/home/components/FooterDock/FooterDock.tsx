import React from "react";
import styles from "./FooterDock.module.css";
import {
  Sparkle,
  CaretDown,
  CaretUp,
  CalendarCheck,
  Bell,
  ShieldCheck,
  ArrowsClockwise,
} from "@phosphor-icons/react";
import { MOCK_NOTIFICATIONS } from "../../data/mockHomeData";

export function FooterDock() {
  return (
    <footer className={styles.footerDock}>
      <div className={styles.leftSection}>
        <div className={styles.maxIconCircle}>M</div>
        <span className={styles.maxLabel}>MAX</span>
        <div className={styles.badgePill}>
          <span>3 notificações inteligentes</span>
          <CaretDown size={11} />
        </div>
      </div>

      {/* Faixa Central de Notificações / Status */}
      <div className={styles.statusTrack}>
        {MOCK_NOTIFICATIONS.map((notif, idx) => {
          const IconComponent =
            idx === 0
              ? CalendarCheck
              : idx === 1
              ? Bell
              : idx === 2
              ? ShieldCheck
              : ArrowsClockwise;

          return (
            <div key={notif.id} className={styles.statusItem}>
              <div className={styles.statusIconBox}>
                <IconComponent size={13} color={notif.iconColor} />
              </div>
              <span>
                <strong style={{ color: "#ffffff" }}>{notif.title}</strong> ·{" "}
                {notif.subtitle}
              </span>
            </div>
          );
        })}
      </div>

      {/* Botão de Abrir Conversa Completa */}
      <div className={styles.rightSection}>
        <button type="button" className={styles.openChatBtn}>
          <Sparkle size={14} weight="fill" />
          <span>Abrir conversa com MAX</span>
        </button>
        <button
          type="button"
          className={styles.chevronBtn}
          aria-label="Opções adicionais do footer"
        >
          <CaretUp size={14} />
        </button>
      </div>
    </footer>
  );
}
