"use client";

import React, { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import styles from "./UserMiniCard.module.css";
import { CaretDown, SignOut } from "@phosphor-icons/react";
import { getInitials, type AppUserView } from "@/auth/identity";
import { logoutAction } from "@/auth/actions";

interface UserMiniCardProps {
  isCollapsed: boolean;
  user?: AppUserView | null;
}

export function UserMiniCard({ isCollapsed, user }: UserMiniCardProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const displayName = user?.displayName || "Usuário";
  const initials = getInitials(displayName);
  const roleLabel = "Usuário NEX+";

  // Fecha o dropdown ao clicar fora
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handleToggle = () => {
    setIsOpen((prev) => !prev);
  };

  const handleLogout = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    setLogoutError(null);
    try {
      const res = await logoutAction();
      if (res.success) {
        router.push("/login");
        router.refresh();
      } else {
        setLogoutError(res.error || "Não foi possível encerrar a sessão.");
        setIsLoggingOut(false);
      }
    } catch {
      setLogoutError("Erro ao encerrar a sessão.");
      setIsLoggingOut(false);
    }
  };

  return (
    <div className={styles.cardContainer} ref={containerRef}>
      {isOpen && (
        <div
          className={`${styles.menuDropdown} ${
            isCollapsed ? styles.menuDropdownCollapsed : ""
          }`}
          role="menu"
          aria-label="Opções do usuário"
        >
          {logoutError && (
            <div className={styles.logoutErrorText} role="alert">
              {logoutError}
            </div>
          )}
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            disabled={isLoggingOut}
            onClick={handleLogout}
          >
            <SignOut size={16} weight="bold" />
            <span>{isLoggingOut ? "Saindo..." : "Sair"}</span>
          </button>
        </div>
      )}

      <button
        type="button"
        className={`${styles.userMiniCard} ${
          isCollapsed ? styles.userMiniCardCollapsed : ""
        }`}
        onClick={handleToggle}
        aria-haspopup="true"
        aria-expanded={isOpen}
        title={`${displayName} (${roleLabel})`}
      >
        <div className={styles.avatarWrapper}>
          <div className={styles.avatarCircle}>{initials}</div>
          <div className={styles.onlineStatusDot} />
        </div>

        {!isCollapsed && (
          <>
            <div className={styles.detailsCol}>
              <span className={styles.nameText}>{displayName}</span>
              <span className={styles.roleText}>{roleLabel}</span>
            </div>
            <CaretDown
              size={14}
              className={`${styles.chevronIcon} ${
                isOpen ? styles.chevronIconOpen : ""
              }`}
            />
          </>
        )}
      </button>
    </div>
  );
}
