"use client";

import React, { useState, useEffect } from "react";
import styles from "./home.module.css";
import { LayoutShell } from "./components/LayoutShell/LayoutShell";
import { TopStatusBar } from "./components/TopStatusBar/TopStatusBar";
import { MainHero } from "./components/MainHero/MainHero";
import { SuppliersPanel } from "./components/SuppliersPanel/SuppliersPanel";
import { RadarPanel } from "./components/RadarPanel/RadarPanel";
import { ToolsPanel } from "./components/ToolsPanel/ToolsPanel";
import type { AppUserView } from "@/auth/identity";

const SIDEBAR_KEY = "nex-sidebar-collapsed";
const MAX_KEY = "nex-max-collapsed";

interface HomeClientProps {
  user: AppUserView;
}

export function HomeClient({ user }: HomeClientProps) {
  /* ---- Estado inicial: null = ainda não leu localStorage ---- */
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean | null>(null);
  const [isMaxCollapsed, setIsMaxCollapsed] = useState<boolean | null>(null);

  /* ---- Leitura segura (client-only, sem flash) ---- */
  useEffect(() => {
    try {
      const savedSidebar = localStorage.getItem(SIDEBAR_KEY);
      const savedMax = localStorage.getItem(MAX_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsSidebarCollapsed(savedSidebar === "true");
      setIsMaxCollapsed(savedMax === "true");
    } catch {
      setIsSidebarCollapsed(false);
      setIsMaxCollapsed(false);
    }
  }, []);

  /* ---- Persistência ---- */
  useEffect(() => {
    if (isSidebarCollapsed !== null) {
      try { localStorage.setItem(SIDEBAR_KEY, String(isSidebarCollapsed)); } catch {}
    }
  }, [isSidebarCollapsed]);

  useEffect(() => {
    if (isMaxCollapsed !== null) {
      try { localStorage.setItem(MAX_KEY, String(isMaxCollapsed)); } catch {}
    }
  }, [isMaxCollapsed]);

  /* ---- Enquanto não leu localStorage, renderiza placeholder invisível ---- */
  if (isSidebarCollapsed === null || isMaxCollapsed === null) {
    return <div className={styles.loadingShell} />;
  }

  return (
    <LayoutShell
      isSidebarCollapsed={isSidebarCollapsed}
      isMaxCollapsed={isMaxCollapsed}
      onToggleSidebar={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
      onToggleMax={() => setIsMaxCollapsed(!isMaxCollapsed)}
      activeNavItem="home"
      user={user}
    >
      {/* 1. Header com Status Chips */}
      <TopStatusBar />

      {/* 2. Hero Operacional */}
      <MainHero />

      {/* 3. Grid dos 3 Blocos Principais */}
      <div className={styles.dashboardGrid}>
        {/* Fornecedores */}
        <SuppliersPanel />

        {/* Radar de Compra */}
        <RadarPanel />

        {/* Ferramentas */}
        <ToolsPanel />
      </div>
    </LayoutShell>
  );
}
