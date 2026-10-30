import { theme as antdTheme, type ThemeConfig } from 'antd';

/**
 * Single source of the workbench palette. Ant Design tokens, ECharts options and CSS variables
 * (see `:root` in styles.css) all read these values; change a colour here, not in components.
 */
export const palette = {
  primary: '#659fff',
  success: '#45d6b0',
  warning: '#ecb65c',
  error: '#f27d90',
  bgBase: '#10141c',
  bgContainer: '#161d28',
  bgElevated: '#1c2533',
  border: '#303b4e',
  text: '#dce5f2',
  textSecondary: '#8b9aaf',
  /** Chart chrome */
  axisLine: '#354157',
  axisLabel: '#91a2b9',
  axisName: '#9cabbe',
  gridLine: '#2a3547',
  legendText: '#b0bfd3',
  tooltipBg: '#202c3d',
  tooltipBorder: '#3d506b',
  tooltipText: '#e5ecf5',
  sliderFill: '#659fff24',
  sliderBorder: '#30405a',
} as const;

export const fontFamily = '"Segoe UI", "Microsoft YaHei", sans-serif';

export const antdThemeConfig: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    colorPrimary: palette.primary,
    colorSuccess: palette.success,
    colorInfo: palette.primary,
    colorWarning: palette.warning,
    colorError: palette.error,
    colorBgBase: palette.bgBase,
    colorBgContainer: palette.bgContainer,
    colorBorder: palette.border,
    colorText: palette.text,
    colorTextSecondary: palette.textSecondary,
    borderRadius: 10,
    fontSize: 14,
    fontFamily,
  },
  components: {
    Table: { headerBg: palette.bgElevated, rowHoverBg: '#1e2a3b', cellPaddingBlockSM: 13 },
    Tabs: { horizontalMargin: '0' },
    Button: { primaryShadow: 'none' },
    Select: { optionSelectedBg: '#263e61' },
  },
};
