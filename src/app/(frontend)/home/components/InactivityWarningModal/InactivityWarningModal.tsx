"use client";

import React from "react";
import styles from "./inactivity-modal.module.css";

interface InactivityWarningModalProps {
  countdownSeconds: number;
  onStayLoggedIn: () => void;
  onLogout: () => void;
  isSubmitting?: boolean;
}

export function InactivityWarningModal({
  countdownSeconds,
  onStayLoggedIn,
  onLogout,
  isSubmitting = false,
}: InactivityWarningModalProps) {
  const formattedCountdown = `00:${String(Math.max(0, countdownSeconds)).padStart(2, "0")}`;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="inactivity-title">
      <div className={styles.modalWrapper}>
        <div className={styles.modalCard}>
          <div className={styles.iconBadge} aria-hidden="true">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>

          <h2 id="inactivity-title" className={styles.title}>
            Sessão Prestes a Expirar
          </h2>

          <p className={styles.description}>
            Detectamos inatividade por mais de 10 minutos. Por segurança operacional, sua sessão será encerrada em:
          </p>

          <div className={styles.countdownBadge} aria-live="assertive">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 2v4" />
              <path d="M12 18v4" />
              <path d="M4.93 4.93l2.83 2.83" />
              <path d="M16.24 16.24l2.83 2.83" />
              <path d="M2 12h4" />
              <path d="M18 12h4" />
              <path d="M4.93 19.07l2.83-2.83" />
              <path d="M16.24 7.76l2.83-2.83" />
            </svg>
            <span>{formattedCountdown}</span>
          </div>

          <div className={styles.buttonRow}>
            <button
              type="button"
              disabled={isSubmitting}
              className={styles.primaryButton}
              onClick={onStayLoggedIn}
            >
              {isSubmitting ? "Renovando sessão..." : "Continuar sessão"}
            </button>

            <button
              type="button"
              disabled={isSubmitting}
              className={styles.secondaryButton}
              onClick={onLogout}
            >
              Sair agora
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
