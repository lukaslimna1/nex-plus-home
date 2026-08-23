"use client";

import React, { useState } from "react";
import Link from "next/link";
import styles from "./forgot-password.module.css";
import { NexWordmark } from "../login/NexWordmark";
import { forgotPasswordAction } from "@/auth/actions";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [submittedMessage, setSubmittedMessage] = useState("");

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const result = await forgotPasswordAction({ email });
      if (result.success) {
        setIsSubmitted(true);
        setSubmittedMessage(result.message);
      } else {
        setErrorMessage(result.error || "Ocorreu um erro ao processar a solicitação.");
        setIsSubmitting(false);
      }
    } catch {
      setErrorMessage("Erro ao conectar. Tente novamente mais tarde.");
      setIsSubmitting(false);
    }
  };

  return (
    <div className={styles.container}>
      {/* Camada Atmosférica de Fundo */}
      <div className={styles.ambientBackground} aria-hidden="true">
        <div className={styles.glowBottomLeft} />
        <div className={styles.glowTopRight} />
        <div className={styles.glowCenterCard} />
      </div>

      {/* Grid Principal */}
      <main className={styles.mainWrapper}>
        {/* Coluna Esquerda — Institucional */}
        <section className={styles.brandSection}>
          <div className={styles.logoRow}>
            <NexWordmark className={styles.wordmarkSvg} />
          </div>

          <h1 className={styles.brandTagline}>
            Sistema Operacional Inteligente
          </h1>

          <div className={styles.gradientDivider} aria-hidden="true" />

          <p className={styles.brandDescription}>
            Ambiente seguro para operação e conhecimento.
          </p>
        </section>

        {/* Coluna Direita — Card */}
        <section className={styles.cardSection}>
          <div className={styles.loginCardWrapper}>
            <div className={styles.loginCard}>
              {!isSubmitted ? (
                <>
                  <h2 className={styles.cardTitle}>Recuperar Senha</h2>
                  <p className={styles.cardSubtitle}>
                    Informe seu e-mail cadastrado para receber o link de redefinição.
                  </p>

                  {errorMessage && (
                    <div className={styles.errorBanner} role="alert">
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                      <span>{errorMessage}</span>
                    </div>
                  )}

                  <form className={styles.form} onSubmit={handleSubmit}>
                    <div className={styles.inputGroup}>
                      <span className={styles.inputIconLeft} aria-hidden="true">
                        <svg
                          width="19"
                          height="19"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <rect x="2" y="4" width="20" height="16" rx="2" />
                          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                        </svg>
                      </span>
                      <input
                        id="email"
                        name="email"
                        type="email"
                        autoComplete="email"
                        required
                        disabled={isSubmitting}
                        placeholder="Seu e-mail cadastrado"
                        className={styles.inputField}
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        aria-label="Endereço de e-mail cadastrado"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className={styles.submitButton}
                    >
                      {isSubmitting ? "Enviando instruções..." : "Enviar instruções"}
                    </button>

                    <Link href="/login" className={styles.secondaryButton}>
                      Voltar ao Login
                    </Link>
                  </form>
                </>
              ) : (
                <div className={styles.successCard}>
                  <div className={styles.successIconBadge} aria-hidden="true">
                    <svg
                      width="26"
                      height="26"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </svg>
                  </div>

                  <h2 className={styles.successTitle}>Solicitação Enviada</h2>
                  <p className={styles.successText}>
                    {submittedMessage ||
                      "Se existir uma conta associada a este e-mail, você receberá as instruções para redefinir sua senha."}
                  </p>

                  <Link href="/login" className={styles.submitButton} style={{ textDecoration: "none", width: "100%" }}>
                    Voltar ao Login
                  </Link>
                </div>
              )}

              {/* Divisor do Card */}
              <div className={styles.cardDivider} aria-hidden="true" />

              {/* Rodapé do Card */}
              <div className={styles.restrictedFooter}>
                <span className={styles.shieldIcon} aria-hidden="true">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    <path d="m9 12 2 2 4-4" />
                  </svg>
                </span>
                <span>Acesso somente para usuários autorizados.</span>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
