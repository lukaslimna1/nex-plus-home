"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./login.module.css";
import { NexWordmark } from "./NexWordmark";
import { loginAction } from "@/auth/actions";

export function LoginForm() {
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const result = await loginAction({ email, password });
      if (result.success) {
        router.push("/home");
        router.refresh();
      } else {
        setErrorMessage(result.error || "E-mail ou senha inválidos.");
        setIsSubmitting(false);
      }
    } catch {
      setErrorMessage("Erro ao conectar. Tente novamente.");
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

        {/* Linhas Orbitais Vetoriais Sutis */}
        <svg
          className={styles.orbitalSvg}
          viewBox="0 0 1440 900"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <ellipse
            cx="250"
            cy="750"
            rx="680"
            ry="450"
            stroke="url(#orbitalGradient1)"
            strokeWidth="1.2"
            strokeDasharray="4 8"
            opacity="0.35"
          />
          <ellipse
            cx="200"
            cy="800"
            rx="920"
            ry="600"
            stroke="url(#orbitalGradient2)"
            strokeWidth="0.8"
            opacity="0.25"
          />
          <ellipse
            cx="150"
            cy="850"
            rx="1200"
            ry="800"
            stroke="url(#orbitalGradient1)"
            strokeWidth="0.6"
            opacity="0.15"
          />
          <defs>
            <linearGradient
              id="orbitalGradient1"
              x1="0%"
              y1="100%"
              x2="100%"
              y2="0%"
            >
              <stop offset="0%" stopColor="#818cf8" stopOpacity="0.8" />
              <stop offset="50%" stopColor="#c084fc" stopOpacity="0.4" />
              <stop offset="100%" stopColor="#ec4899" stopOpacity="0" />
            </linearGradient>
            <linearGradient
              id="orbitalGradient2"
              x1="0%"
              y1="0%"
              x2="100%"
              y2="100%"
            >
              <stop offset="0%" stopColor="#6366f1" stopOpacity="0" />
              <stop offset="40%" stopColor="#a855f7" stopOpacity="0.6" />
              <stop offset="100%" stopColor="#f97316" stopOpacity="0" />
            </linearGradient>
          </defs>
        </svg>

        {/* Partículas de Luz Sutis */}
        <div className={styles.star1} />
        <div className={styles.star2} />
        <div className={styles.star3} />
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

        {/* Coluna Direita — Card de Login */}
        <section className={styles.cardSection}>
          <div className={styles.loginCardWrapper}>
            <div className={styles.loginCard}>
              <h2 className={styles.cardTitle}>Login</h2>
              <p className={styles.cardSubtitle}>
                Acesse sua conta para continuar.
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
                {/* Campo E-mail */}
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
                    placeholder="E-mail"
                    className={styles.inputField}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    aria-label="Endereço de e-mail"
                  />
                </div>

                {/* Campo Senha */}
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
                      <rect
                        x="3"
                        y="11"
                        width="18"
                        height="11"
                        rx="2"
                        ry="2"
                      />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </span>
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    required
                    disabled={isSubmitting}
                    placeholder="Senha"
                    className={styles.inputField}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-label="Senha"
                  />
                  <button
                    type="button"
                    className={styles.passwordToggle}
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                  >
                    {showPassword ? (
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
                        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                        <circle cx="12" cy="12" r="3" />
                        <line x1="2" y1="2" x2="22" y2="22" />
                      </svg>
                    ) : (
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
                        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>

                {/* Opções (Manter conectado & Esqueci minha senha) */}
                <div className={styles.optionsRow}>
                  <label
                    className={`${styles.rememberLabel} ${styles.disabledControl}`}
                    htmlFor="rememberMe"
                    title="Disponível em uma etapa futura."
                  >
                    <input
                      id="rememberMe"
                      name="rememberMe"
                      type="checkbox"
                      disabled
                      aria-label="Manter conectado (Disponível em uma etapa futura)"
                      className={styles.customCheckbox}
                      checked={false}
                      onChange={() => {}}
                    />
                    <span>Manter conectado</span>
                  </label>

                  <a
                    href="#esqueci-senha"
                    className={`${styles.forgotLink} ${styles.disabledControl}`}
                    title="Disponível em uma etapa futura."
                    aria-disabled="true"
                    onClick={(e) => {
                      e.preventDefault();
                    }}
                  >
                    Esqueci minha senha?
                  </a>
                </div>

                {/* Botão Entrar */}
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className={styles.submitButton}
                >
                  {isSubmitting ? "Entrando..." : "Entrar"}
                </button>
              </form>

              {/* Divisor do Card */}
              <div className={styles.cardDivider} aria-hidden="true" />

              {/* Rodapé do Card — Acesso Restrito */}
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
