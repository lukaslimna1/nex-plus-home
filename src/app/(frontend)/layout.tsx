import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "NEX+ Home",
  description: "NEX+ Home foundation",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
