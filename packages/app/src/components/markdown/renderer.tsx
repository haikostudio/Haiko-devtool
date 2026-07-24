import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  Image,
  Pressable,
  Text,
  View,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import Markdown, {
  MarkdownIt,
  type ASTNode,
  type RenderRules,
} from "react-native-markdown-display";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AppearanceStyleBoundary } from "@/components/appearance-style-boundary";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { MarkdownParagraphView, MarkdownTextSpan } from "@/components/markdown-text";
import { MarkdownTableCellText } from "@/components/markdown-text-selection";
import { getMarkdownListMarker, getMarkdownListSpacing } from "@/utils/markdown-list";
import { markdownNodeContainsType } from "@/utils/markdown-ast";
import { createCompactMarkdownStyles, createMarkdownStyles } from "@/styles/markdown-styles";
import type { Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  splitHtmlishMarkdown,
  type MarkdownDisplayPart,
  type MarkdownInlineImagePart,
} from "./html-ish";
import { resolveInlineImageSize, type InlineImageDimensions } from "./inline-image-size";
import { groupMarkdownParts, type MarkdownPartGroup } from "./part-groups";
import { resolveSectionIcon, SECTION_ICON_COLOR } from "./section-icons";

export type MarkdownStyles = Record<string, TextStyle & ViewStyle & { [key: string]: unknown }>;

interface MarkdownWithStableRendererProps {
  children: ReactNode;
  style: ReturnType<typeof createMarkdownStyles> | ReturnType<typeof createCompactMarkdownStyles>;
  rules?: RenderRules;
  markdownit?: ReturnType<typeof MarkdownIt>;
  onLinkPress?: (url: string) => boolean;
  allowedImageHandlers?: readonly string[];
  topLevelMaxExceededItem?: ReactNode;
}

const MarkdownWithStableRenderer = Markdown as ComponentType<MarkdownWithStableRendererProps>;
const ThemedMarkdown = withUnistyles(MarkdownWithStableRenderer);

function markdownStyleMapping(theme: Theme): Partial<MarkdownWithStableRendererProps> {
  return { style: createMarkdownStyles(theme) };
}

function compactMarkdownStyleMapping(theme: Theme): Partial<MarkdownWithStableRendererProps> {
  return { style: createCompactMarkdownStyles(theme) };
}

const defaultMarkdownParser = MarkdownIt({ typographer: true, linkify: true });
const EMPTY_TEXT_STYLE: TextStyle = {};
const MARKDOWN_LIST_ITEM_CONTENT_FLEX: ViewStyle = { flex: 1, flexShrink: 1, minWidth: 0 };
export interface MarkdownRendererProps {
  text: string;
  compact?: boolean;
  rules?: RenderRules;
  markdownit?: ReturnType<typeof MarkdownIt>;
  onLinkPress?: (url: string) => boolean;
  allowedImageHandlers?: readonly string[];
  topLevelMaxExceededItem?: ReactNode;
  enableHtmlish?: boolean;
}

export function MarkdownRenderer({
  text,
  compact = false,
  rules,
  markdownit = defaultMarkdownParser,
  onLinkPress,
  allowedImageHandlers,
  topLevelMaxExceededItem,
  enableHtmlish = true,
}: MarkdownRendererProps) {
  const markdownRules = useMemo(() => rules ?? createSharedMarkdownRules(), [rules]);
  const parts = useMemo(
    () => (enableHtmlish ? splitHtmlishMarkdown(text) : [{ kind: "markdown" as const, text }]),
    [enableHtmlish, text],
  );
  const rendererProps = useMemo(
    () => ({
      compact,
      rules: markdownRules,
      markdownit,
      onLinkPress,
      allowedImageHandlers,
      topLevelMaxExceededItem,
    }),
    [
      allowedImageHandlers,
      compact,
      markdownRules,
      markdownit,
      onLinkPress,
      topLevelMaxExceededItem,
    ],
  );

  return (
    <AppearanceStyleBoundary>
      <MarkdownPartList parts={parts} rendererProps={rendererProps} />
    </AppearanceStyleBoundary>
  );
}

type MarkdownPartRendererProps = Omit<MarkdownRendererProps, "text" | "enableHtmlish"> & {
  rules: RenderRules;
};

function MarkdownPartList({
  parts,
  rendererProps,
}: {
  parts: MarkdownDisplayPart[];
  rendererProps: MarkdownPartRendererProps;
}) {
  const keyedGroups = useMemo(() => keyMarkdownGroups(groupMarkdownParts(parts)), [parts]);
  return (
    <>
      {keyedGroups.map(({ key, group }) =>
        group.kind === "part" ? (
          <MarkdownPart key={key} part={group.part} rendererProps={rendererProps} />
        ) : (
          <MarkdownImageTextGroup key={key} group={group} rendererProps={rendererProps} />
        ),
      )}
    </>
  );
}

