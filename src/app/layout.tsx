import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
	title: "UCAS Course Sign in",
	description: "输入学号与密码，查询课程并生成实时刷新签到码（每5秒刷新，下载码10秒有效）",
	icons: {
		icon: "/ucas.svg",
		shortcut: "/ucas.svg",
		apple: "/ucas.svg",
	},
};

export const viewport: Viewport = {
	themeColor: [
		{ media: "(prefers-color-scheme: light)", color: "#f1f5fb" },
		{ media: "(prefers-color-scheme: dark)", color: "#141f31" },
	],
};

const themeInitScript = `
(function () {
	try {
		var saved = localStorage.getItem('ucas-theme-mode');
		var mode = saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
		var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
		var resolved = mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
		document.documentElement.setAttribute('data-theme', resolved);
	} catch (e) {
		var fallbackDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
		document.documentElement.setAttribute('data-theme', fallbackDark ? 'dark' : 'light');
	}
})();
`;

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html
			lang="zh-CN"
			suppressHydrationWarning
			className="h-full antialiased"
		>
			<body className="min-h-full flex flex-col">
				<Script id="theme-init" strategy="beforeInteractive">
					{themeInitScript}
				</Script>
				{children}
			</body>
		</html>
	);
}
