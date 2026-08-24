"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  SessionActivityController,
  type SessionActivityState,
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  DEFAULT_WARNING_COUNTDOWN_SECONDS,
} from "@/auth/session-activity";
import { refreshSessionAction, logoutAction } from "@/auth/actions";
import { InactivityWarningModal } from "./InactivityWarningModal/InactivityWarningModal";

interface ActivitySessionProviderProps {
  children: React.ReactNode;
  inactivityTimeoutMs?: number;
  warningCountdownSeconds?: number;
}

export function ActivitySessionProvider({
  children,
  inactivityTimeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS,
  warningCountdownSeconds = DEFAULT_WARNING_COUNTDOWN_SECONDS,
}: ActivitySessionProviderProps) {
  const router = useRouter();
  const [state, setState] = useState<SessionActivityState>("ACTIVE");
  const [countdown, setCountdown] = useState<number>(warningCountdownSeconds);
  const [isProcessing, setIsProcessing] = useState(false);
  const controllerRef = useRef<SessionActivityController | null>(null);

  const handleStateChange = useCallback(
    (newState: SessionActivityState, newCountdown: number) => {
      setState(newState);
      setCountdown(newCountdown);

      if (newState === "EXPIRED") {
        router.push("/login");
      }
    },
    [router]
  );

  useEffect(() => {
    const controller = new SessionActivityController({
      inactivityTimeoutMs,
      warningCountdownSeconds,
      onStateChange: handleStateChange,
      onRefresh: refreshSessionAction,
      onLogout: async () => {
        try {
          await logoutAction();
        } catch {}
        router.push("/login");
        return { success: true };
      },
    });

    controllerRef.current = controller;

    // Listeners passivos para registrar atividade do usuário
    const handleUserActivity = () => {
      controller.registerActivity();
    };

    const events = ["mousedown", "keydown", "touchstart", "scroll", "pointerdown"];
    events.forEach((eventName) => {
      window.addEventListener(eventName, handleUserActivity, { passive: true });
    });

    return () => {
      events.forEach((eventName) => {
        window.removeEventListener(eventName, handleUserActivity);
      });
      controller.destroy();
      controllerRef.current = null;
    };
  }, [inactivityTimeoutMs, warningCountdownSeconds, handleStateChange, router]);

  const handleStayLoggedIn = async () => {
    if (!controllerRef.current || isProcessing) return;
    setIsProcessing(true);
    try {
      await controllerRef.current.stayLoggedIn();
    } finally {
      setIsProcessing(false);
    }
  };

  const handleLogoutNow = async () => {
    if (!controllerRef.current || isProcessing) return;
    setIsProcessing(true);
    try {
      await controllerRef.current.logOut("user_clicked_modal_logout");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <>
      {children}
      {state === "WARNING" && (
        <InactivityWarningModal
          countdownSeconds={countdown}
          onStayLoggedIn={handleStayLoggedIn}
          onLogout={handleLogoutNow}
          isSubmitting={isProcessing}
        />
      )}
    </>
  );
}
