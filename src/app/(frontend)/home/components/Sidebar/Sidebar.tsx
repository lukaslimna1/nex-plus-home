import React from "react";
import styles from "./Sidebar.module.css";
import { UserMiniCard } from "../UserMiniCard/UserMiniCard";
import { NexWordmark } from "@/app/(frontend)/login/NexWordmark";
import {
  House,
  Sparkle,
  UsersThree,
  Crosshair,
  Wrench,
  Gear,
  CaretDoubleLeft,
  CaretDoubleRight,
} from "@phosphor-icons/react";
import { NavigationItemId } from "../../types/home.types";

interface SidebarProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  activeItem?: NavigationItemId;
}

export function Sidebar({
  isCollapsed,
  onToggleCollapse,
  activeItem = "home",
}: SidebarProps) {
  return (
    <aside
      className={`${styles.sidebar} ${
        isCollapsed ? styles.sidebarCollapsed : ""
      }`}
    >
      <div className={styles.topSection}>
        {/* Marca / Logo */}
        <div className={styles.brandRow}>
          <div className={styles.brandIcon}>N</div>
          {!isCollapsed && (
            <div className={styles.wordmarkWrapper}>
              <NexWordmark height={22} width={105} />
            </div>
          )}
        </div>

        {/* Botão de Recolher */}
        <button
          type="button"
          className={`${styles.collapseToggle} ${
            isCollapsed ? styles.collapseToggleCentered : ""
          }`}
          onClick={onToggleCollapse}
          aria-label={isCollapsed ? "Expandir menu lateral" : "Recolher menu lateral"}
          title={isCollapsed ? "Expandir menu lateral" : "Recolher menu lateral"}
        >
          {isCollapsed ? (
            <CaretDoubleRight size={13} weight="bold" />
          ) : (
            <>
              <CaretDoubleLeft size={13} weight="bold" />
              <span>Recolher</span>
            </>
          )}
        </button>

        {/* Itens de Navegação v0.1 */}
        <nav className={styles.navigationList}>
          <button
            type="button"
            className={`${styles.navButton} ${
              activeItem === "home" ? styles.navButtonActive : ""
            } ${isCollapsed ? styles.navButtonCollapsed : ""}`}
            title="Home"
          >
            <House
              size={18}
              weight={activeItem === "home" ? "fill" : "regular"}
              color={activeItem === "home" ? "#c084fc" : "currentColor"}
            />
            {!isCollapsed && <span>Home</span>}
          </button>

          <button
            type="button"
            className={`${styles.navButton} ${
              activeItem === "max" ? styles.navButtonActive : ""
            } ${isCollapsed ? styles.navButtonCollapsed : ""}`}
            title="MAX"
          >
            <Sparkle size={18} weight="regular" />
            {!isCollapsed && <span>MAX</span>}
          </button>

          <button
            type="button"
            className={`${styles.navButton} ${
              activeItem === "suppliers" ? styles.navButtonActive : ""
            } ${isCollapsed ? styles.navButtonCollapsed : ""}`}
            title="Fornecedores"
          >
            <UsersThree size={18} weight="regular" />
            {!isCollapsed && <span>Fornecedores</span>}
          </button>

          <button
            type="button"
            className={`${styles.navButton} ${
              activeItem === "radar" ? styles.navButtonActive : ""
            } ${isCollapsed ? styles.navButtonCollapsed : ""}`}
            title="Radar de Compra"
          >
            <Crosshair size={18} weight="regular" />
            {!isCollapsed && <span>Radar de Compra</span>}
          </button>

          <button
            type="button"
            className={`${styles.navButton} ${
              activeItem === "tools" ? styles.navButtonActive : ""
            } ${isCollapsed ? styles.navButtonCollapsed : ""}`}
            title="Ferramentas"
          >
            <Wrench size={18} weight="regular" />
            {!isCollapsed && <span>Ferramentas</span>}
          </button>
        </nav>
      </div>

      {/* Seção Inferior */}
      <div className={styles.bottomSection}>
        <button
          type="button"
          className={`${styles.navButton} ${
            isCollapsed ? styles.navButtonCollapsed : ""
          }`}
          title="Configuração"
        >
          <Gear size={18} weight="regular" />
          {!isCollapsed && <span>Configuração</span>}
        </button>

        <UserMiniCard isCollapsed={isCollapsed} />
      </div>
    </aside>
  );
}
