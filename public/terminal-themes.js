// --- Terminal themes ---
//
// Every entry is an xterm ITheme plus two fields the UI reads: `label` and
// `mode` ('dark' | 'light'), which drives the optgroups in the settings
// dropdown. xterm takes concrete colour strings and cannot read CSS custom
// properties, so the two WootonPad themes below restate the design-system
// palette by hand — keep them in sync with the token block at the top of
// public/style.css and public/css/theme-light.css.
const TERMINAL_THEMES = {
  // Design-system themes. `background` deliberately equals --surface-app so
  // the terminal has no visible seam against the main area.
  wootonpadDark: {
    label: 'WootonPad Dark', mode: 'dark',
    background: '#0a0a0c', foreground: '#d6d6de', cursor: '#f2884b', cursorAccent: '#0a0a0c',
    selectionBackground: '#26262e', selectionForeground: '#eeeef2',
    black: '#17171b', red: '#f0605a', green: '#34d399', yellow: '#f0b429', blue: '#5b9dff', magenta: '#b48cf2', cyan: '#5fd4e5', white: '#b4b4c0',
    brightBlack: '#4a4a56', brightRed: '#f68b86', brightGreen: '#5fe5b3', brightYellow: '#f5c451', brightBlue: '#8fb6ff', brightMagenta: '#cbb0f7', brightCyan: '#8ee5f2', brightWhite: '#eeeef2',
  },
  wootonpadLight: {
    label: 'WootonPad Light', mode: 'light',
    background: '#ecedf0', foreground: '#3d3f48', cursor: '#d96b25', cursorAccent: '#ecedf0',
    selectionBackground: '#d4d5dc', selectionForeground: '#15161a',
    // On paper "bright" reads as *stronger*, so the bright half goes darker.
    black: '#15161a', red: '#d3423c', green: '#1fae7c', yellow: '#b57d0a', blue: '#2e6fd6', magenta: '#7146c4', cyan: '#0f8a9b', white: '#63656f',
    brightBlack: '#8d8f99', brightRed: '#b8332e', brightGreen: '#17916a', brightYellow: '#946608', brightBlue: '#255bb0', brightMagenta: '#5c37a1', brightCyan: '#0c7180', brightWhite: '#15161a',
  },

  switchboard: {
    label: 'WootonPad Classic', mode: 'dark',
    background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#e94560', selectionBackground: '#3a3a5e',
    black: '#1a1a2e', red: '#e94560', green: '#0dff00', yellow: '#f5a623', blue: '#7b68ee', magenta: '#c678dd', cyan: '#56b6c2', white: '#c5c8c6',
    brightBlack: '#555568', brightRed: '#ff6b81', brightGreen: '#69ff69', brightYellow: '#ffd93d', brightBlue: '#8fa8ff', brightMagenta: '#d19afc', brightCyan: '#7ee8e8', brightWhite: '#eaeaea',
  },
  ghostty: {
    label: 'Ghostty', mode: 'dark',
    background: '#292c33', foreground: '#ffffff', cursor: '#ffffff', cursorAccent: '#363a43', selectionBackground: '#ffffff', selectionForeground: '#292c33',
    black: '#1d1f21', red: '#bf6b69', green: '#b7bd73', yellow: '#e9c880', blue: '#88a1bb', magenta: '#ad95b8', cyan: '#95bdb7', white: '#c5c8c6',
    brightBlack: '#666666', brightRed: '#c55757', brightGreen: '#bcc95f', brightYellow: '#e1c65e', brightBlue: '#83a5d6', brightMagenta: '#bc99d4', brightCyan: '#83beb1', brightWhite: '#eaeaea',
  },
  tokyoNight: {
    label: 'Tokyo Night', mode: 'dark',
    background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', selectionBackground: '#33467c',
    black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
  },
  catppuccinMocha: {
    label: 'Catppuccin Mocha', mode: 'dark',
    background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#45475a',
    black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
    brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
  },
  dracula: {
    label: 'Dracula', mode: 'dark',
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  nord: {
    label: 'Nord', mode: 'dark',
    background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', selectionBackground: '#434c5e',
    black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
    brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
  },
  solarizedDark: {
    label: 'Solarized Dark', mode: 'dark',
    background: '#002b36', foreground: '#839496', cursor: '#839496', selectionBackground: '#073642',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
  solarizedLight: {
    label: 'Solarized Light', mode: 'light',
    background: '#fdf6e3', foreground: '#657b83', cursor: '#657b83', cursorAccent: '#fdf6e3',
    selectionBackground: '#eee8d5', selectionForeground: '#586e75',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#93a1a1',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#657b83', brightYellow: '#839496', brightBlue: '#657b83', brightMagenta: '#6c71c4', brightCyan: '#586e75', brightWhite: '#002b36',
  },
  githubLight: {
    label: 'GitHub Light', mode: 'light',
    background: '#ffffff', foreground: '#24292f', cursor: '#24292f', cursorAccent: '#ffffff',
    selectionBackground: '#b6d7ff', selectionForeground: '#24292f',
    black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
    brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
  },
};

window.TERMINAL_THEMES = TERMINAL_THEMES;

let currentThemeName = 'wootonpadDark';
function getTerminalTheme() {
  return TERMINAL_THEMES[currentThemeName] || TERMINAL_THEMES.wootonpadDark;
}
let TERMINAL_THEME = getTerminalTheme();
