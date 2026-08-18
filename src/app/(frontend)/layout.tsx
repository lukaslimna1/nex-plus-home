import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "NEX+ · Sistema Operacional Inteligente",
  description: "NEX+ Home — Ambiente seguro para operação e conhecimento.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" style={{ margin: 0, padding: 0, backgroundColor: "#07070e" }}>
      <body style={{ margin: 0, padding: 0, backgroundColor: "#07070e", minHeight: "100vh" }}>
        {children}
      </body>
    </html>
  );
}