function keyMarkdownGroups(
  groups: MarkdownPartGroup[],
): { key: string; group: MarkdownPartGroup }[] {
  const seen = new Map<string, number>();
  return groups.map((group) => {
    const identity =
      group.kind === "part"
        ? getMarkdownPartIdentity(group.part)
        : `imageText:${group.images.map((i) => i.src).join(",")}:${group.lead.slice(0, 80)}`;
    const seenCount = seen.get(identity) ?? 0;
    seen.set(identity, seenCount + 1);
    return { key: `${identity}:${seenCount}`, group };
  });
}

function getMarkdownPartIdentity(part: MarkdownDisplayPart): string {
  if (part.kind === "markdown") {
    return `markdown:${part.text.slice(0, 80)}`;
  }
  if (part.kind === "inlineImage") {
    return `inlineImage:${part.src}:${part.alt}`;
  }
  return `details:${part.summary.slice(0, 80)}:${part.body.slice(0, 80)}`;
}

function MarkdownPart({
  part,
  rendererProps,
}: {
  part: MarkdownDisplayPart;
  rendererProps: MarkdownPartRendererProps;
}) {
  if (part.kind === "details") {
    return <MarkdownDetails part={part} rendererProps={rendererProps} />;
  }

  if (part.kind === "inlineImage") {
    return <MarkdownInlineImage part={part} onLinkPress={rendererProps.onLinkPress} />;
  }

  if (part.text.length === 0) {
    return null;
  }

  return <MarkdownFragment text={part.text} {...rendererProps} />;
}

function MarkdownFragment({
  text,
  compact,
  rules,
  markdownit,
  onLinkPress,
  allowedImageHandlers,
  topLevelMaxExceededItem,
}: MarkdownRendererProps & { rules: RenderRules }) {
  const uniProps = compact ? compactMarkdownStyleMapping : markdownStyleMapping;
  return (
    <ThemedMarkdown
      uniProps={uniProps}
      rules={rules}
      markdownit={markdownit}
      onLinkPress={onLinkPress}
      allowedImageHandlers={allowedImageHandlers}
      topLevelMaxExceededItem={topLevelMaxExceededItem}
    >
      {text}
    </ThemedMarkdown>
  );
}

