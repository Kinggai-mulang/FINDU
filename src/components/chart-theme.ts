import { fontFamily, palette } from '../theme';

/**
 * Shared ECharts styling. Every chart in FINDU builds its tooltip, legend, axes and zoom controls from here,
 * so the look is changed in one place and stays consistent between realtime and post-processing views.
 */
export const chartText = { color: palette.axisLabel, fontFamily, fontSize: 12 };

export const tooltipStyle = {
  backgroundColor: palette.tooltipBg,
  borderColor: palette.tooltipBorder,
  borderWidth: 1,
  padding: [8, 12],
  textStyle: { color: palette.tooltipText, fontSize: 12.5, fontFamily },
  extraCssText: 'border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);',
};

/** Legend on its own row above the plot, left-aligned with the axis; scrolls instead of overlapping. */
export const legendStyle = (left = 64) => ({
  type: 'scroll' as const,
  top: 6,
  left,
  right: 24,
  icon: 'roundRect',
  itemWidth: 14,
  itemHeight: 4,
  itemGap: 16,
  textStyle: { color: palette.legendText, fontSize: 12 },
  pageIconColor: palette.primary,
  pageIconInactiveColor: palette.border,
  pageTextStyle: { color: palette.axisLabel },
});

/** Value axis with its unit above the axis line, clear of the legend row. */
export const valueAxisStyle = (unit: string) => ({
  name: unit,
  nameLocation: 'end' as const,
  nameGap: 10,
  nameTextStyle: { color: palette.axisName, fontSize: 12, align: 'right' as const, padding: [0, 6, 0, 0] },
  axisLabel: { color: palette.axisLabel, fontSize: 12, hideOverlap: true },
  splitLine: { lineStyle: { color: palette.gridLine, type: 'dashed' as const } },
});

export const timeAxisStyle = {
  axisLine: { lineStyle: { color: palette.axisLine } },
  axisTick: { lineStyle: { color: palette.axisLine } },
  splitLine: { show: false },
};

const sliderBase = {
  borderColor: 'transparent',
  backgroundColor: 'rgba(255, 255, 255, 0.03)',
  fillerColor: 'rgba(101, 159, 255, 0.14)',
  handleStyle: { color: '#7f9cc4', borderColor: '#a9bfdc' },
  moveHandleSize: 4,
  moveHandleStyle: { color: '#4a5d7a' },
  emphasis: { handleStyle: { color: palette.primary }, moveHandleStyle: { color: palette.primary } },
  dataBackground: { lineStyle: { color: '#3a4a63' }, areaStyle: { color: 'rgba(101, 159, 255, 0.08)' } },
  selectedDataBackground: { lineStyle: { color: '#5d7aa3' }, areaStyle: { color: 'rgba(101, 159, 255, 0.16)' } },
  textStyle: { color: palette.axisLabel, fontSize: 11 },
};

/** Time slider under the plot. */
export const timeSlider = (xAxisIndex: number | number[], bottom = 6) => ({
  ...sliderBase,
  id: 'time-slider',
  type: 'slider' as const,
  xAxisIndex,
  height: 16,
  bottom,
});

/** Slim vertical slider for one value axis; it only shows a thin track until it is used. */
export const valueSlider = (
  id: string,
  yAxisIndex: number,
  place: { top?: number; height?: number; bottom?: number } = {},
) => ({
  ...sliderBase,
  id,
  type: 'slider' as const,
  yAxisIndex,
  orient: 'vertical' as const,
  right: 6,
  width: 8,
  showDetail: false,
  showDataShadow: false,
  filterMode: 'none' as const,
  handleSize: '120%',
  moveHandleSize: 0,
  ...place,
});

/** One interaction hint per view instead of under every chart. */
export const chartInteractionHint = '图表：滚轮缩放纵轴 · Shift + 滚轮或底部滑块调整时间 · 点击图例筛选';
