import React from "react";
import styles from "./UserMiniCard.module.css";
import { CaretDown } from "@phosphor-icons/react";

interface UserMiniCardProps {
  isCollapsed: boolean;
}

export function UserMiniCard({ isCollapsed }: UserMiniCardProps) {
  return (
    <div
      className={`${styles.userMiniCard} ${
        isCollapsed ? styles.userMiniCardCollapsed : ""
      }`}
      title="Daniel Silva (Administrador)"
    >
      <div className={styles.avatarWrapper}>
        <div className={styles.avatarCircle}>DS</div>
        <div className={styles.onlineStatusDot} />
      </div>

      {!isCollapsed && (
        <>
          <div className={styles.detailsCol}>
            <span className={styles.nameText}>Daniel Silva</span>
            <span className={styles.roleText}>Administrador</span>
          </div>
          <CaretDown size={14} className={styles.chevronIcon} />
        </>
      )}
    </div>
  );
}
