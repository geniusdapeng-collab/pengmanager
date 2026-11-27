export const ARTICLE_ILLUSTRATION_STYLE_FLOOR = 2026;

export function articleIllustrationStyleYear(now = new Date()) {
  return Math.max(ARTICLE_ILLUSTRATION_STYLE_FLOOR, now.getUTCFullYear());
}

export function isArticleIllustrationStyleYear(year) {
  return Number.isInteger(year) && year >= ARTICLE_ILLUSTRATION_STYLE_FLOOR && year <= 9999;
}

export function articleIllustrationStyleMarker(year) {
  return `PM-VISUAL-STYLE contemporary-tech-v1/${year}`;
}

export function articleIllustrationStyleRule(kind, year) {
  const era = `画面采用 ${year} 年或更近的当代视觉风格。`;
  if (kind !== "scene") {
    return `${era}使用现代科技公司设计系统常见的简明图形、干净网格、清晰字号层级、克制配色和有对比度的连接线。架构关系、判断顺序及文字含义必须忠于正文。避免渐变塑料按钮、立体投影、老式办公模板和装饰性照片。`;
  }
  // Version 1 work orders carry this exact string, including in older compositors.
  return `${era}办公场景优先参考现代互联网或科技公司的真实工作环境。用当代轻薄设备、整洁工位、清晰的工作照明和自然的纪实构图体现时代。正文指定门店、工厂、家中、户外或特定年代时，保留其人物、地点、年代和动作，在合适范围内使用现代编辑摄影手法与符合该场景的设备及陈设。避免老式办公设备、厚重隔断、陈旧素材库色调和摆拍。画面不得靠年份文字、商标、可识别信息、虚构品牌界面或未来主义道具表现时代。`;
}

export function articleIllustrationSceneDirection(year) {
  return `由场景简报决定可见主体、地点、关键动作和取景。门店、工厂、住家、户外或办公等场地中的器材、陈设和光线须符合各自的实际环境。只有正文涉及会议时才采用围桌构图。保留简报设定的年代，使用 ${year} 年或更近的编辑视觉手法呈现。避免摆拍、陈旧素材库色调、商标、可识别私人信息和装饰性界面。`;
}
