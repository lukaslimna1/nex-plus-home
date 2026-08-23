"use client";

import React, { useState } from "react";
import Link from "next/link";
import styles from "./reset-password.module.css";
import { NexWordmark } from "../login/NexWordmark";
import { resetPasswordAction } from "@/auth/actions";

interface ResetPasswordFormProps {
  token?: string;
}

export function ResetPasswordForm({ token }: ResetPasswordFormProps) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  const cleanToken = (token || "").trim();

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (!cleanToken) {
      setErrorMessage("Token de recuperação ausente ou inválido. Solicite um novo link.");
      return;
    }

    if (password.length < 8) {
      setErrorMessage("A nova senha deve ter pelo menos 8 caracteres.");
      return;
    }

    if (password !== confirmPassword) {
      setErrorMessage("As senhas não coincidem.");
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const result = await resetPasswordAction({
        token: cleanToken,
        password,
        confirmPassword,
      });

      if (result.success) {
        setIsSuccess(true);
      } else {
        setErrorMessage(result.error || "O link de recuperação é inválido ou expirou.");
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
              {!cleanToken ? (
                <div className={styles.successCard}>
                  <div className={styles.successIconBadge} style={{ backgroundColor: "rgba(239, 68, 68, 0.15)", borderColor: "rgba(239, 68, 68, 0.35)", color: "#f87171" }} aria-hidden="true">
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="15" y1="9" x2="9" y2="15" />
                      <line x1="9" y1="9" x2="15" y2="15" />
                    </svg>
                  </div>

                  <h2 className={styles.successTitle}>Link Inválido</h2>
                  <p className={styles.successText}>
                    O link de recuperação não possui um token válido ou está incompleto.
                  </p>

                  <Link href="/forgot-password" className={styles.submitButton} style={{ textDecoration: "none", width: "100%" }}>
                    Solicitar Novo Link
                  </Link>
                </div>
              ) : !isSuccess ? (
                <>
                  <h2 className={styles.cardTitle}>Nova Senha</h2>
                  <p className={styles.cardSubtitle}>
                    Defina sua nova senha para acessar o NEX+.
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
                    {/* Nova Senha */}
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
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                      </span>
                      <input
                        id="password"
                        name="password"
                        type={showPassword ? "text" : "password"}
                        autoComplete="new-password"
                        required
                        disabled={isSubmitting}
                        placeholder="Nova senha (mínimo 8 caracteres)"
                        className={styles.inputField}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        aria-label="Nova senha"
                      />
                      <button
                        type="button"
                        className={styles.passwordToggle}
                        onClick={() => setShowPassword(!showPassword)}
                        aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                      >
                        {showPassword ? (
                          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                            <circle cx="12" cy="12" r="3" />
                            <line x1="2" y1="2" x2="22" y2="22" />
                          </svg>
                        ) : (
                          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        )}
                      </button>
                    </div>

                    {/* Confirmar Nova Senha */}
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
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                      </span>
                      <input
                        id="confirmPassword"
                        name="confirmPassword"
                        type={showConfirmPassword ? "text" : "password"}
                        autoComplete="new-password"
                        required
                        disabled={isSubmitting}
                        placeholder="Confirme a nova senha"
                        className={styles.inputField}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        aria-label="Confirmar nova senha"
                      />
                      <button
                        type="button"
                        className={styles.passwordToggle}
                        onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                        aria-label={showConfirmPassword ? "Ocultar confirmação de senha" : "Mostrar confirmação de senha"}
                      >
                        {showConfirmPassword ? (
                          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                            <circle cx="12" cy="12" r="3" />
                            <line x1="2" y1="2" x2="22" y2="22" />
                          </svg>
                        ) : (
                          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        )}
                      </button>
                    </div>

                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className={styles.submitButton}
                    >
                      {isSubmitting ? "Redefinindo senha..." : "Salvar nova senha"}
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

                  <h2 className={styles.successTitle}>Senha Alterada</h2>
                  <p className={styles.successText}>
                    Sua nova senha foi salva com sucesso. Você já pode acessar sua conta com as novas credenciais.
                  </p>

                  <Link href="/login" className={styles.submitButton} style={{ textDecoration: "none", width: "100%" }}>
                    Ir para o Login
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