function useNaturalImageDimensions(part: MarkdownInlineImagePart): {
  natural: InlineImageDimensions | null;
  failed: boolean;
  setFailed: (failed: boolean) => void;
} {
  const [natural, setNatural] = useState<InlineImageDimensions | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (part.width && part.height) {
      return;
    }

    let cancelled = false;
    Image.getSize(
      part.src,
      (width, height) => {
        if (!cancelled) {
          setNatural({ width, height });
        }
      },
      () => {
        if (!cancelled) {
          setFailed(true);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [part.height, part.src, part.width]);

  return { natural, failed, setFailed };
}

function MarkdownInlineImage({
  part,
  onLinkPress,
}: {
  part: Extract<MarkdownDisplayPart, { kind: "inlineImage" }>;
  onLinkPress?: (url: string) => boolean;
}) {
  const { natural: naturalDimensions } = useNaturalImageDimensions(part);
  const explicitDimensions = useMemo(
    () => ({ width: part.width, height: part.height }),
    [part.height, part.width],
  );
  const handlePress = useCallback(() => {
    if (!part.href) return;
    if (onLinkPress?.(part.href) === false) return;
    void openExternalUrl(part.href);
  }, [onLinkPress, part.href]);
  const source = useMemo(() => ({ uri: part.src }), [part.src]);
  const imageSize = useMemo(
    () => resolveInlineImageSize({ explicit: explicitDimensions, natural: naturalDimensions }),
    [explicitDimensions, naturalDimensions],
  );
  const imageStyle = useMemo(() => [detailsStyles.inlineImage, imageSize], [imageSize]);

  const image = (
    <Image
      source={source}
      style={imageStyle}
      resizeMode="contain"
      accessibilityLabel={part.alt || undefined}
    />
  );

  if (!part.href) {
    return <View style={detailsStyles.inlineImageWrap}>{image}</View>;
  }

  return (
    <Pressable style={detailsStyles.inlineImageWrap} onPress={handlePress} accessibilityRole="link">
      {image}
    </Pressable>
  );
}

const FLOW_IMAGE_MAX_HEIGHT = 18;

function MarkdownFlowImage({
  part,
  onLinkPress,
}: {
  part: MarkdownInlineImagePart;
  onLinkPress?: (url: string) => boolean;
}) {
  const { natural, failed, setFailed } = useNaturalImageDimensions(part);
  const handlePress = useCallback(() => {
    if (!part.href) return;
    if (onLinkPress?.(part.href) === false) return;
    void openExternalUrl(part.href);
  }, [onLinkPress, part.href]);
  const handleError = useCallback(() => setFailed(true), [setFailed]);
  const source = useMemo(() => ({ uri: part.src }), [part.src]);
  const imageSize = useMemo(() => {
    const size = resolveInlineImageSize({
      explicit: { width: part.width, height: part.height },
      natural,
    });
    const scale = Math.min(1, FLOW_IMAGE_MAX_HEIGHT / size.height);
    return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
  }, [natural, part.height, part.width]);
  const imageStyle = useMemo(() => [detailsStyles.flowImage, imageSize], [imageSize]);

  if (failed) {
    if (!part.alt) {
      return null;
    }
    return (
      <View style={detailsStyles.flowImageFallback}>
        <Text style={detailsStyles.flowImageFallbackText}>{part.alt}</Text>
      </View>
    );
  }

  const image = (
    <Image
      source={source}
      style={imageStyle}
      resizeMode="contain"
      accessibilityLabel={part.alt || undefined}
      onError={handleError}
    />
  );

  if (!part.href) {
    return image;
  }

  return (
    <Pressable onPress={handlePress} accessibilityRole="link">
      {image}
    </Pressable>
  );
}

function MarkdownImageTextGroup({
  group,
  rendererProps,
}: {
  group: Extract<MarkdownPartGroup, { kind: "imageText" }>;
  rendererProps: MarkdownPartRendererProps;
}) {
  return (
    <>
      <View style={detailsStyles.imageTextRow}>
        {group.images.map((image) => (
          <MarkdownFlowImage key={image.src} part={image} onLinkPress={rendererProps.onLinkPress} />
        ))}
        <View style={detailsStyles.imageTextRowContent}>
          <MarkdownFragment text={group.lead} {...rendererProps} />
        </View>
      </View>
      {group.rest ? <MarkdownFragment text={group.rest} {...rendererProps} /> : null}
    </>
  );
}

function MarkdownDetails({
  part,
  rendererProps,
}: {
  part: Extract<MarkdownDisplayPart, { kind: "details" }>;
  rendererProps: MarkdownPartRendererProps;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((current) => !current), []);
  const bodyParts = useMemo(
    () => part.bodyParts ?? [{ kind: "markdown" as const, text: part.body }],
    [part.body, part.bodyParts],
  );
  return (
    <View style={detailsStyles.container}>
      <Pressable style={detailsStyles.summaryRow} onPress={toggle} accessibilityRole="button">
        {open ? (
          <ChevronDown size={14} color={detailsStyles.summaryIcon.color} />
        ) : (
          <ChevronRight size={14} color={detailsStyles.summaryIcon.color} />
        )}
        <Text style={detailsStyles.summaryText}>{part.summary}</Text>
      </Pressable>
      {open ? (
        <View style={detailsStyles.body}>
          <MarkdownPartList parts={bodyParts} rendererProps={rendererProps} />
        </View>
      ) : null}
    </View>
  );
}

interface MarkdownInheritedTextProps {
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
  style?: TextStyle;
  monoSurface?: boolean;
  onPress?: TextProps["onPress"];
  accessibilityRole?: TextProps["accessibilityRole"];
  children: ReactNode;
}

export function MarkdownInheritedText({
  inheritedStyles,
  textStyle,
  style: overrideStyle,
  monoSurface,
  onPress,
  accessibilityRole,
  children,
}: MarkdownInheritedTextProps) {
  const style = useMemo(
    () => [inheritedStyles, textStyle, overrideStyle],
    [inheritedStyles, textStyle, overrideStyle],
  );
  return (
    <MarkdownTextSpan
      monoSurface={monoSurface}
      onPress={onPress}
      accessibilityRole={accessibilityRole}
      style={style}
    >
      {children}
    </MarkdownTextSpan>
  );
}

interface MarkdownListItemContentProps {
  contentStyle: ViewStyle;
  children: ReactNode;
}

function MarkdownListItemContent({ contentStyle, children }: MarkdownListItemContentProps) {
  const style = useMemo(() => [contentStyle, MARKDOWN_LIST_ITEM_CONTENT_FLEX], [contentStyle]);
  return <View style={style}>{children}</View>;
}

interface MarkdownListViewProps {
  baseStyle: ViewStyle;
  spacing: { marginTop: number; marginBottom: number };
  children: ReactNode;
}

function MarkdownListView({ baseStyle, spacing, children }: MarkdownListViewProps) {
  const style = useMemo(() => [baseStyle, spacing], [baseStyle, spacing]);
  return <View style={style}>{children}</View>;
}

interface SharedMarkdownLinkProps {
  href: string;
  inheritedStyles: TextStyle;
  linkStyle: TextStyle;
  onLinkPress?: (url: string) => boolean;
  children: ReactNode;
}

function SharedMarkdownLink({
  href,
  inheritedStyles,
  linkStyle,
  onLinkPress,
  children,
}: SharedMarkdownLinkProps) {
  const handlePress = useCallback(() => {
    if (!href) return;
    if (onLinkPress?.(href) === false) return;
    void openExternalUrl(href);
  }, [href, onLinkPress]);

  return (
    <MarkdownInheritedText
      inheritedStyles={inheritedStyles}
      textStyle={linkStyle}
      accessibilityRole="link"
      onPress={handlePress}
    >
      {children}
    </MarkdownInheritedText>
  );
}

function getMarkdownLinkHref(node: ASTNode): string {
  const href = node.attributes?.href;
  return typeof href === "string" ? href : "";
}

// A task-report heading (`## 1. Ce qui est fait`) gets a lucide glyph prepended
// so every agent's report reads the same regardless of exact wording. Layout is
// static (no theme), so plain objects are fine.
const headingIconRowStyle: ViewStyle = { flexDirection: "row", alignItems: "center", gap: 8 };
const headingIconTextStyle: ViewStyle = { flex: 1 };
const HEADING_ICON_SIZE: Record<number, number> = { 1: 22, 2: 20, 3: 18, 4: 16, 5: 15, 6: 14 };

/** Recursively collect the plain text of a heading node to key the icon off. */
function headingPlainText(node: ASTNode): string {
  if (typeof node.content === "string" && node.content.length > 0) return node.content;
  const children = (node as ASTNode & { children?: ASTNode[] }).children;
  if (Array.isArray(children)) return children.map(headingPlainText).join("");
  return "";
}

/** Wraps a heading's children, prepending a section icon when the title matches
 * one of the fixed task-report sections. Non-report headings render unchanged. */
function renderHeading(
  level: number,
  viewSafeStyle: MarkdownStyles[string],
  node: ASTNode,
  children: ReactNode[],
): ReactNode {
  const Icon = resolveSectionIcon(headingPlainText(node));
  if (!Icon) {
    return (
      <View key={node.key} style={viewSafeStyle}>
        {children}
      </View>
    );
  }
  return (
    <View key={node.key} style={viewSafeStyle}>
      <View style={headingIconRowStyle}>
        <Icon size={HEADING_ICON_SIZE[level] ?? 18} color={SECTION_ICON_COLOR} />
        <View style={headingIconTextStyle}>{children}</View>
      </View>
    </View>
  );
}

export function createSharedMarkdownRules(): RenderRules {
  return {
    heading1: (node, children, _parent, styles) =>
      renderHeading(1, styles._VIEW_SAFE_heading1, node, children),
    heading2: (node, children, _parent, styles) =>
      renderHeading(2, styles._VIEW_SAFE_heading2, node, children),
    heading3: (node, children, _parent, styles) =>
      renderHeading(3, styles._VIEW_SAFE_heading3, node, children),
    heading4: (node, children, _parent, styles) =>
      renderHeading(4, styles._VIEW_SAFE_heading4, node, children),
    heading5: (node, children, _parent, styles) =>
      renderHeading(5, styles._VIEW_SAFE_heading5, node, children),
    heading6: (node, children, _parent, styles) =>
      renderHeading(6, styles._VIEW_SAFE_heading6, node, children),
    text: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInheritedText
        key={node.key}
        inheritedStyles={inheritedStyles}
        textStyle={styles.text}
      >
        {node.content}
      </MarkdownInheritedText>
    ),
    textgroup: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInheritedText
        key={node.key}
        inheritedStyles={inheritedStyles}
        textStyle={styles.textgroup}
      >
        {children}
      </MarkdownInheritedText>
    ),
    strong: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInheritedText
        key={node.key}
        inheritedStyles={inheritedStyles}
        textStyle={styles.strong}
      >
        {children}
      </MarkdownInheritedText>
    ),
    em: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInheritedText key={node.key} inheritedStyles={inheritedStyles} textStyle={styles.em}>
        {children}
      </MarkdownInheritedText>
    ),
    s: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInheritedText key={node.key} inheritedStyles={inheritedStyles} textStyle={styles.s}>
        {children}
      </MarkdownInheritedText>
    ),
    hardbreak: (node: ASTNode) => <MarkdownTextSpan key={node.key}>{"\n"}</MarkdownTextSpan>,
    softbreak: (node: ASTNode) => <MarkdownTextSpan key={node.key}>{"\n"}</MarkdownTextSpan>,
    code_block: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <HighlightedCodeBlock
        key={node.key}
        code={node.content}
        language={null}
        inheritedStyles={inheritedStyles}
        textStyle={styles.code_block}
      />
    ),
    fence: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <HighlightedCodeBlock
        key={node.key}
        code={node.content}
        language={node.sourceInfo}
        inheritedStyles={inheritedStyles}
        textStyle={styles.fence}
      />
    ),
    code_inline: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInheritedText
        key={node.key}
        inheritedStyles={inheritedStyles}
        textStyle={styles.code_inline}
        monoSurface
      >
        {node.content ?? ""}
      </MarkdownInheritedText>
    ),
    bullet_list: (
      node: ASTNode,
      children: ReactNode[],
      parent: ASTNode[],
      styles: MarkdownStyles,
    ) => (
      <MarkdownListView
        key={node.key}
        baseStyle={styles.bullet_list}
        spacing={getMarkdownListSpacing(node, parent)}
      >
        {children}
      </MarkdownListView>
    ),
    ordered_list: (
      node: ASTNode,
      children: ReactNode[],
      parent: ASTNode[],
      styles: MarkdownStyles,
    ) => (
      <MarkdownListView
        key={node.key}
        baseStyle={styles.ordered_list}
        spacing={getMarkdownListSpacing(node, parent)}
      >
        {children}
      </MarkdownListView>
    ),
    list_item: (
      node: ASTNode,
      children: ReactNode[],
      parent: ASTNode[],
      styles: MarkdownStyles,
    ) => {
      const { isOrdered, marker } = getMarkdownListMarker(node, parent);
      const iconStyle = isOrdered ? styles.ordered_list_icon : styles.bullet_list_icon;
      const contentStyle = isOrdered ? styles.ordered_list_content : styles.bullet_list_content;

      return (
        <View key={node.key} style={styles.list_item}>
          <Text style={iconStyle}>{marker}</Text>
          <MarkdownListItemContent contentStyle={contentStyle}>{children}</MarkdownListItemContent>
        </View>
      );
    },
    th: (node: ASTNode, children: ReactNode[], _parent: ASTNode[], styles: MarkdownStyles) => (
      <MarkdownTableCellText key={node.key}>
        <View style={styles._VIEW_SAFE_th}>{children}</View>
      </MarkdownTableCellText>
    ),
    td: (node: ASTNode, children: ReactNode[], _parent: ASTNode[], styles: MarkdownStyles) => (
      <MarkdownTableCellText key={node.key}>
        <View style={styles._VIEW_SAFE_td}>{children}</View>
      </MarkdownTableCellText>
    ),
    paragraph: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
    ) => (
      <MarkdownParagraphView
        key={node.key}
        paragraphStyle={styles.paragraph}
        containsImage={markdownNodeContainsType(node, "image")}
      >
        {children}
      </MarkdownParagraphView>
    ),
    link: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownStyles,
      onLinkPress?: (url: string) => boolean,
    ) => (
      <SharedMarkdownLink
        key={node.key}
        href={getMarkdownLinkHref(node)}
        inheritedStyles={EMPTY_TEXT_STYLE}
        linkStyle={styles.link}
        onLinkPress={onLinkPress}
      >
        {children}
      </SharedMarkdownLink>
    ),
  };
}

const detailsStyles = StyleSheet.create((theme) => ({
  container: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    marginBottom: theme.spacing[2],
    overflow: "hidden",
  },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
  },
  summaryIcon: {
    color: theme.colors.foregroundMuted,
  },
  summaryText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 18,
  },
  body: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
  },
  inlineImageWrap: {
    alignSelf: "flex-start",
    marginBottom: theme.spacing[1],
  },
  inlineImage: {},
  imageTextRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
  imageTextRowContent: {
    flex: 1,
    minWidth: 0,
  },
  flowImage: {
    marginTop: theme.spacing[1],
  },
  flowImageFallback: {
    marginTop: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  flowImageFallbackText: {
    fontSize: 10,
    lineHeight: 14,
    color: theme.colors.foregroundMuted,
  },
}));
