export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface UIColors {
  bgPrimary: string;
  bgSecondary: string;
  bgSurface: string;
  bgHover: string;
  bgActive: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  borderColor: string;
  accent: string;
  green: string;
  red: string;
}

export interface ColorScheme {
  id: string;
  name: string;
  terminal: TerminalColors;
  ui: UIColors;
}
