import React from "react";
import styles from "./LayoutShell.module.css";
import { Sidebar } from "../Sidebar/Sidebar";
import { MaxPanel } from "../MaxPanel/MaxPanel";
import { FooterDock } from "../FooterDock/FooterDock";
import { NavigationItemId } from "../../types/home.types";
import type { AppUserView } from "@/auth/identity";

interface LayoutShellProps {
  isSidebarCollapsed: boolean;
  isMaxCollapsed: boolean;
  onToggleSidebar: () => void;
  onToggleMax: () => void;
  activeNavItem?: NavigationItemId;
  user?: AppUserView | null;
  children: React.ReactNode;
}

export function LayoutShell({
  isSidebarCollapsed,
  isMaxCollapsed,
  onToggleSidebar,
  onToggleMax,
  activeNavItem = "home",
  user,
  children,
}: LayoutShellProps) {
  return (
    <div className={styles.shellContainer}>
      <div className={styles.mainLayout}>
        {/* Sidebar Esquerda */}
        <Sidebar
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={onToggleSidebar}
          activeItem={activeNavItem}
          user={user}
        />

        {/* Área Central */}
        <main className={styles.contentArea}>{children}</main>

        {/* Painel Contextual MAX à Direita */}
        <MaxPanel
          isCollapsed={isMaxCollapsed}
          onToggleCollapse={onToggleMax}
        />
      </div>

      {/* Footer Operacional Fixo */}
      <FooterDock />
    </div>
  );
}
