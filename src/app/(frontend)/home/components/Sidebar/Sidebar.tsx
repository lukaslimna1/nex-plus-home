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
        {/* Marca / Logo Oficial */}
        <div
          className={`${styles.brandRow} ${
            isCollapsed ? styles.brandRowCollapsed : ""
          }`}
        >
          <div className={styles.wordmarkWrapper}>
            <NexWordmark width={isCollapsed ? 46 : 128} height="auto" />
          </div>
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

        {/* Itens de Navegação */}
        <nav className={styles.navigationList}>
          <button
            type="button"
            className={`${styles.navButton} ${
              activeItem === "home" ? styles.navButtonActive : ""
            } ${isCollapsed ? styles.navButtonCollapsed : ""}`}
            title="Home"
          >
            <House
              size={20}
              weight={activeItem === "home" ? "fill" : "regular"}
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
            <Sparkle size={20} weight={activeItem === "max" ? "fill" : "regular"} />
            {!isCollapsed && <span>MAX</span>}
          </button>

          <button
            type="button"
            className={`${styles.navButton} ${
              activeItem === "suppliers" ? styles.navButtonActive : ""
            } ${isCollapsed ? styles.navButtonCollapsed : ""}`}
            title="Fornecedores"
          >
            <UsersThree size={20} weight={activeItem === "suppliers" ? "fill" : "regular"} />
            {!isCollapsed && <span>Fornecedores</span>}
          </button>

          <button
            type="button"
            className={`${styles.navButton} ${
              activeItem === "radar" ? styles.navButtonActive : ""
            } ${isCollapsed ? styles.navButtonCollapsed : ""}`}
            title="Radar de Compra"
          >
            <Crosshair size={20} weight={activeItem === "radar" ? "fill" : "regular"} />
            {!isCollapsed && <span>Radar de Compra</span>}
          </button>

          <button
            type="button"
            className={`${styles.navButton} ${
              activeItem === "tools" ? styles.navButtonActive : ""
            } ${isCollapsed ? styles.navButtonCollapsed : ""}`}
            title="Ferramentas"
          >
            <Wrench size={20} weight={activeItem === "tools" ? "fill" : "regular"} />
            {!isCollapsed && <span>Ferramentas</span>}
          </button>
        </nav>
      </div>

      {/* Seção Inferior */}
      <div className={styles.bottomSection}>
        <div className={styles.bottomDivider} />
        <button
          type="button"
          className={`${styles.navButton} ${
            isCollapsed ? styles.navButtonCollapsed : ""
          }`}
          title="Configuração"
        >
          <Gear size={20} weight="regular" />
          {!isCollapsed && <span>Configuração</span>}
        </button>

        <UserMiniCard isCollapsed={isCollapsed} />
      </div>
    </aside>
  );
}
